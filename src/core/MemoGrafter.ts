import { Redis } from "ioredis";
import { GraftRelevancePipeline } from "../retrieval/GraftRelevancePipeline.js";
import { GrafterPipeline } from "../retrieval/GrafterPipeline.js";
import { RetrieverPipeline } from "../retrieval/RetrieverPipeline.js";
import { IngestPipeline } from "../ingestion/conversation/IngestPipeline.js";
import { IngestQueue } from "../ingestion/IngestQueue.js";
import { PostgresGraphStore } from "../store/index.js";
import { MemoGrafterFleet } from "../agents/fleet/MemoGrafterFleet.js";
import { resolveMemoGrafterConfig } from "../config.js";
import type { MemoGrafterConfigOverrides, MemoGrafterConfigSource } from "../config.js";
import type { MemoGrafterFleetOptions } from "../agents/fleet/types.js";
import type { GraphStore } from "../store/index.js";
import type {
  AbsorbFromAgentOptions,
  EmbedAdapter,
  GraftByRelevanceOptions,
  IngestOptions,
  IngestPipelineOptions,
  IngestTextOptions,
  InjectionResult,
  LLMAdapter,
  MemoryDiff,
  MemoryHistoryOptions,
  MemoryHistoryResult,
  MemoGrafterConfig,
  Message,
  PinnedContextResult,
  RetrievalResult,
  RetrieverConfig,
  TagFilterOptions,
  TopicNode,
  TopicSegment,
} from "./types.js";
import { composePinnedTopicContext } from "../prompts/pinnedTopicPrompt.js";
import { buildFactRetrievalPrompt, formatFactBlock } from "../prompts/factRetrievalPrompt.js";
import { countApproxTokens } from "../utils/text/tokenCount.js";

export class MemoGrafter {
  readonly llm: LLMAdapter;
  readonly embedder: EmbedAdapter;
  readonly store: GraphStore;
  readonly recallCache: Redis | null;
  private readonly ingestPipeline: IngestPipeline;
  private readonly grafterPipeline: GrafterPipeline;
  private readonly ingestQueue: IngestQueue | null;
  private readonly graphTopK: number;
  private readonly graphHopDepth: number;
  private readonly pinnedTokenBudget: number;

  constructor(config: MemoGrafterConfig) {
    this.assertServerEnvironment();

    const windowSize = config.drift?.windowSize ?? 5;
    const mode = config.drift?.mode ?? "intent";
    const threshold = config.drift?.threshold;
    const driftSensitivity = config.drift?.driftSensitivity;
    const minSegmentMessages = config.drift?.minSegmentMessages ?? 3;
    const llmAmbiguityDetection = config.drift?.llmAmbiguityDetection;
    const reentryDetection = config.drift?.reentryDetection;
    const reentryThreshold = config.drift?.reentryThreshold;
    const adaptiveSensitivity = config.drift?.adaptiveSensitivity;
    const topK = config.graph?.topK ?? 5;
    const hopDepth = config.graph?.hopDepth ?? 1;
    const bufferSize = config.inject?.bufferSize ?? 1;
    const tokenBudget = config.inject?.tokenBudget ?? 4000;
    this.pinnedTokenBudget = tokenBudget;

    this.llm = config.llm;
    this.embedder = config.embedder;
    this.store = new PostgresGraphStore(config.db.connectionString, {
      ...(config.db.telemetry ? { telemetry: config.db.telemetry } : {}),
    });
    this.graphTopK = topK;
    this.graphHopDepth = hopDepth;
    this.recallCache = config.cache
      ? new Redis(config.cache.connectionString, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      })
      : null;
    this.recallCache?.on("error", (error: Error) => {
      console.warn("MemoGrafter recall cache Redis warning:", error.message);
    });
    const ingestConfig = {
      windowSize,
      topK,
      mode,
      minSegmentMessages,
    };

    this.ingestPipeline = new IngestPipeline(this.store, config.llm, config.embedder, {
      ...ingestConfig,
      ...(threshold !== undefined ? { threshold } : {}),
      ...(driftSensitivity !== undefined ? { driftSensitivity } : {}),
      ...(llmAmbiguityDetection !== undefined ? { llmAmbiguityDetection } : {}),
      ...(reentryDetection !== undefined ? { reentryDetection } : {}),
      ...(reentryThreshold !== undefined ? { reentryThreshold } : {}),
      ...(adaptiveSensitivity !== undefined ? { adaptiveSensitivity } : {}),
    });
    this.grafterPipeline = new GrafterPipeline(this.store, {
      hopDepth,
      bufferSize,
      tokenBudget,
    });
    this.ingestQueue = config.queue ? new IngestQueue(this.ingestPipeline, config.queue) : null;
  }

  static async create(
    config: MemoGrafterConfigSource,
    overrides: MemoGrafterConfigOverrides = {},
  ): Promise<MemoGrafter> {
    const resolvedConfig = await resolveMemoGrafterConfig(config, overrides);
    const memo = new MemoGrafter(resolvedConfig);

    try {
      await memo.initialize();
      return memo;
    } catch (error) {
      await memo.close().catch(() => undefined);
      throw error;
    }
  }

  initialize(): Promise<void> {
    return this.store.initialize();
  }

  ingest(messages: Message[], sessionId: string, options: IngestOptions = {}): Promise<TopicNode[]> {
    if (this.ingestQueue) {
      return this.enqueueIngest(messages, sessionId, options).then(() => []);
    }

    return this.ingestPipeline.run(messages, sessionId, options);
  }

  ingestNow(messages: Message[], sessionId: string, options: IngestOptions = {}): Promise<TopicNode[]> {
    return this.ingestPipeline.run(messages, sessionId, options);
  }

  /** Analyze and persist one completed user-assistant exchange. */
  analyze(input: {
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
    tags?: string[];
  }): Promise<TopicNode[]> {
    const sessionId = this.requireNonBlankString(input?.sessionId, "sessionId");
    const userMessage = this.requireNonBlankString(input?.userMessage, "userMessage");
    const assistantMessage = this.requireNonBlankString(input?.assistantMessage, "assistantMessage");
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))) {
      throw new TypeError("MemoGrafter analyze tags must be an array of strings.");
    }

    const messages: Message[] = [
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    ];
    const options: IngestOptions = input.tags ? { tags: input.tags } : {};

    if (this.ingestQueue) {
      return this.ingestQueue.enqueueAppend(messages, sessionId, options).then(() => []);
    }
    return this.ingestPipeline.append(messages, sessionId, options);
  }

  /** Retrieve fresh graph context for an external LLM call. */
  context(input: { sessionId: string; query: string } & RetrieverConfig): Promise<RetrievalResult> {
    const sessionId = this.requireNonBlankString(input?.sessionId, "sessionId");
    const query = this.requireNonBlankString(input?.query, "query");
    const { sessionId: _sessionId, query: _query, ...options } = input;
    this.validateRetrieverOptions(options);

    return this.buildContext(sessionId, query, options);
  }

  private async buildContext(sessionId: string, query: string, options: RetrieverConfig): Promise<RetrievalResult> {
    const pipeline = new RetrieverPipeline(this.store, this.embedder, options, null);
    const recalled = await pipeline.run(query, sessionId);
    return this.combinePinnedContext(sessionId, recalled);
  }

  /** @internal Combine an existing recall result with persistent session pins. */
  async combinePinnedContext(
    sessionId: string,
    recalled: RetrievalResult,
    pinnedContext?: PinnedContextResult,
  ): Promise<RetrievalResult> {
    const pinned = pinnedContext ?? await this.getPinnedContext(sessionId);
    const pinnedIds = new Set(pinned.nodes.map((node) => node.id));
    const facts = recalled.facts.filter((fact) => !pinnedIds.has(fact.topicNodeId));
    const nodes = recalled.nodes.filter((node) => !pinnedIds.has(node.id));
    const factsByTopic = new Map<string, typeof facts>();
    for (const fact of facts) factsByTopic.set(fact.topicNodeId, [...(factsByTopic.get(fact.topicNodeId) ?? []), fact]);
    const recalledBlocks = nodes.map((node) => formatFactBlock(factsByTopic.get(node.id) ?? [], node));
    const recalledPrompt = facts.length > 0 ? buildFactRetrievalPrompt(recalledBlocks) : "";
    const systemPrompt = [pinned.systemPrompt, recalledPrompt].filter(Boolean).join("\n\n");
    return {
      ...recalled,
      facts,
      nodes: [...pinned.nodes, ...nodes],
      pinnedNodes: pinned.nodes,
      pinnedContextTruncated: pinned.truncated,
      systemPrompt,
      tokenCount: pinned.tokenCount + (facts.length > 0 ? countApproxTokens(recalledPrompt) : 0),
      ...(recalled.tokenBudget !== undefined ? { tokenBudget: recalled.tokenBudget } : {}),
      ...(pinned.tokenBudget !== undefined ? { pinnedTokenBudget: pinned.tokenBudget } : {}),
    };
  }

  async enqueueIngest(messages: Message[], sessionId: string, options: IngestOptions = {}): Promise<void> {
    if (this.ingestQueue) {
      await this.ingestQueue.enqueue(messages, sessionId, options);
      return;
    }

    await this.ingestPipeline.run(messages, sessionId, options);
  }

  async enqueueIncrementalIngest(
    messages: Message[],
    sessionId: string,
    startIndex: number,
    options: IngestOptions = {},
  ): Promise<void> {
    if (this.ingestQueue) {
      await this.ingestQueue.enqueueIncremental(messages, sessionId, startIndex, options);
      return;
    }

    await this.ingestPipeline.runIncremental(messages, sessionId, startIndex, options);
  }

  ingestText(text: string, sessionId: string, options: IngestTextOptions & IngestOptions = {}): Promise<TopicNode[]> {
    const pipelineOptions = this.toTextPipelineOptions(options);
    if (this.ingestQueue) {
      return this.enqueueTextIngest(text, sessionId, options).then(() => []);
    }

    return this.ingestPipeline.runText(text, sessionId, pipelineOptions);
  }

  async enqueueTextIngest(text: string, sessionId: string, options: IngestTextOptions & IngestOptions = {}): Promise<void> {
    const pipelineOptions = this.toTextPipelineOptions(options);
    if (this.ingestQueue) {
      await this.ingestQueue.enqueueText(text, sessionId, pipelineOptions);
      return;
    }

    await this.ingestPipeline.runText(text, sessionId, pipelineOptions);
  }

  async getTopics(sessionId: string, options: TagFilterOptions = {}): Promise<{ nodes: TopicNode[]; segments: TopicSegment[] }> {
    const nodes = await this.store.getNodesBySession(sessionId, options);
    const segments = await this.store.getSegmentsBySession(sessionId);
    return { nodes, segments };
  }

  inject(sessionId: string, topicIds: string[]): Promise<InjectionResult> {
    return this.grafterPipeline.run(sessionId, topicIds);
  }

  pinTopic(sessionId: string, topicId: string): Promise<boolean> {
    return this.store.pinTopic(
      this.requireNonBlankString(sessionId, "sessionId"),
      this.requireNonBlankString(topicId, "topicId"),
    );
  }

  unpinTopic(sessionId: string, topicId: string): Promise<boolean> {
    return this.store.unpinTopic(
      this.requireNonBlankString(sessionId, "sessionId"),
      this.requireNonBlankString(topicId, "topicId"),
    );
  }

  getPinnedTopics(sessionId: string): Promise<TopicNode[]> {
    return this.store.getPinnedTopics(this.requireNonBlankString(sessionId, "sessionId"));
  }

  async getPinnedContext(sessionId: string): Promise<PinnedContextResult> {
    const nodes = await this.getPinnedTopics(sessionId);
    if (nodes.length === 0) return { systemPrompt: "", nodes: [], memories: [], tokenCount: 0, tokenBudget: this.pinnedTokenBudget, truncated: false };
    const allMemories = await this.store.getMemoriesBySession(sessionId);
    const activeMemories = allMemories.filter((memory) => nodes.some((node) => node.id === memory.topicNodeId)
      && !memory.forgotten && !memory.decayed && memory.supersededBy == null);
    const composed = composePinnedTopicContext(nodes, activeMemories, this.pinnedTokenBudget);
    return {
      systemPrompt: composed.systemPrompt,
      nodes,
      memories: activeMemories,
      tokenCount: composed.tokenCount,
      tokenBudget: this.pinnedTokenBudget,
      truncated: composed.truncated,
    };
  }

  async forget(memoryId: string): Promise<boolean> {
    const changed = await this.store.forgetMemory(memoryId);
    if (changed) await this.clearRecallCache();
    return changed;
  }

  async forgetMany(memoryIds: string[]): Promise<number> {
    const changed = await this.store.forgetMemories(memoryIds);
    if (changed > 0) await this.clearRecallCache();
    return changed;
  }

  async suppressTopic(topicId: string): Promise<boolean> {
    const changed = await this.store.suppressTopic(topicId);
    if (changed) await this.clearRecallCache();
    return changed;
  }

  async restoreTopic(topicId: string): Promise<boolean> {
    const changed = await this.store.restoreTopic(topicId);
    if (changed) await this.clearRecallCache();
    return changed;
  }

  getMemoryHistory(memoryId: string, options?: MemoryHistoryOptions): Promise<MemoryHistoryResult>;
  getMemoryHistory(subject: string, predicate: string, options?: MemoryHistoryOptions): Promise<MemoryHistoryResult>;
  getMemoryHistory(
    memoryIdOrSubject: string,
    predicateOrOptions?: string | MemoryHistoryOptions,
    options: MemoryHistoryOptions = {},
  ): Promise<MemoryHistoryResult> {
    if (typeof predicateOrOptions === "string") {
      return this.store.getMemoryHistoryByFact(memoryIdOrSubject, predicateOrOptions, options);
    }

    return this.store.getMemoryHistoryById(memoryIdOrSubject, predicateOrOptions ?? {});
  }

  getMemoryDiff(fromMemoryId: string, toMemoryId: string): Promise<MemoryDiff> {
    return this.store.getMemoryDiff(fromMemoryId, toMemoryId);
  }

  async graftByRelevance(
    sessionId: string,
    query: string,
    options: GraftByRelevanceOptions = {},
  ): Promise<InjectionResult> {
    const pipeline = new GraftRelevancePipeline(this.store, this.embedder, this.grafterPipeline, {
      topK: this.graphTopK,
      hopDepth: this.graphHopDepth,
    });
    return pipeline.run(sessionId, query, options);
  }

  async ingestGraftedNodes(nodes: TopicNode[], targetSessionId: string): Promise<TopicNode[]> {
    const copiedNodes = await this.store.absorbNodes(nodes, targetSessionId);
    await this.store.rebuildEdgesForSession(targetSessionId);
    return copiedNodes;
  }

  async selectNodesForAbsorb(sourceSessionId: string, options: AbsorbFromAgentOptions): Promise<TopicNode[]> {
    const sourceNodes = await this.store.getNodesBySession(sourceSessionId);

    if (options.topicIds && options.topicIds.length > 0) {
      const topicIds = new Set(options.topicIds);
      return sourceNodes.filter((node) => topicIds.has(node.id));
    }

    if (options.prompt) {
      const embedding = await this.embedder.embed(options.prompt);
      return this.store.getSimilarNodes(embedding, sourceSessionId, {
        k: options.limit ?? 5,
        minSimilarity: options.minSimilarity ?? 0.6,
      });
    }

    return sourceNodes;
  }

  async absorbNodes(nodes: TopicNode[], targetSessionId: string): Promise<TopicNode[]> {
    const copiedNodes = await this.store.absorbNodes(nodes, targetSessionId);
    await this.store.rebuildEdgesForSession(targetSessionId);
    return copiedNodes;
  }

  createFleet(options: MemoGrafterFleetOptions = {}): MemoGrafterFleet {
    return new MemoGrafterFleet(this, options);
  }

  async close(): Promise<void> {
    await this.ingestQueue?.close();
    await this.recallCache?.quit().catch((error: unknown) => {
      console.warn("MemoGrafter recall cache close warning:", error);
      this.recallCache?.disconnect();
    });
    await this.store.close();
  }

  private assertServerEnvironment(): void {
    const globalScope = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
    };

    if (typeof globalScope.window !== "undefined" && typeof globalScope.document !== "undefined") {
      throw new Error("MemoGrafter requires a Node.js server environment and cannot run in the browser.");
    }
  }

  private requireNonBlankString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`MemoGrafter ${field} must be a non-empty string.`);
    }
    return value;
  }

  private validateRetrieverOptions(options: RetrieverConfig): void {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
      throw new RangeError("MemoGrafter context limit must be a positive integer.");
    }
    if (options.tokenBudget !== undefined && (!Number.isInteger(options.tokenBudget) || options.tokenBudget <= 0)) {
      throw new RangeError("MemoGrafter context tokenBudget must be a positive integer.");
    }
    if (options.minSimilarity !== undefined && (!Number.isFinite(options.minSimilarity) || options.minSimilarity < 0 || options.minSimilarity > 1)) {
      throw new RangeError("MemoGrafter context minSimilarity must be between 0 and 1.");
    }
  }

  private toTextPipelineOptions(options: IngestTextOptions & IngestOptions): IngestPipelineOptions {
    return {
      ...(options.replace ? { replace: true } : {}),
      ...(options.label ? { label: options.label } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.tags ? { tags: options.tags } : {}),
      sourceType: "document",
    };
  }

  private async clearRecallCache(): Promise<void> {
    if (!this.recallCache) return;

    try {
      const keys = await this.recallCache.keys("mg:recall:*");
      if (keys.length > 0) {
        await this.recallCache.del(...keys);
      }
    } catch (error: unknown) {
      console.warn("MemoGrafter recall cache invalidation warning:", error);
    }
  }

  private resolveSessionIds(sessionId: string, configured?: string[]): string[] {
    const sessionIds = configured && configured.length > 0 ? configured : [sessionId];
    return [...new Set(sessionIds)];
  }
}
