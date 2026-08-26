import { randomUUID } from "node:crypto";
import { MemoGrafter } from "../core/MemoGrafter.js";
import { RetrieverPipeline } from "../retrieval/RetrieverPipeline.js";
import type {
  AbsorbFromAgentOptions,
  GraftByRelevanceOptions,
  GraftRegistryEntry,
  GraphSnapshot,
  InjectionResult,
  IngestTextOptions,
  MemoryEdge,
  MemoryDiff,
  MemoryHistoryResult,
  MemoryNode,
  MemoGrafterConfig,
  Message,
  MemoGrafterOperationOptions,
  RememberOptions,
  RetrievalResult,
  RetrieverConfig,
  TagFilterOptions,
  TopicEdge,
  TopicNode,
  TopicSegment,
} from "../core/types.js";
import { normalizeTags } from "../utils/tags.js";
import { splitTextForIngestion } from "../utils/text/splitTextForIngestion.js";
import { resolveMemoGrafterConfig } from "../config.js";
import type { MemoGrafterConfigOverrides, MemoGrafterConfigSource } from "../config.js";
import { buildInvocationPlan } from "../invocation/InvocationPlanner.js";
import type { PlannedMemoryContext } from "../invocation/types.js";
import { enrichMemoGrafterError, isMemoGrafterError, MemoGrafterError } from "../diagnostics.js";
import { validateCompletion } from "../adapters/validation.js";
import { createOperationControl } from "../utils/operationControl.js";

export class MemoGrafterAgent {
  private readonly core: MemoGrafter;
  private readonly sessionId: string;
  private readonly history: Message[] = [];
  private readonly ingestionHistory: Message[] = [];
  private readonly baseSystemPrompt: string;
  private readonly recentWindowSize: number;
  private readonly recallLimit: number;
  private readonly recallMinSimilarity: number;
  private readonly cacheConfig: MemoGrafterConfig["cache"];
  private sessionTags: string[] = [];
  private pendingIngest: Promise<void> = Promise.resolve();
  private lastEnqueuedIngestionIndex = -1;

  constructor(config: MemoGrafterConfig) {
    this.core = new MemoGrafter(config);
    this.sessionId = config.sessionId?.trim() || randomUUID();
    this.baseSystemPrompt = config.systemPrompt ?? "";
    this.recentWindowSize = config.inject?.recentWindowSize ?? 20;
    this.recallLimit = config.inject?.recallLimit ?? 6;
    this.recallMinSimilarity = config.inject?.recallMinSimilarity ?? 0.55;
    this.cacheConfig = config.cache;
  }

  static async create(
    config: MemoGrafterConfigSource,
    overrides: MemoGrafterConfigOverrides = {},
  ): Promise<MemoGrafterAgent> {
    const resolvedConfig = await resolveMemoGrafterConfig(config, overrides);
    const agent = new MemoGrafterAgent(resolvedConfig);

    try {
      await agent.initialize();
      return agent;
    } catch (error) {
      await agent.close().catch(() => undefined);
      throw error;
    }
  }

  initialize(): Promise<void> {
    return this.core.initialize();
  }

  async invoke(userMessage: string, operationOptions?: MemoGrafterOperationOptions): Promise<string> {
    const control = createOperationControl(operationOptions, "invoke", "provider-request");
    control.throwIfAborted();
    try {
    const plan = await buildInvocationPlan(this.sessionId, userMessage, {
      profile: "memo-grafter-agent",
      history: this.history,
      historySource: "process-local",
      baseSystemPrompt: this.baseSystemPrompt,
      recentWindowSize: this.recentWindowSize,
      buildMemoryContext: () => this._buildMemoryContext(userMessage, {
        limit: this.recallLimit,
        minSimilarity: this.recallMinSimilarity,
      }, [...this.history]),
    });
    let response: string;
    try {
      response = validateCompletion(await this.core.llm.complete(plan.request.messages, plan.request.system, { signal: control.signal }), "invoke");
      control.throwIfAborted();
    } catch (error) {
      control.throwIfAborted();
      if (isMemoGrafterError(error)) throw enrichMemoGrafterError(error, { operation: "invoke" });
      throw new MemoGrafterError("Foreground generation failed.", { code: "PROVIDER_REQUEST_FAILED", operation: "invoke", stage: "provider-request", retryable: true, cause: error });
    }

    this.history.push({ role: "user", content: userMessage });
    this.history.push({ role: "assistant", content: response });
    this.ingestionHistory.push({ role: "user", content: userMessage });
    this.ingestionHistory.push({ role: "assistant", content: response });
    this.enqueueBackgroundIngest();

    return response;
    } finally { control.dispose(); }
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  getSessionId(): string {
    return this.sessionId;
  }

  ingestText(text: string, options: IngestTextOptions = {}): Promise<void> {
    const chunks = splitTextForIngestion(text);
    if (chunks.length === 0) return Promise.resolve();

    const run = async (): Promise<void> => {
      if (options.replace) {
        this.ingestionHistory.splice(0, this.ingestionHistory.length);
        this.lastEnqueuedIngestionIndex = -1;
      }

      await this.core.enqueueTextIngest(text, this.sessionId, {
        ...options,
        tags: this.sessionTags,
      });
      this.ingestionHistory.push(...chunks.map((content): Message => ({ role: "user", content })));
      this.lastEnqueuedIngestionIndex = this.ingestionHistory.length - 1;
    };

    const operation = this.pendingIngest.then(run);
    this.pendingIngest = operation.catch(() => undefined);
    return operation;
  }

  remember(text: string, options: RememberOptions = {}): Promise<void> {
    return this.ingestText(text, {
      source: "remember",
      ...options,
    });
  }

  async getActiveNodes(options: TagFilterOptions = {}): Promise<TopicNode[]> {
    await this.pendingIngest;
    const { nodes } = await this.core.getTopics(this.sessionId, options);
    return nodes;
  }

  async getActiveSegments(): Promise<TopicSegment[]> {
    await this.pendingIngest;
    const { segments } = await this.core.getTopics(this.sessionId);
    return segments;
  }

  async getGraphSnapshot(): Promise<GraphSnapshot> {
    await this.pendingIngest;
    const { nodes } = await this.core.getTopics(this.sessionId, { includeSuppressed: true });
    const edges = await this.core.store.getEdgesBySession(this.sessionId);
    const memories = await this.core.store.getMemoriesBySession(this.sessionId);
    const memoryEdges = await this.core.store.getMemoryEdgesBySession(this.sessionId);
    const registry = await this.core.store.getGraftRegistry(this.sessionId);
    const registryByNodeId = new Map(registry.map((entry) => [entry.nodeId, entry]));
    const sortedNodes = [...nodes].sort(compareTopicNodesForSnapshot);
    const sortedEdges = [...edges].sort(compareTopicEdgesForSnapshot);
    const sortedMemories = [...memories].sort(compareMemoryNodesForSnapshot);
    const sortedMemoryEdges = [...memoryEdges].sort(compareMemoryEdgesForSnapshot);

    return {
      sessionId: this.sessionId,
      nodes: sortedNodes,
      snapshotNodes: sortedNodes.map((node) => {
        const graftEntry = registryByNodeId.get(node.id);

        return {
          node,
          lifecycle: {
            suppressed: node.suppressed ?? false,
            suppressedAt: node.suppressedAt ?? null,
          },
          ...(graftEntry
            ? {
              graftOrigin: {
                sourceSessionId: graftEntry.sourceSessionId,
                sourceNodeId: graftEntry.sourceNodeId,
                graftedAt: graftEntry.graftedAt,
              },
            }
            : {}),
        };
      }),
      edges: sortedEdges,
      memories: sortedMemories,
      snapshotMemories: sortedMemories.map((memory) => ({
        memory,
        lifecycle: {
          forgotten: memory.forgotten ?? false,
          forgottenAt: memory.forgottenAt ?? null,
          decayed: memory.decayed,
          supersededBy: memory.supersededBy,
          hasConflict: memory.hasConflict ?? false,
        },
      })),
      memoryEdges: sortedMemoryEdges,
      capturedAt: new Date().toISOString(),
    };
  }

  async setSessionTags(tags: string[]): Promise<void> {
    await this.pendingIngest;
    this.sessionTags = normalizeTags(tags);
    await this.core.store.setSessionTags(this.sessionId, this.sessionTags);
  }

  getSessionTags(): string[] {
    return [...this.sessionTags];
  }

  async pinTopic(topicId: string): Promise<boolean> {
    await this.pendingIngest;
    return this.core.pinTopic(this.sessionId, topicId);
  }

  async unpinTopic(topicId: string): Promise<boolean> {
    await this.pendingIngest;
    return this.core.unpinTopic(this.sessionId, topicId);
  }

  async getPinnedTopics(): Promise<TopicNode[]> {
    await this.pendingIngest;
    return this.core.getPinnedTopics(this.sessionId);
  }

  async getGraftRegistry(): Promise<GraftRegistryEntry[]> {
    await this.pendingIngest;
    return this.core.store.getGraftRegistry(this.sessionId);
  }

  async removeGraft(nodeId: string): Promise<void> {
    await this.pendingIngest;
    const registry = await this.core.store.getGraftRegistry(this.sessionId);
    const entry = registry.find((candidate) => candidate.nodeId === nodeId);
    if (!entry) {
      throw new Error(`No graft registered for node ${nodeId} in this session.`);
    }

    await this.core.store.deleteNode(nodeId, this.sessionId);
  }

  async forget(memoryId: string): Promise<boolean> {
    await this.pendingIngest;
    return this.core.forget(memoryId);
  }

  async forgetMany(memoryIds: string[]): Promise<number> {
    await this.pendingIngest;
    return this.core.forgetMany(memoryIds);
  }

  async suppressTopic(topicId: string): Promise<boolean> {
    await this.pendingIngest;
    return this.core.suppressTopic(topicId);
  }

  async restoreTopic(topicId: string): Promise<boolean> {
    await this.pendingIngest;
    return this.core.restoreTopic(topicId);
  }

  async getMemoryHistory(memoryId: string): Promise<MemoryHistoryResult>;
  async getMemoryHistory(subject: string, predicate: string): Promise<MemoryHistoryResult>;
  async getMemoryHistory(memoryIdOrSubject: string, predicate?: string): Promise<MemoryHistoryResult> {
    await this.pendingIngest;
    if (predicate) {
      return this.core.getMemoryHistory(memoryIdOrSubject, predicate, { sessionId: this.sessionId });
    }

    return this.core.getMemoryHistory(memoryIdOrSubject, { sessionId: this.sessionId });
  }

  async getMemoryDiff(fromMemoryId: string, toMemoryId: string): Promise<MemoryDiff> {
    await this.pendingIngest;
    return this.core.getMemoryDiff(fromMemoryId, toMemoryId);
  }

  async clearSession(): Promise<void> {
    await this.pendingIngest;
    await this.core.store.clearSession(this.sessionId);
    this.history.splice(0, this.history.length);
    this.ingestionHistory.splice(0, this.ingestionHistory.length);
    this.lastEnqueuedIngestionIndex = -1;
  }

  async graft(topicIds?: string[]): Promise<InjectionResult> {
    await this.pendingIngest;
    const { nodes } = await this.core.getTopics(this.sessionId);
    const selectedTopicIds = topicIds ?? nodes.map((node) => node.id);
    return this.core.inject(this.sessionId, selectedTopicIds);
  }

  async graftByRelevance(query: string, options: GraftByRelevanceOptions = {}): Promise<InjectionResult> {
    await this.pendingIngest;
    return this.core.graftByRelevance(this.sessionId, query, options);
  }

  ingestGraftedNodes(nodes: TopicNode[]): Promise<TopicNode[]> {
    return this.core.ingestGraftedNodes(nodes, this.sessionId);
  }

  async recall(query: string, options: RetrieverConfig = {}): Promise<RetrievalResult> {
    const cacheConfig = options.cache ?? (this.cacheConfig
      ? {
        ...(this.cacheConfig.ttlSeconds !== undefined ? { ttlSeconds: this.cacheConfig.ttlSeconds } : {}),
      }
      : undefined);
    const pipeline = new RetrieverPipeline(
      this.core.store,
      this.core.embedder,
      {
        ...options,
        ...(cacheConfig !== undefined ? { cache: cacheConfig } : {}),
      },
      this.core.recallCache,
      undefined,
      this.core.llm,
    );
    return pipeline.run(query, this.getSessionId());
  }

  async absorbFromAgent(sourceAgent: MemoGrafterAgent, options: AbsorbFromAgentOptions = {}): Promise<TopicNode[]> {
    const nodes = await sourceAgent.core.selectNodesForAbsorb(sourceAgent.getSessionId(), options);
    const registry = await this.core.store.getGraftRegistry(this.sessionId);
    const alreadyAbsorbedSourceIds = new Set(registry.map((entry) => entry.sourceNodeId));
    return this.core.absorbNodes(
      nodes.filter((node) => !alreadyAbsorbedSourceIds.has(node.id)),
      this.sessionId,
    );
  }

  private enqueueBackgroundIngest(): void {
    const endIndex = this.ingestionHistory.length - 1;

    this.pendingIngest = this.pendingIngest
      .then(async () => {
        const startIndex = this.lastEnqueuedIngestionIndex + 1;
        const newMessages = this.ingestionHistory.slice(startIndex, endIndex + 1);
        await this.core.enqueueIncrementalIngest(
          newMessages,
          this.sessionId,
          startIndex,
          { tags: this.sessionTags },
        );
        this.lastEnqueuedIngestionIndex = endIndex;
      })
      .catch((error: unknown) => {
        console.warn("MemoGrafter background ingest warning:", error);
      });
  }

  private async _buildMemoryContext(
    query: string,
    options: { limit: number; minSimilarity: number },
    recentMessages: Message[] = [],
  ): Promise<PlannedMemoryContext> {
    const empty = (status: "not-applicable" | "no-match" | "failed", error?: unknown): PlannedMemoryContext => ({
      placement: "message",
      retrieval: {
        status,
        strategy: "recall",
        topics: [],
        memories: [],
        limit: options.limit,
        minSimilarity: options.minSimilarity,
        sessionIds: [this.sessionId],
        ...(error ? { error: { message: error instanceof Error ? error.message : String(error), recoverable: true } } : {}),
      },
      memoryContext: { content: null, tokenCount: 0 },
    });
    const nodeCount = await this.core.store.getSessionNodeCount(this.sessionId);
    if (nodeCount === 0) return empty("not-applicable");
    const pinned = await this.core.getPinnedContext(this.sessionId);
    let recallError: unknown;
    let recalled: RetrievalResult;
    try {
      recalled = await this.recall(query, {
        limit: options.limit,
        minSimilarity: options.minSimilarity,
        contextualization: { recentMessages },
      });
    } catch (error: unknown) {
      recallError = error;
      console.warn("MemoGrafter recall warning:", error);
      recalled = { facts: [], nodes: [], systemPrompt: "", tokenCount: 0 };
    }
    const result = await this.core.combinePinnedContext(this.sessionId, recalled, pinned);

    if (result.facts.length === 0 && (result.pinnedNodes?.length ?? 0) === 0) {
      return empty(recallError ? "failed" : "no-match", recallError);
    }
    return {
        placement: "message",
        retrieval: {
          status: recallError ? "failed" : "matched",
          strategy: "recall",
          topics: result.nodes,
          memories: result.facts,
          limit: options.limit,
          minSimilarity: options.minSimilarity,
          sessionIds: [this.sessionId],
          ...(result.query ? { query: result.query } : {}),
          ...(recallError ? { error: { message: recallError instanceof Error ? recallError.message : String(recallError), recoverable: true } } : {}),
        },
        memoryContext: {
          content: result.systemPrompt,
          tokenCount: result.tokenCount,
          ...(result.tokenBudget !== undefined ? { tokenBudget: result.tokenBudget } : {}),
        },
      };
  }

  close(): Promise<void> {
    return this.pendingIngest.then(() => this.core.close());
  }
}

function compareTopicNodesForSnapshot(left: TopicNode, right: TopicNode): number {
  return left.topicOrder - right.topicOrder
    || left.messageRange[0] - right.messageRange[0]
    || left.messageRange[1] - right.messageRange[1]
    || left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id);
}

function compareTopicEdgesForSnapshot(left: TopicEdge, right: TopicEdge): number {
  return left.srcId.localeCompare(right.srcId)
    || left.dstId.localeCompare(right.dstId)
    || left.type.localeCompare(right.type)
    || left.weight - right.weight;
}

function compareMemoryNodesForSnapshot(left: MemoryNode, right: MemoryNode): number {
  return left.createdAt.getTime() - right.createdAt.getTime()
    || left.topicNodeId.localeCompare(right.topicNodeId)
    || left.id.localeCompare(right.id);
}

function compareMemoryEdgesForSnapshot(left: MemoryEdge, right: MemoryEdge): number {
  return left.createdAt.getTime() - right.createdAt.getTime()
    || left.sourceId.localeCompare(right.sourceId)
    || left.targetId.localeCompare(right.targetId)
    || left.edgeType.localeCompare(right.edgeType)
    || left.id.localeCompare(right.id);
}
