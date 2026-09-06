import { Redis } from "ioredis";
import { GraftRelevancePipeline } from "../retrieval/GraftRelevancePipeline.js";
import { GrafterPipeline } from "../retrieval/GrafterPipeline.js";
import { formatEpisodeContext, RetrieverPipeline } from "../retrieval/RetrieverPipeline.js";
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
  MemoGrafterOperationOptions,
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
import { MemoGrafterError, emitWarning, enrichMemoGrafterError, isMemoGrafterError, type MemoGrafterDiagnostics, type ReadinessResult } from "../diagnostics.js";
import type { AnalyzeDetailedInput, AnalyzeReceipt, IngestionRun, MemoGrafterCloseOptions, ReconciliationOptions, ReconciliationReport } from "../ingestion/types.js";
import { MemoGrafterShutdownError } from "../ingestion/types.js";
import { createOperationControl } from "../utils/operationControl.js";

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
  private readonly diagnostics: MemoGrafterDiagnostics | undefined;
  private storageInitialized = false;
  private readonly pendingDetailedAnalyze = new Map<string, Promise<void>>();

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
    const topicAssignment = config.drift?.topicAssignment;
    const topK = config.graph?.topK ?? 5;
    const hopDepth = config.graph?.hopDepth ?? 1;
    const bufferSize = config.inject?.bufferSize ?? 1;
    const tokenBudget = config.inject?.tokenBudget ?? 4000;
    this.pinnedTokenBudget = tokenBudget;
    this.diagnostics = config.diagnostics;

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
      emitWarning(this.diagnostics, { code: "CACHE_UNAVAILABLE", operation: "context", context: {}, cause: error });
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
      ...(topicAssignment !== undefined ? { topicAssignment } : {}),
      ...(config.diagnostics !== undefined ? { diagnostics: config.diagnostics } : {}),
      ...(config.ingestion?.requirements !== undefined ? { requirements: config.ingestion.requirements } : {}),
    });
    this.grafterPipeline = new GrafterPipeline(this.store, {
      hopDepth,
      bufferSize,
      tokenBudget,
    });
    this.ingestQueue = config.queue ? new IngestQueue(this.ingestPipeline, config.queue, this.store) : null;
  }

  static async create(
    config: MemoGrafterConfigSource,
    overrides: MemoGrafterConfigOverrides = {},
  ): Promise<MemoGrafter> {
    let memo: MemoGrafter | undefined;
    try {
      let resolvedConfig: MemoGrafterConfig;
      try { resolvedConfig = await resolveMemoGrafterConfig(config, overrides); }
      catch (error) {
        if (isMemoGrafterError(error)) throw error;
        throw new MemoGrafterError("MemoGrafter configuration could not be resolved.", { code: "CONFIGURATION_INVALID", operation: "create", stage: "configuration", retryable: false, cause: error });
      }
      memo = new MemoGrafter(resolvedConfig);
      const readiness = await memo.checkReadiness();
      const failed = readiness.checks.find((check) => check.status === "failed");
      if (failed) {
        throw new MemoGrafterError(failed.message, {
          code: failed.code ?? "CONFIGURATION_INVALID", operation: "create", stage: "configuration",
          context: { checkId: failed.id },
        });
      }
      await memo.initialize();
      return memo;
    } catch (error) {
      await memo?.close().catch(() => undefined);
      throw error;
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.store.initialize();
      this.storageInitialized = true;
    } catch (error) {
      if (isMemoGrafterError(error)) throw error;
      throw new MemoGrafterError("MemoGrafter storage initialization failed.", {
        code: "STORAGE_INITIALIZATION_FAILED", operation: "storage", stage: "storage-initialization", retryable: true, cause: error,
      });
    }
  }

  async checkReadiness(): Promise<ReadinessResult> {
    const checks: ReadinessResult["checks"] = [
      { id: "runtime.node", status: "passed", message: `Node.js ${process.versions.node} is available.` },
      { id: "configuration.database", status: "passed", message: "Database configuration is present." },
      { id: "adapter.llm", status: typeof this.llm.complete === "function" ? "passed" : "failed", ...(typeof this.llm.complete === "function" ? {} : { code: "ADAPTER_INVALID" as const }), message: typeof this.llm.complete === "function" ? "LLM adapter is valid." : "LLM adapter is invalid." },
      { id: "adapter.embedder", status: typeof this.embedder.embed === "function" ? "passed" : "failed", ...(typeof this.embedder.embed === "function" ? {} : { code: "ADAPTER_INVALID" as const }), message: typeof this.embedder.embed === "function" ? "Embedding adapter is valid." : "Embedding adapter is invalid." },
    ];
    for (const adapter of [this.llm, this.embedder]) {
      if (adapter.validate) {
        try { checks.push(...(await adapter.validate()).checks); }
        catch (error) {
          checks.push({ id: adapter === this.llm ? "adapter.llm.validation" : "adapter.embedder.validation", status: "failed", code: isMemoGrafterError(error) ? error.code : "ADAPTER_INVALID", message: error instanceof Error ? error.message : "Adapter validation failed." });
        }
      }
    }
    if (this.embedder.dimensions !== undefined) {
      checks.push(this.embedder.dimensions === 1536
        ? { id: "embedding.dimensions", status: "passed", message: "Embedding dimensions match the 1536-dimensional storage schema." }
        : { id: "embedding.dimensions", status: "failed", code: "CONFIGURATION_INVALID", message: `Embedding dimensions (${this.embedder.dimensions}) do not match the 1536-dimensional storage schema.`, help: "Configure the embedding adapter to return 1536 dimensions." });
    } else {
      checks.push({ id: "embedding.dimensions", status: "warning", message: "Embedding dimensions are not declared; provider responses will be validated at runtime." });
    }
    checks.push(this.storageInitialized
      ? { id: "storage.initialization", status: "passed", message: "Storage is initialized." }
      : { id: "storage.initialization", status: "warning", message: "Storage has not been initialized yet." });
    return { ready: checks.every((check) => check.status !== "failed"), checks };
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
    const validated = this.validateAnalyzeInput(input);
    if (this.storageInitialized && this.store.acceptIngestionRun && this.store.commitPreparedIngestion && this.store.transitionIngestionRun) {
      return this.runDetailedAnalyze(validated).then((receipt) => receipt.nodes ?? []);
    }
    const options: IngestOptions = validated.tags ? { tags: validated.tags } : {};
    const analysis = this.ingestQueue
      ? this.ingestQueue.enqueueAppend(validated.messages, validated.sessionId, options).then(() => [] as TopicNode[])
      : this.ingestPipeline.append(validated.messages, validated.sessionId, options);
    return analysis.catch((error: unknown) => {
      if (isMemoGrafterError(error)) throw enrichMemoGrafterError(error, { operation: "analyze" });
      throw new MemoGrafterError("MemoGrafter analysis failed.", { code: "INGESTION_FAILED", operation: "analyze", retryable: true, context: { sessionId: validated.sessionId, messageRange: [0, 1], retrySafe: false }, cause: error });
    });
  }

  analyzeDetailed(input: AnalyzeDetailedInput, operationOptions?: MemoGrafterOperationOptions): Promise<AnalyzeReceipt> {
    const validated = this.validateAnalyzeInput(input);
    if (!this.storageInitialized) throw new MemoGrafterError("MemoGrafter must be initialized before analyzeDetailed().", { code: "STORAGE_INITIALIZATION_FAILED", operation: "analyze", retryable: false });
    if (!this.store.acceptIngestionRun || !this.store.commitPreparedIngestion || !this.store.transitionIngestionRun) {
      throw new MemoGrafterError("analyzeDetailed requires a durable ingestion store.", { code: "CONFIGURATION_INVALID", operation: "analyze", retryable: false });
    }
    return this.runDetailedAnalyze(validated, operationOptions);
  }

  getIngestionRun(runId: string): Promise<IngestionRun | null> {
    if (!this.store.getIngestionRun) throw new MemoGrafterError("The configured store does not expose ingestion runs.", { code: "CONFIGURATION_INVALID", operation: "ingest", retryable: false });
    return this.store.getIngestionRun(this.requireNonBlankString(runId, "runId"));
  }

  private async runDetailedAnalyze(input: { sessionId: string; messages: Message[]; tags?: string[]; idempotencyKey?: string }, operationOptions?: MemoGrafterOperationOptions): Promise<AnalyzeReceipt> {
    const control = createOperationControl(operationOptions, "analyze", "message-persistence");
    control.throwIfAborted();
    const run = await this.store.acceptIngestionRun!({ sessionId: input.sessionId, kind: "append", messages: input.messages, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
    try {
    control.throwIfAborted("graph-processing");
    const options: IngestOptions = input.tags ? { tags: input.tags } : {};
    if (this.ingestQueue) {
      if (run.status === "queued" || run.status === "running") return { status: "queued", ingestionRunId: run.id, sessionId: run.sessionId, messageRange: [run.startIndex, run.endIndex], messagesPersisted: true, graphProcessed: false, job: { id: run.id, queueName: this.ingestQueue.getQueueName() } };
      if (run.status === "completed" || run.status === "completed_with_warnings") {
        const nodes = (await this.store.getNodesBySession(run.sessionId)).filter((node) => node.messageRange[0] >= run.startIndex && node.messageRange[1] <= run.endIndex);
        return { status: "processed", ingestionRunId: run.id, sessionId: run.sessionId, messageRange: [run.startIndex, run.endIndex], messagesPersisted: true, graphProcessed: true, nodes };
      }
      const job = await this.ingestQueue.enqueueRun(run, options);
      return { status: "queued", ingestionRunId: run.id, sessionId: run.sessionId, messageRange: [run.startIndex, run.endIndex], messagesPersisted: true, graphProcessed: false, job };
    }
    const previous = this.pendingDetailedAnalyze.get(run.sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.pendingDetailedAnalyze.set(run.sessionId, tail);
    let result: Awaited<ReturnType<IngestPipeline["processIngestionRun"]>>;
    try { await previous; control.throwIfAborted("graph-processing"); result = await this.ingestPipeline.processIngestionRun(run, options); }
    finally { release(); if (this.pendingDetailedAnalyze.get(run.sessionId) === tail) this.pendingDetailedAnalyze.delete(run.sessionId); }
    return { status: "processed", ingestionRunId: run.id, sessionId: run.sessionId, messageRange: [run.startIndex, run.endIndex], messagesPersisted: true, graphProcessed: true, nodes: result.nodes, ...(result.warnings.length ? { warnings: result.warnings } : {}) };
    } catch (error) {
      try { control.throwIfAborted("graph-processing"); }
      catch (cancellation) {
        if (isMemoGrafterError(cancellation)) throw enrichMemoGrafterError(cancellation, { context: { sessionId: run.sessionId, messageRange: [run.startIndex, run.endIndex], messagesPersisted: true, graphProcessed: false, cursorAdvanced: false, retrySafe: true, jobId: run.id } });
        throw cancellation;
      }
      throw error;
    } finally { control.dispose(); }
  }

  /** Retrieve fresh graph context for an external LLM call. */
  context(input: { sessionId: string; query: string } & RetrieverConfig, operationOptions?: MemoGrafterOperationOptions): Promise<RetrievalResult> {
    const sessionId = this.requireNonBlankString(input?.sessionId, "sessionId");
    const query = this.requireNonBlankString(input?.query, "query");
    const { sessionId: _sessionId, query: _query, ...options } = input;
    this.validateRetrieverOptions(options);

    return this.buildContext(sessionId, query, options, operationOptions).catch((error: unknown) => {
      if (isMemoGrafterError(error)) throw enrichMemoGrafterError(error, { operation: "context" });
      throw new MemoGrafterError("MemoGrafter context retrieval failed.", { code: "CONTEXT_FAILED", operation: "context", retryable: true, context: { sessionId }, cause: error });
    });
  }

  private async buildContext(sessionId: string, query: string, options: RetrieverConfig, operationOptions?: MemoGrafterOperationOptions): Promise<RetrievalResult> {
    const pipeline = new RetrieverPipeline(this.store, this.embedder, options, null, this.diagnostics, this.llm);
    const recalled = await pipeline.run(query, sessionId, operationOptions);
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
    const factPrompt = facts.length > 0 ? buildFactRetrievalPrompt(recalledBlocks) : "";
    const episodePrompt = formatEpisodeContext(recalled.episodes ?? []);
    const recalledPrompt = [factPrompt, episodePrompt].filter(Boolean).join("\n\n");
    const systemPrompt = [pinned.systemPrompt, recalledPrompt].filter(Boolean).join("\n\n");
    return {
      ...recalled,
      facts,
      nodes: [...pinned.nodes, ...nodes],
      pinnedNodes: pinned.nodes,
      pinnedContextTruncated: pinned.truncated,
      systemPrompt,
      tokenCount: pinned.tokenCount + countApproxTokens(recalledPrompt),
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
    if (this.storageInitialized && this.store.acceptIngestionRun && this.store.transitionIngestionRun && this.store.commitPreparedIngestion) {
      const run = await this.store.acceptIngestionRun({ sessionId, kind: "messages", messages });
      if (run.startIndex !== startIndex) throw new MemoGrafterError(`Accepted range starts at ${run.startIndex}, expected ${startIndex}.`, { code: "INGESTION_INVARIANT_VIOLATION", operation: "ingest", retryable: false, context: { sessionId, messageRange: [run.startIndex, run.endIndex], jobId: run.id } });
      if (this.ingestQueue) await this.ingestQueue.enqueueRun(run, options);
      else await this.ingestPipeline.processIngestionRun(run, options);
      return;
    }
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

  async close(options: MemoGrafterCloseOptions = {}): Promise<void> {
    if (!options.drain) {
      await this.ingestQueue?.close();
      await this.recallCache?.quit().catch((error: unknown) => { console.warn("MemoGrafter recall cache close warning:", error); this.recallCache?.disconnect(); });
      await this.store.close();
      return;
    }
    const failures: string[] = [];
    const timeoutMs = options.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    let pending = await this.store.countActiveIngestionRuns?.().catch(() => -1) ?? 0;
    while (pending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      pending = await this.store.countActiveIngestionRuns?.().catch(() => pending) ?? 0;
    }
    await this.ingestQueue?.close({ strict: true }).catch((error: unknown) => failures.push(error instanceof Error ? error.message : "Queue close failed."));
    await this.recallCache?.quit().catch((error: unknown) => { failures.push(error instanceof Error ? error.message : "Redis close failed."); this.recallCache?.disconnect(); });
    await this.store.close().catch((error: unknown) => failures.push(error instanceof Error ? error.message : "Store close failed."));
    if (failures.length || pending > 0) throw new MemoGrafterShutdownError("MemoGrafter did not shut down cleanly.", failures, pending, pending > 0);
  }

  async reconcileSession(sessionId: string, options: ReconciliationOptions = {}, operationOptions?: MemoGrafterOperationOptions): Promise<ReconciliationReport> {
    return this.reconcile(this.requireNonBlankString(sessionId, "sessionId"), options, operationOptions);
  }

  reconcilePendingIngestion(options: ReconciliationOptions = {}, operationOptions?: MemoGrafterOperationOptions): Promise<ReconciliationReport> { return this.reconcile(undefined, options, operationOptions); }

  private async reconcile(sessionId: string | undefined, options: ReconciliationOptions, operationOptions?: MemoGrafterOperationOptions): Promise<ReconciliationReport> {
    const control = createOperationControl(operationOptions, "ingest", "storage-initialization");
    control.throwIfAborted();
    try {
    if (!this.store.inspectIngestionConsistency || !this.store.listIngestionRuns || !this.store.transitionIngestionRun) throw new MemoGrafterError("The configured store does not support ingestion reconciliation.", { code: "CONFIGURATION_INVALID", operation: "ingest", retryable: false });
    const issues = await this.store.inspectIngestionConsistency(sessionId);
    control.throwIfAborted();
    const repaired: ReconciliationReport["repaired"] = [];
    if (options.mode === "repair") {
      const selected = new Set(options.repairs ?? []);
      for (const issue of issues) {
        control.throwIfAborted();
        if (!issue.runId) continue;
        const run = await this.store.getIngestionRun?.(issue.runId);
        if (!run) continue;
        if (issue.code === "expired-worker-lease" && selected.has("recover-expired-lease") && run.status === "running" && run.leaseExpiresAt && run.leaseExpiresAt.getTime() < Date.now()) {
          await this.store.transitionIngestionRun({ runId: run.id, from: ["running"], to: "retry_pending", error: { message: "Worker lease expired.", retryable: true } }); repaired.push(issue.code);
        } else if ((issue.code === "accepted-not-started" && selected.has("queue-accepted")) || (issue.code === "retryable-failure" && selected.has("requeue-retryable"))) {
          if (this.ingestQueue) {
            const queueable = run.status === "failed" ? await this.store.transitionIngestionRun({ runId: run.id, from: ["failed"], to: "retry_pending" }) : run;
            await this.ingestQueue.enqueueRun(queueable); repaired.push(issue.code);
          }
        }
      }
    }
    return { mode: options.mode ?? "inspect", issues, repaired };
    } finally { control.dispose(); }
  }

  private assertServerEnvironment(): void {
    const globalScope = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
    };

    if (typeof globalScope.window !== "undefined" && typeof globalScope.document !== "undefined") {
      throw new MemoGrafterError("MemoGrafter requires a Node.js server environment and cannot run in the browser.", { code: "RUNTIME_UNSUPPORTED", operation: "create", retryable: false });
    }
  }

  private requireNonBlankString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new MemoGrafterError(`MemoGrafter ${field} must be a non-empty string.`, { code: "INPUT_INVALID", operation: field === "query" ? "context" : "analyze", retryable: false, context: { field } });
    }
    return value;
  }

  private validateAnalyzeInput(input: AnalyzeDetailedInput): { sessionId: string; messages: Message[]; tags?: string[]; idempotencyKey?: string } {
    const sessionId = this.requireNonBlankString(input?.sessionId, "sessionId");
    const userMessage = this.requireNonBlankString(input?.userMessage, "userMessage");
    const assistantMessage = this.requireNonBlankString(input?.assistantMessage, "assistantMessage");
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))) throw new MemoGrafterError("MemoGrafter analyze tags must be an array of strings.", { code: "INPUT_INVALID", operation: "analyze", retryable: false, context: { field: "tags" } });
    const idempotencyKey = input.idempotencyKey === undefined ? undefined : this.requireNonBlankString(input.idempotencyKey, "idempotencyKey");
    return { sessionId, messages: [{ role: "user", content: userMessage }, { role: "assistant", content: assistantMessage }], ...(input.tags ? { tags: input.tags } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) };
  }

  private validateRetrieverOptions(options: RetrieverConfig): void {
    if (options.candidateLimit !== undefined && (!Number.isInteger(options.candidateLimit) || options.candidateLimit <= 0)) {
      throw new MemoGrafterError("MemoGrafter context candidateLimit must be a positive integer.", { code: "INPUT_INVALID", operation: "context", retryable: false, context: { field: "candidateLimit" } });
    }
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
      throw new MemoGrafterError("MemoGrafter context limit must be a positive integer.", { code: "INPUT_INVALID", operation: "context", retryable: false, context: { field: "limit" } });
    }
    if (options.tokenBudget !== undefined && (!Number.isInteger(options.tokenBudget) || options.tokenBudget <= 0)) {
      throw new MemoGrafterError("MemoGrafter context tokenBudget must be a positive integer.", { code: "INPUT_INVALID", operation: "context", retryable: false, context: { field: "tokenBudget" } });
    }
    if (options.minSimilarity !== undefined && (!Number.isFinite(options.minSimilarity) || options.minSimilarity < 0 || options.minSimilarity > 1)) {
      throw new MemoGrafterError("MemoGrafter context minSimilarity must be between 0 and 1.", { code: "INPUT_INVALID", operation: "context", retryable: false, context: { field: "minSimilarity" } });
    }
    if (options.selection?.maxTopics !== undefined && (!Number.isInteger(options.selection.maxTopics) || options.selection.maxTopics <= 0)) {
      throw new MemoGrafterError("MemoGrafter context selection.maxTopics must be a positive integer.", { code: "INPUT_INVALID", operation: "context", retryable: false, context: { field: "selection.maxTopics" } });
    }
    for (const [field, value] of [["selection.relativeScoreFloor", options.selection?.relativeScoreFloor], ["selection.scoreGapThreshold", options.selection?.scoreGapThreshold]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
        throw new MemoGrafterError(`MemoGrafter context ${field} must be between 0 and 1.`, { code: "INPUT_INVALID", operation: "context", retryable: false, context: { field } });
      }
    }
    if (options.contextualization?.recentMessages !== undefined && (!Array.isArray(options.contextualization.recentMessages) || options.contextualization.recentMessages.some((message) => !message || (message.role !== "user" && message.role !== "assistant" && message.role !== "system") || typeof message.content !== "string"))) {
      throw new MemoGrafterError("MemoGrafter context contextualization.recentMessages must contain valid messages.", { code: "INPUT_INVALID", operation: "context", retryable: false, context: { field: "contextualization.recentMessages" } });
    }
    for (const [field, value] of [["contextualization.maxMessages", options.contextualization?.maxMessages], ["contextualization.maxTokens", options.contextualization?.maxTokens]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new MemoGrafterError(`MemoGrafter context ${field} must be a positive integer.`, { code: "INPUT_INVALID", operation: "context", retryable: false, context: { field } });
      }
    }
  }

  private toTextPipelineOptions(options: IngestTextOptions & IngestOptions): IngestPipelineOptions {
    return {
      ...(options.replace ? { replace: true } : {}),
      ...(options.label ? { label: options.label } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.tags ? { tags: options.tags } : {}),
      sourceType: "document",
      ...(options.qualityPolicy ? { qualityPolicy: options.qualityPolicy } : {}),
      ...(options.sourceReliability !== undefined ? { sourceReliability: options.sourceReliability } : {}),
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
      emitWarning(this.diagnostics, { code: "CACHE_UNAVAILABLE", operation: "context", context: {}, cause: error });
      console.warn("MemoGrafter recall cache invalidation warning:", error);
    }
  }

  private resolveSessionIds(sessionId: string, configured?: string[]): string[] {
    const sessionIds = configured && configured.length > 0 ? configured : [sessionId];
    return [...new Set(sessionIds)];
  }
}
