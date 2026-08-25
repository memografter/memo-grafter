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
type SelectionReason = NonNullable<RetrievalResult["selection"]>["reason"];

interface RetrievedBlock {
  facts: RankedMemoryNode[];
  parentNode: TopicNode;
  score: number;
}

const DEFAULT_SIMILARITY_WEIGHT = 0.7;
const DEFAULT_CONFIDENCE_WEIGHT = 0.3;
const DEFAULT_CANDIDATE_LIMIT = 40;
const DEFAULT_RELATIVE_SCORE_FLOOR = 0.75;
const DEFAULT_SCORE_GAP_THRESHOLD = 0.15;

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
    const candidateLimit = Math.max(this.config.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT, limit);
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
    const searchedFacts = await this.searchMemories(embedding, sessionId, candidateLimit, {
      tags,
      tagMode,
      scope,
      ...(hasConfiguredSessionIds ? { sessionIds } : {}),
    }, warnings);
    const activeFacts = searchedFacts
      .filter((fact) => fact.decayed === false && fact.supersededBy == null && !fact.forgotten)
      .map((fact) => this.rankFact(fact))
      .sort((a, b) => this.compareFacts(a, b));

    if (activeFacts.length === 0) {
      return {
        facts: [],
        nodes: [],
        systemPrompt: buildFactRetrievalPrompt([]),
        tokenCount: 0,
        tokenBudget,
        selection: { candidateCount: searchedFacts.length, rankedCount: 0, selectedFactCount: 0, selectedTopicCount: 0, reason: "exhausted" },
        ...(warnings.length ? { degraded: true, warnings } : {}),
      };
    }

    const rankedBlocks = (await this.buildBlocks(
      activeFacts,
      sessionId,
      scope,
      hasConfiguredSessionIds && (sessionIds.length > 1 || sessionIds[0] !== sessionId),
    ))
      .sort((a, b) => b.score - a.score || a.parentNode.id.localeCompare(b.parentNode.id));
    const selectedBlocks = this.selectBlocks(rankedBlocks, limit);
    const includedBlocks: string[] = [];
    const facts: ScoredMemoryNode[] = [];
    const nodes: TopicNode[] = [];
    let tokenCount = 0;

    let selectionReason = selectedBlocks.reason;
    for (const block of selectedBlocks.blocks) {
      const remainingFactSlots = limit - facts.length;
      if (remainingFactSlots <= 0) { selectionReason = "fact-limit"; break; }
      let blockFacts = block.facts.slice(0, remainingFactSlots);
      let formattedBlock = formatFactBlock(blockFacts, block.parentNode);
      let blockTokenCount = countApproxTokens(formattedBlock);

      while (blockFacts.length > 1 && tokenCount + blockTokenCount > tokenBudget) {
        blockFacts = blockFacts.slice(0, -1);
        formattedBlock = formatFactBlock(blockFacts, block.parentNode);
        blockTokenCount = countApproxTokens(formattedBlock);
      }
      if (tokenCount + blockTokenCount > tokenBudget) { selectionReason = "token-budget"; continue; }

      includedBlocks.push(formattedBlock);
      facts.push(...blockFacts.map(({ retrievalScore: _retrievalScore, ...fact }) => fact));
      nodes.push(block.parentNode);
      tokenCount += blockTokenCount;
    }

    return {
      facts,
      nodes,
      systemPrompt: buildFactRetrievalPrompt(includedBlocks),
      tokenCount,
      tokenBudget,
      selection: {
        candidateCount: searchedFacts.length,
        rankedCount: activeFacts.length,
        selectedFactCount: facts.length,
        selectedTopicCount: nodes.length,
        reason: selectionReason,
      },
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
    options: {
      tags?: string[];
      tagMode?: "all" | "any";
      scope?: "session" | "session-and-tags" | "tagged";
      sessionIds?: string[];
    },
    warnings: MemoGrafterWarning[],
  ): Promise<ScoredMemoryNode[]> {
    if (!this.config.cache || !this.cacheRedis) {
      return this.fetchCandidates(embedding, sessionId, limit, options);
    }

    const ttl = Math.min(Math.max(this.config.cache.ttlSeconds ?? 90, 60), 120);
    const cacheKey = [
      "mg:recall",
      sessionId,
      limit,
      "candidates-v1",
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
    const searchedFacts = await this.fetchCandidates(embedding, sessionId, limit, options);
    try { await this.cacheRedis.setex(cacheKey, ttl, JSON.stringify(searchedFacts)); }
    catch (error: unknown) {
      const warning: MemoGrafterWarning = { code: "CACHE_UNAVAILABLE", operation: "context", context: { sessionId }, cause: error };
      warnings.push(warning);
      emitWarning(this.diagnostics, warning);
    }
    return searchedFacts;
  }

  private fetchCandidates(
    embedding: number[],
    sessionId: string,
    limit: number,
    options: Parameters<GraphStore["searchMemories"]>[4],
  ): Promise<ScoredMemoryNode[]> {
    if (this.store.searchMemoryCandidates) {
      return this.store.searchMemoryCandidates(embedding, sessionId, limit, options);
    }
    // Compatibility fallback for third-party stores implementing the older contract.
    return this.store.searchMemories(embedding, sessionId, limit, -1, options);
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
        facts: topicFacts.sort((a, b) => this.compareFacts(a, b)),
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

  private selectBlocks(
    blocks: RetrievedBlock[],
    factLimit: number,
  ): { blocks: RetrievedBlock[]; reason: SelectionReason } {
    const maxTopics = this.config.selection?.maxTopics ?? factLimit;
    const relativeFloor = this.config.selection?.relativeScoreFloor ?? DEFAULT_RELATIVE_SCORE_FLOOR;
    const gapThreshold = this.config.selection?.scoreGapThreshold ?? DEFAULT_SCORE_GAP_THRESHOLD;
    const selected: RetrievedBlock[] = [];
    const bestScore = blocks[0]?.score ?? 0;
    let factCount = 0;

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block) continue;
      if (selected.length >= maxTopics) return { blocks: selected, reason: "topic-limit" };
      if (factCount >= factLimit) return { blocks: selected, reason: "fact-limit" };
      if (index > 0 && bestScore > 0 && block.score / bestScore < relativeFloor) {
        return { blocks: selected, reason: "relative-score" };
      }
      const previous = blocks[index - 1];
      if (index > 0 && previous && previous.score - block.score >= gapThreshold) {
        return { blocks: selected, reason: "score-gap" };
      }
      selected.push(block);
      factCount += block.facts.length;
    }
    return { blocks: selected, reason: "exhausted" };
  }

  private compareFacts(a: RankedMemoryNode, b: RankedMemoryNode): number {
    return b.retrievalScore - a.retrievalScore
      || b.similarity - a.similarity
      || b.confidence - a.confidence
      || this.timestamp(b.createdAt) - this.timestamp(a.createdAt)
      || a.id.localeCompare(b.id);
  }

  private timestamp(value: unknown): number {
    const timestamp = value instanceof Date
      ? value.getTime()
      : typeof value === "string" || typeof value === "number"
        ? new Date(value).getTime()
        : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
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
