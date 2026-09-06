import { compareQualityEvidence, normalizeMemoryQuality } from "../utils/memoryQuality.js";
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import {
  buildFactRetrievalPrompt,
  formatFactBlock,
} from "../prompts/factRetrievalPrompt.js";
import type { GraphStore } from "../store/index.js";
import type {
  EmbedAdapter,
  Episode,
  MemoryNode,
  RetrievalResult,
  RetrieverConfig,
  MemoGrafterOperationOptions,
  TopicNode,
  LLMAdapter,
} from "../core/types.js";
import { countApproxTokens } from "../utils/text/tokenCount.js";
import { normalizeTags } from "../utils/tags.js";
import { validateEmbedding } from "../adapters/validation.js";
import { emitWarning, type MemoGrafterDiagnostics, type MemoGrafterWarning } from "../diagnostics.js";
import { createOperationControl } from "../utils/operationControl.js";
import { RetrievalQueryContextualizer } from "./RetrievalQueryContextualizer.js";
import { cosineSimilarity } from "../utils/drift/cosineSimilarity.js";

type ScoredMemoryNode = MemoryNode & { similarity: number };
type RankedMemoryNode = ScoredMemoryNode & { retrievalScore: number };
type ScoredTopicNode = TopicNode & { similarity: number };
type ScoredEpisode = Episode & { similarity: number };
type SelectionReason = NonNullable<RetrievalResult["selection"]>["reason"];

interface CandidateSearchResult {
  memories: ScoredMemoryNode[];
  topics: ScoredTopicNode[];
  episodes: ScoredEpisode[];
}

interface RetrievedBlock {
  facts: RankedMemoryNode[];
  parentNode: TopicNode;
  score: number;
  matchedBy: Array<"memory" | "topic">;
}

const DEFAULT_CANDIDATE_LIMIT = 40;
const DEFAULT_RELATIVE_SCORE_FLOOR = 0.75;
const DEFAULT_SCORE_GAP_THRESHOLD = 0.15;
const DEFAULT_TOPIC_MEMORY_LIMIT = 3;

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
    private contextualizerLlm?: LLMAdapter,
  ) {}

  async run(query: string, sessionId: string, options?: MemoGrafterOperationOptions): Promise<RetrievalResult> {
    const control = createOperationControl(options, "context", "provider-request");
    const warnings: MemoGrafterWarning[] = [];
    try {
    const limit = this.config.limit ?? 10;
    const candidateLimit = Math.max(this.config.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT, limit);
    const tokenBudget = this.config.tokenBudget ?? 1200;
    const episodeTokenBudget = this.config.episodeTokenBudget ?? 300;
    const tags = normalizeTags(this.config.tags);
    const tagMode = this.config.tagMode ?? "all";
    const scope = this.config.scope === "tagged" && tags.length > 0
      ? "tagged"
      : this.config.scope ?? (tags.length > 0 ? "session-and-tags" : "session");
    const configuredSessionIds = this.config.sessionIds?.filter(Boolean) ?? [];
    const sessionIds = this.resolveSessionIds(sessionId);
    const hasConfiguredSessionIds = configuredSessionIds.length > 0;

    const contextualized = await new RetrievalQueryContextualizer(this.contextualizerLlm).run(query, this.config.contextualization);
    if (contextualized.warning) {
      const warning: MemoGrafterWarning = { code: "QUERY_CONTEXTUALIZATION_FAILED", operation: "context", stage: "provider-request", context: { sessionId }, cause: contextualized.warning };
      warnings.push(warning);
      emitWarning(this.diagnostics, warning);
    }

    control.throwIfAborted();
    let rawEmbedding: number[];
    try { rawEmbedding = options ? await this.embedder.embed(contextualized.metadata.retrieval, { signal: control.signal }) : await this.embedder.embed(contextualized.metadata.retrieval); }
    catch (error) { control.throwIfAborted(); throw error; }
    const embedding = validateEmbedding(rawEmbedding, this.embedder.dimensions, "context");
    control.throwIfAborted();
    const searched = await this.searchCandidates(embedding, sessionId, candidateLimit, {
      tags,
      tagMode,
      scope,
      ...(hasConfiguredSessionIds ? { sessionIds } : {}),
    }, warnings);
    const activeFacts = searched.memories
      .filter((fact) => fact.decayed === false && fact.supersededBy == null && !fact.forgotten)
      .map((fact) => this.rankFact(fact))
      .sort((a, b) => this.compareFacts(a, b));
    const activeTopics = searched.topics
      .filter((topic) => !topic.suppressed
        && (hasConfiguredSessionIds ? sessionIds.includes(topic.sessionId) : scope === "tagged" || topic.sessionId === sessionId)
        && this.matchesTags(topic.tags, tags, tagMode))
      .map((topic) => ({ ...topic, similarity: this.clampScore(topic.similarity) }))
      .sort((a, b) => b.similarity - a.similarity || this.timestamp(b.lastActiveAt ?? b.createdAt) - this.timestamp(a.lastActiveAt ?? a.createdAt) || a.id.localeCompare(b.id));
    const activeEpisodes = searched.episodes
      .filter((episode) => hasConfiguredSessionIds ? sessionIds.includes(episode.sessionId) : scope === "tagged" || episode.sessionId === sessionId)
      .filter((episode) => this.matchesTags(episode.tags, tags, tagMode))
      .sort((a, b) => b.similarity - a.similarity || this.timestamp(b.createdAt) - this.timestamp(a.createdAt) || a.id.localeCompare(b.id));

    if (activeFacts.length === 0 && activeTopics.length === 0 && activeEpisodes.length === 0) {
      return {
        facts: [],
        nodes: [],
        systemPrompt: buildFactRetrievalPrompt([]),
        tokenCount: 0,
        tokenBudget,
        query: contextualized.metadata,
        episodes: [],
        selection: { candidateCount: searched.memories.length + searched.topics.length + searched.episodes.length, memoryCandidateCount: searched.memories.length, topicCandidateCount: searched.topics.length, episodeCandidateCount: searched.episodes.length, rankedCount: 0, selectedFactCount: 0, selectedTopicCount: 0, selectedEpisodeCount: 0, topicOnlyMatchCount: 0, reason: "exhausted" },
        ...(warnings.length ? { degraded: true, warnings } : {}),
      };
    }

    const rankedBlocks = (await this.buildBlocks(
      activeFacts,
      activeTopics,
      embedding,
      sessionId,
      scope,
      hasConfiguredSessionIds && (sessionIds.length > 1 || sessionIds[0] !== sessionId),
    ))
      .sort((a, b) => b.score - a.score
        || compareQualityEvidence(b.facts[0]?.quality, a.facts[0]?.quality)
        || a.parentNode.id.localeCompare(b.parentNode.id));
    const selectedBlocks = this.selectBlocks(rankedBlocks, limit);
    const includedBlocks: string[] = [];
    const facts: ScoredMemoryNode[] = [];
    const nodes: TopicNode[] = [];
    const includedMatches: NonNullable<RetrievalResult["topicMatches"]> = [];
    let tokenCount = 0;

    let selectionReason = selectedBlocks.reason;
    for (const block of selectedBlocks.blocks) {
      const remainingFactSlots = Math.max(0, limit - facts.length);
      if (remainingFactSlots === 0 && block.facts.length > 0) { selectionReason = "fact-limit"; continue; }
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
      includedMatches.push({ topicId: block.parentNode.id, matchedBy: block.matchedBy, score: block.score });
      tokenCount += blockTokenCount;
    }

    const episodes: ScoredEpisode[] = [];
    let episodeTokens = 0;
    for (const episode of activeEpisodes.slice(0, this.config.episodeLimit ?? 3)) {
      const cost = countApproxTokens(formatEpisode(episode));
      if (episodeTokens + cost > episodeTokenBudget) continue;
      episodes.push(episode);
      episodeTokens += cost;
    }
    const episodeContext = formatEpisodeContext(episodes);

    return {
      facts,
      nodes,
      episodes,
      systemPrompt: [buildFactRetrievalPrompt(includedBlocks), episodeContext].filter(Boolean).join("\n\n"),
      tokenCount: tokenCount + episodeTokens,
      tokenBudget,
      query: contextualized.metadata,
      selection: {
        candidateCount: searched.memories.length + searched.topics.length + searched.episodes.length,
        memoryCandidateCount: searched.memories.length,
        topicCandidateCount: searched.topics.length,
        episodeCandidateCount: searched.episodes.length,
        rankedCount: activeFacts.length + activeTopics.length + activeEpisodes.length,
        selectedFactCount: facts.length,
        selectedTopicCount: nodes.length,
        selectedEpisodeCount: episodes.length,
        topicOnlyMatchCount: includedMatches.filter((match) => match.matchedBy.length === 1 && match.matchedBy[0] === "topic").length,
        reason: selectionReason,
      },
      topicMatches: includedMatches,
      ...(warnings.length ? { degraded: true, warnings } : {}),
    };
    } finally {
      control.dispose();
    }
  }

  private async searchCandidates(
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
  ): Promise<CandidateSearchResult> {
    if (!this.config.cache || !this.cacheRedis) {
      return this.fetchCandidates(embedding, sessionId, limit, options);
    }

    const ttl = Math.min(Math.max(this.config.cache.ttlSeconds ?? 90, 60), 120);
    const revisionSessions = options.sessionIds ?? [sessionId];
    const memoryRevision = this.store.getMemoryRevision
      ? await this.store.getMemoryRevision(revisionSessions)
      : "legacy";
    const cacheKey = [
      "mg:recall",
      sessionId,
      limit,
      "candidates-v3-quality",
      options.scope ?? "session",
      (this.config.sessionIds ?? []).join(","),
      options.tagMode ?? "all",
      (options.tags ?? []).join(","),
      memoryRevision,
      this.hashEmbedding(embedding),
    ].join(":");

    try {
      const hit = await this.cacheRedis.get(cacheKey);

      if (hit) {
        const cached = JSON.parse(hit) as CandidateSearchResult;
        return { ...cached, episodes: cached.episodes ?? [], memories: cached.memories.map(memory => ({ ...memory, quality: normalizeMemoryQuality(memory.quality) })) };
      }

    } catch (error: unknown) {
      const warning: MemoGrafterWarning = { code: "CACHE_UNAVAILABLE", operation: "context", context: { sessionId }, cause: error };
      warnings.push(warning);
      emitWarning(this.diagnostics, warning);
    }
    const searched = await this.fetchCandidates(embedding, sessionId, limit, options);
    try { await this.cacheRedis.setex(cacheKey, ttl, JSON.stringify(searched)); }
    catch (error: unknown) {
      const warning: MemoGrafterWarning = { code: "CACHE_UNAVAILABLE", operation: "context", context: { sessionId }, cause: error };
      warnings.push(warning);
      emitWarning(this.diagnostics, warning);
    }
    return searched;
  }

  private async fetchCandidates(
    embedding: number[],
    sessionId: string,
    limit: number,
    options: Parameters<GraphStore["searchMemories"]>[4],
  ): Promise<CandidateSearchResult> {
    const memorySearch = this.store.searchMemoryCandidates
      ? this.store.searchMemoryCandidates(embedding, sessionId, limit, options)
      : this.store.searchMemories(embedding, sessionId, limit, -1, options);
    const topicSearch = this.store.searchTopicCandidates
      ? this.store.searchTopicCandidates(embedding, sessionId, limit, options)
      : Promise.resolve([]);
    const episodeSearch = this.store.searchEpisodeCandidates
      ? this.store.searchEpisodeCandidates(embedding, sessionId, this.config.episodeCandidateLimit ?? limit, options).catch(() => [])
      : Promise.resolve([]);
    const [memories, topics, episodes] = await Promise.all([memorySearch, topicSearch, episodeSearch]);
    return { memories, topics, episodes };
  }

  private hashEmbedding(embedding: number[]): string {
    const str = embedding.map((value) => value.toFixed(6)).join(",");
    return createHash("sha1").update(str).digest("hex").slice(0, 16);
  }

  private async buildBlocks(
    facts: RankedMemoryNode[],
    topics: ScoredTopicNode[],
    queryEmbedding: number[],
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
    const topicCandidates = new Map(topics.map((topic) => [topic.id, topic]));
    const topicIds = new Set([...factsByTopic.keys(), ...topicCandidates.keys()]);
    const parentNodes = new Map<string, TopicNode>();
    for (const topic of topics) parentNodes.set(topic.id, topic);

    await Promise.all([...factsByTopic.entries()].map(async ([topicNodeId, topicFacts]) => {
      if (parentNodes.has(topicNodeId)) return;
      const parentSessionId = scope === "tagged" || useFactSession ? topicFacts[0]?.sessionId : sessionId;
      const parentNode = await this.store.getTopicNode(topicNodeId, parentSessionId);
      if (parentNode && !parentNode.suppressed) parentNodes.set(topicNodeId, parentNode);
    }));

    const directTopicIds = topics.map((topic) => topic.id);
    const hydrated = await this.hydrateTopicMemories(directTopicIds, topics.map((topic) => topic.sessionId));
    for (const memory of hydrated) {
      const parentNode = parentNodes.get(memory.topicNodeId);
      if (!parentNode || memory.sessionId !== parentNode.sessionId || memory.forgotten || memory.decayed || memory.supersededBy != null) continue;
      const existing = factsByTopic.get(memory.topicNodeId) ?? [];
      if (existing.some((fact) => fact.id === memory.id)) continue;
      const similarity = this.clampScore(cosineSimilarity(queryEmbedding, memory.embedding));
      existing.push(this.rankFact({ ...memory, similarity }));
      factsByTopic.set(memory.topicNodeId, existing);
    }

    const blocks: RetrievedBlock[] = [];
    for (const topicNodeId of topicIds) {
      const parentNode = parentNodes.get(topicNodeId);
      if (!parentNode || parentNode.suppressed) continue;
      const topicCandidate = topicCandidates.get(topicNodeId);
      const memoryEntryFacts = facts.filter((fact) => fact.topicNodeId === topicNodeId);
      const memoryMatched = memoryEntryFacts.length > 0;
      const directFactIds = new Set(memoryEntryFacts.map((fact) => fact.id));
      const hydratedFacts = (factsByTopic.get(topicNodeId) ?? [])
        .filter((fact) => !directFactIds.has(fact.id))
        .sort((a, b) => this.compareFacts(a, b))
        .slice(0, topicCandidate ? DEFAULT_TOPIC_MEMORY_LIMIT : 0);
      const topicFacts = [...memoryEntryFacts, ...hydratedFacts].sort((a, b) => this.compareFacts(a, b));
      const scores = memoryEntryFacts.map((fact) => fact.retrievalScore);
      if (topicCandidate) scores.push(topicCandidate.similarity);
      if (scores.length === 0) continue;
      blocks.push({
        facts: topicFacts,
        parentNode,
        score: Math.max(...scores),
        matchedBy: [
          ...(memoryMatched ? ["memory" as const] : []),
          ...(topicCandidate ? ["topic" as const] : []),
        ],
      });
    }

    return blocks;
  }

  private async hydrateTopicMemories(topicIds: string[], sessionIds: string[]): Promise<MemoryNode[]> {
    if (topicIds.length === 0) return [];
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (this.store.getActiveMemoriesByTopicIds) {
      return this.store.getActiveMemoriesByTopicIds(topicIds, uniqueSessionIds, DEFAULT_TOPIC_MEMORY_LIMIT);
    }
    const memories = await Promise.all(topicIds.map((topicId) => this.store.getMemoriesByTopic(topicId)));
    return memories.flat();
  }

  private rankFact(fact: ScoredMemoryNode): RankedMemoryNode {
    return {
      ...fact,
      quality: normalizeMemoryQuality(fact.quality),
      retrievalScore: this.scoreFact(fact),
    };
  }

  private scoreFact(fact: ScoredMemoryNode): number {
    return this.clampScore(fact.similarity);
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
      if (factCount >= factLimit && block.facts.length > 0) continue;
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
      || compareQualityEvidence(b.quality, a.quality)
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

  private matchesTags(candidateTags: string[] | undefined, requestedTags: string[], tagMode: "all" | "any"): boolean {
    if (requestedTags.length === 0) return true;
    const available = new Set(normalizeTags(candidateTags));
    return tagMode === "any"
      ? requestedTags.some((tag) => available.has(tag))
      : requestedTags.every((tag) => available.has(tag));
  }

  private resolveSessionIds(sessionId: string): string[] {
    const configured = this.config.sessionIds?.filter(Boolean) ?? [];
    if (configured.length === 0) return [sessionId];
    return [...new Set(configured)];
  }
}

function formatEpisode(episode: Episode): string {
  const date = episode.createdAt instanceof Date ? episode.createdAt.toISOString() : String(episode.createdAt);
  return `- [${date}; messages ${episode.messageRange[0]}-${episode.messageRange[1]}] ${episode.summary}`;
}

export function formatEpisodeContext(episodes: Episode[]): string {
  return episodes.length > 0
    ? `Relevant interaction history (historical context, not durable facts):\n${episodes.map(formatEpisode).join("\n")}`
    : "";
}
