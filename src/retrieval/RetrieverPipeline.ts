import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import {
  buildFactRetrievalPrompt,
  formatFactBlock,
} from "../prompts/factRetrievalPrompt.js";
import type { GraphStore } from "../store/index.js";
import type {
  EmbedAdapter,
  MemoryNode,
  RetrievalResult,
  RetrieverConfig,
  MemoGrafterOperationOptions,
  TopicNode,
} from "../core/types.js";
import { countApproxTokens } from "../utils/text/tokenCount.js";
import { normalizeTags } from "../utils/tags.js";
import { validateEmbedding } from "../adapters/validation.js";
import { emitWarning, type MemoGrafterDiagnostics, type MemoGrafterWarning } from "../diagnostics.js";
import { createOperationControl } from "../utils/operationControl.js";

type ScoredMemoryNode = MemoryNode & { similarity: number };
type RankedMemoryNode = ScoredMemoryNode & { retrievalScore: number };

interface RetrievedBlock {
  facts: RankedMemoryNode[];
  parentNode: TopicNode;
  score: number;
}

const DEFAULT_SIMILARITY_WEIGHT = 0.7;
const DEFAULT_CONFIDENCE_WEIGHT = 0.3;

export class RetrieverPipeline {
  constructor(
    /** @internal */
    private store: GraphStore,
    /** @internal */
    private embedder: EmbedAdapter,
    private config: RetrieverConfig,
    /** @internal */
    private cacheRedis: Redis | null = null,
    private diagnostics?: MemoGrafterDiagnostics,
  ) {}

  async run(query: string, sessionId: string, options?: MemoGrafterOperationOptions): Promise<RetrievalResult> {
    const control = createOperationControl(options, "context", "provider-request");
    const warnings: MemoGrafterWarning[] = [];
    try {
    const limit = this.config.limit ?? 10;
    const minSimilarity = this.config.minSimilarity ?? 0.6;
    const tokenBudget = this.config.tokenBudget ?? 1200;
    const tags = normalizeTags(this.config.tags);
    const tagMode = this.config.tagMode ?? "all";
    const scope = this.config.scope === "tagged" && tags.length > 0
      ? "tagged"
      : this.config.scope ?? (tags.length > 0 ? "session-and-tags" : "session");
    const configuredSessionIds = this.config.sessionIds?.filter(Boolean) ?? [];
    const sessionIds = this.resolveSessionIds(sessionId);
    const hasConfiguredSessionIds = configuredSessionIds.length > 0;

    control.throwIfAborted();
    let rawEmbedding: number[];
    try { rawEmbedding = options ? await this.embedder.embed(query, { signal: control.signal }) : await this.embedder.embed(query); }
    catch (error) { control.throwIfAborted(); throw error; }
    const embedding = validateEmbedding(rawEmbedding, this.embedder.dimensions, "context");
    control.throwIfAborted();
    const searchedFacts = await this.searchMemories(embedding, sessionId, limit, minSimilarity, {
      tags,
      tagMode,
      scope,
      ...(hasConfiguredSessionIds ? { sessionIds } : {}),
    }, warnings);
    const activeFacts = searchedFacts
      .filter((fact) => fact.decayed === false && fact.supersededBy == null && !fact.forgotten)
      .map((fact) => this.rankFact(fact))
      .sort((a, b) => b.retrievalScore - a.retrievalScore);

    if (activeFacts.length === 0) {
      return {
        facts: [],
        nodes: [],
        systemPrompt: buildFactRetrievalPrompt([]),
        tokenCount: 0,
        tokenBudget,
        ...(warnings.length ? { degraded: true, warnings } : {}),
      };
    }

    const rankedBlocks = (await this.buildBlocks(
      activeFacts,
      sessionId,
      scope,
      hasConfiguredSessionIds && (sessionIds.length > 1 || sessionIds[0] !== sessionId),
    ))
      .sort((a, b) => b.score - a.score);
    const includedBlocks: string[] = [];
    const facts: ScoredMemoryNode[] = [];
    const nodes: TopicNode[] = [];
    let tokenCount = 0;

    for (const block of rankedBlocks) {
      const formattedBlock = formatFactBlock(block.facts, block.parentNode);
      const blockTokenCount = countApproxTokens(formattedBlock);

      if (tokenCount + blockTokenCount > tokenBudget) {
        break;
      }

      includedBlocks.push(formattedBlock);
      facts.push(...block.facts.map(({ retrievalScore: _retrievalScore, ...fact }) => fact));
      nodes.push(block.parentNode);
      tokenCount += blockTokenCount;
    }

    return {
      facts,
      nodes,
      systemPrompt: buildFactRetrievalPrompt(includedBlocks),
      tokenCount,
      tokenBudget,
      ...(warnings.length ? { degraded: true, warnings } : {}),
    };
    } finally {
      control.dispose();
    }
  }

  private async searchMemories(
    embedding: number[],
    sessionId: string,
    limit: number,
    minSimilarity: number,
    options: {
      tags?: string[];
      tagMode?: "all" | "any";
      scope?: "session" | "session-and-tags" | "tagged";
      sessionIds?: string[];
    },
    warnings: MemoGrafterWarning[],
  ): Promise<ScoredMemoryNode[]> {
    if (!this.config.cache || !this.cacheRedis) {
      return this.store.searchMemories(
        embedding,
        sessionId,
        limit,
        minSimilarity,
        options,
      );
    }

    const ttl = Math.min(Math.max(this.config.cache.ttlSeconds ?? 90, 60), 120);
    const cacheKey = [
      "mg:recall",
      sessionId,
      limit,
      minSimilarity,
      options.scope ?? "session",
      (this.config.sessionIds ?? []).join(","),
      options.tagMode ?? "all",
      (options.tags ?? []).join(","),
      this.hashEmbedding(embedding),
    ].join(":");

    try {
      const hit = await this.cacheRedis.get(cacheKey);

      if (hit) {
        return JSON.parse(hit) as ScoredMemoryNode[];
      }

    } catch (error: unknown) {
      const warning: MemoGrafterWarning = { code: "CACHE_UNAVAILABLE", operation: "context", context: { sessionId }, cause: error };
      warnings.push(warning);
      emitWarning(this.diagnostics, warning);
    }
    const searchedFacts = await this.store.searchMemories(embedding, sessionId, limit, minSimilarity, options);
    try { await this.cacheRedis.setex(cacheKey, ttl, JSON.stringify(searchedFacts)); }
    catch (error: unknown) {
      const warning: MemoGrafterWarning = { code: "CACHE_UNAVAILABLE", operation: "context", context: { sessionId }, cause: error };
      warnings.push(warning);
      emitWarning(this.diagnostics, warning);
    }
    return searchedFacts;
  }

  private hashEmbedding(embedding: number[]): string {
    const str = embedding.map((value) => value.toFixed(6)).join(",");
    return createHash("sha1").update(str).digest("hex").slice(0, 16);
  }

  private async buildBlocks(
    facts: RankedMemoryNode[],
    sessionId: string,
    scope: "session" | "session-and-tags" | "tagged",
    useFactSession: boolean,
  ): Promise<RetrievedBlock[]> {
    const factsByTopic = new Map<string, RankedMemoryNode[]>();

    for (const fact of facts) {
      const topicFacts = factsByTopic.get(fact.topicNodeId) ?? [];
      topicFacts.push(fact);
      factsByTopic.set(fact.topicNodeId, topicFacts);
    }

    const blocks: RetrievedBlock[] = [];

    for (const [topicNodeId, topicFacts] of factsByTopic) {
      const parentSessionId = scope === "tagged" || useFactSession ? topicFacts[0]?.sessionId : sessionId;
      const parentNode = await this.store.getTopicNode(topicNodeId, parentSessionId);

      if (!parentNode || parentNode.suppressed) {
        continue;
      }

      blocks.push({
        facts: topicFacts.sort((a, b) => b.retrievalScore - a.retrievalScore),
        parentNode,
        score: Math.max(...topicFacts.map((fact) => fact.retrievalScore)),
      });
    }

    return blocks;
  }

  private rankFact(fact: ScoredMemoryNode): RankedMemoryNode {
    return {
      ...fact,
      retrievalScore: this.scoreFact(fact),
    };
  }

  private scoreFact(fact: ScoredMemoryNode): number {
    const similarityWeight = this.config.scoring?.similarityWeight ?? DEFAULT_SIMILARITY_WEIGHT;
    const confidenceWeight = this.config.scoring?.confidenceWeight ?? DEFAULT_CONFIDENCE_WEIGHT;
    const similarity = this.clampScore(fact.similarity);
    const confidence = this.clampScore(fact.confidence);

    return similarity * similarityWeight + confidence * confidenceWeight;
  }

  private clampScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 1);
  }

  private resolveSessionIds(sessionId: string): string[] {
    const configured = this.config.sessionIds?.filter(Boolean) ?? [];
    if (configured.length === 0) return [sessionId];
    return [...new Set(configured)];
  }
}
