import type { GraphStore } from "../../store/index.js";
import type {
  DriftSensitivity,
  EmbedAdapter,
  IngestPipelineOptions,
  LLMAdapter,
  MemoGrafterDriftConfig,
  MemoGrafterConfig,
  Message,
  TopicNode,
} from "../../core/types.js";
import { resolveAdaptiveDriftThreshold } from "../../utils/drift/adaptiveDriftSensitivity.js";
import { cosineSimilarity } from "../../utils/drift/cosineSimilarity.js";
import { resolveDriftThreshold } from "../../utils/drift/driftThreshold.js";
import { normalizeText } from "../../utils/text/normalizeText.js";
import { splitTextForIngestion } from "../../utils/text/splitTextForIngestion.js";
import { edgePairKey, findCurrentRunReentryEdges } from "../../utils/reentry/reentryEdges.js";
import { SegmentProcessor } from "./SegmentProcessor.js";
import { TopicAssigner } from "./TopicAssigner.js";
import { TopicClusterAssigner } from "../clustering/TopicClusterAssigner.js";
import { type DriftSegment, TopicDriftDetector } from "./TopicDriftDetector.js";
import { enrichMemoGrafterError, isMemoGrafterError, MemoGrafterError } from "../../diagnostics.js";
import { validateEmbedding } from "../../adapters/validation.js";
import { emitWarning, type MemoGrafterWarning } from "../../diagnostics.js";
import type { IngestionRun, PreparedIngestion } from "../types.js";

const INGEST_OVERLAP_MESSAGES = 6;
const INCREMENTAL_SEMANTIC_THRESHOLD = 0.6;

export class IngestPipeline {
  private readonly segmentProcessor: SegmentProcessor;
  private readonly topicAssigner: TopicAssigner;
  readonly clusterAssigner: TopicClusterAssigner;
  private readonly baseDriftThreshold: number;
  private readonly pendingAppends = new Map<string, Promise<void>>();

  constructor(
    /** @internal */
    private readonly store: GraphStore,
    /** @internal */
    private readonly llm: LLMAdapter,
    /** @internal */
    private readonly embedder: EmbedAdapter,
    /** @internal */
    private readonly config: {
      windowSize: number;
      threshold?: number;
      driftSensitivity?: DriftSensitivity;
      topK: number;
      mode: "window" | "intent";
      minSegmentMessages: number;
      llmAmbiguityDetection?: boolean;
      reentryDetection?: boolean;
      reentryThreshold?: number;
      adaptiveSensitivity?: MemoGrafterDriftConfig["adaptiveSensitivity"];
      diagnostics?: MemoGrafterConfig["diagnostics"];
      requirements?: import("../types.js").IngestionRequirements;
      topicAssignment?: { reuseThreshold?: number; candidateLimit?: number };
      clustering?: MemoGrafterConfig["clustering"];
    },
  ) {
    this.baseDriftThreshold = resolveDriftThreshold(config);
    this.segmentProcessor = new SegmentProcessor(store, llm, embedder, {
      topK: config.topK,
      semanticThreshold: 0.6,
      ...(config.topicAssignment ? { topicAssignment: config.topicAssignment } : {}),
      ...(config.diagnostics !== undefined ? { diagnostics: config.diagnostics } : {}),
    });
    this.topicAssigner = new TopicAssigner(store, config.topicAssignment);
    this.clusterAssigner = new TopicClusterAssigner(store, llm, embedder, config.clustering, config.diagnostics);
  }

  async run(messages: Message[], sessionId: string, options: IngestPipelineOptions = {}): Promise<TopicNode[]> {
    if (messages.length === 0) return [];

    const ingestState = await this.store.getSessionIngestState(sessionId);
    const firstNewMessageIndex = (ingestState?.lastIngestedMessageIndex ?? -1) + 1;
    if (firstNewMessageIndex >= messages.length) return [];

    return this.runIncremental(
      messages.slice(firstNewMessageIndex),
      sessionId,
      firstNewMessageIndex,
      options,
      firstNewMessageIndex,
    );
  }

  /** Append messages after the current ingestion checkpoint for a session. */
  append(messages: Message[], sessionId: string, options: IngestPipelineOptions = {}): Promise<TopicNode[]> {
    const previous = this.pendingAppends.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = previous.then(() => current);
    this.pendingAppends.set(sessionId, turn);

    return previous
      .then(async () => {
        if (messages.length === 0) return [];
        const { startIndex } = await this.stageAppend(messages, sessionId);
        return this.runPersistedAppend(messages, sessionId, startIndex, options);
      })
      .finally(() => {
        release();
        if (this.pendingAppends.get(sessionId) === turn) this.pendingAppends.delete(sessionId);
      });
  }

  /** Persist an append and reserve durable indexes without advancing graph ingestion state. */
  async stageAppend(messages: Message[], sessionId: string): Promise<{ startIndex: number; endIndex: number }> {
    if (messages.length === 0) return { startIndex: 0, endIndex: -1 };
    if (this.store.appendMessages) return this.store.appendMessages(sessionId, messages);

    const ingestState = await this.store.getSessionIngestState(sessionId);
    const startIndex = (ingestState?.lastIngestedMessageIndex ?? -1) + 1;
    await this.store.saveMessagesAt(sessionId, startIndex, messages);
    return { startIndex, endIndex: startIndex + messages.length - 1 };
  }

  /** Process an exchange already persisted by stageAppend(). */
  runPersistedAppend(
    messages: Message[],
    sessionId: string,
    startIndex: number,
    options: IngestPipelineOptions = {},
  ): Promise<TopicNode[]> {
    return this.runIncremental(messages, sessionId, startIndex, options, undefined, true).catch((error: unknown) => {
      const context = { sessionId, messageRange: [startIndex, startIndex + messages.length - 1] as [number, number], messagesPersisted: true, graphProcessed: false, cursorAdvanced: false, retrySafe: true };
      if (isMemoGrafterError(error)) throw enrichMemoGrafterError(error, { operation: "ingest", context });
      throw new MemoGrafterError(error instanceof Error ? error.message : "MemoGrafter ingestion failed.", { code: "INGESTION_FAILED", operation: "ingest", retryable: true, context, cause: error });
    });
  }

  async runIncremental(
    messages: Message[],
    sessionId: string,
    startIndex: number,
    options: IngestPipelineOptions = {},
    knownFirstNewMessageIndex?: number,
    messagesAlreadyPersisted = false,
  ): Promise<TopicNode[]> {
    if (messages.length === 0) return [];

    const ingestState = knownFirstNewMessageIndex === undefined
      ? await this.store.getSessionIngestState(sessionId)
      : null;
    const firstNewMessageIndex = knownFirstNewMessageIndex
      ?? (ingestState?.lastIngestedMessageIndex ?? -1) + 1;
    const jobEndIndex = startIndex + messages.length - 1;
    if (jobEndIndex < firstNewMessageIndex) return [];

    const firstJobMessageIndex = Math.max(startIndex, firstNewMessageIndex);
    const firstJobMessageOffset = firstJobMessageIndex - startIndex;
    const unprocessedJobMessages = messages.slice(firstJobMessageOffset);
    if (!messagesAlreadyPersisted) {
      await this.store.saveMessagesAt(sessionId, firstJobMessageIndex, unprocessedJobMessages);
    }

    let newMessages = unprocessedJobMessages;
    if (firstJobMessageIndex > firstNewMessageIndex) {
      newMessages = await this.store.getMessagesBySession(sessionId, firstNewMessageIndex, jobEndIndex);
      const expectedMessageCount = jobEndIndex - firstNewMessageIndex + 1;
      if (newMessages.length !== expectedMessageCount) {
        throw new Error(
          `MemoGrafter ingestion gap for session ${sessionId}: expected messages ${firstNewMessageIndex}-${jobEndIndex}, found ${newMessages.length}.`,
        );
      }
    }

    const overlapMessages = await this.store.getRecentMessagesBefore(
      sessionId,
      firstNewMessageIndex,
      INGEST_OVERLAP_MESSAGES,
    );
    const contextStartIndex = firstNewMessageIndex - overlapMessages.length;
    const contextMessages = [...overlapMessages, ...newMessages];

    const [existingNodes, existingSegments] = await Promise.all([
      this.store.getNodesBySession(sessionId),
      typeof this.store.getSegmentsBySession === "function" ? this.store.getSegmentsBySession(sessionId) : Promise.resolve([]),
    ]);
    const contextEmbeddings = await Promise.all(contextMessages.map((message) => this.embedMessage(message)));
    const driftDetector = await this.createDriftDetector(sessionId, options.minSegmentMessages);
    const { segments, reentryMap } = await driftDetector.detectSegments(
      contextMessages,
      contextEmbeddings,
      existingNodes,
    );
    const absoluteSegments = this.toNewAbsoluteSegments(
      segments,
      contextStartIndex,
      firstNewMessageIndex,
      existingNodes,
      existingSegments,
    );

    const nodes: TopicNode[] = [];
    const nodeByDetectorTopicOrder = new Map<number, TopicNode>();
    const savedReentryPairs = new Set<string>();
    const { label, minSegmentMessages: _minSegmentMessages, ...segmentOptions } = options;

    for (const [index, { segment, detectorTopicOrder }] of absoluteSegments.entries()) {
      const node = await this.segmentProcessor.process(
        segment,
        contextMessages,
        sessionId,
        {
          ...segmentOptions,
          ...(index === 0 && label ? { label } : {}),
        },
        contextStartIndex,
      );
      nodes.push(node);
      nodeByDetectorTopicOrder.set(detectorTopicOrder, node);

      const matchedNodeId = reentryMap.get(detectorTopicOrder);
      const matchedNode = matchedNodeId
        ? existingNodes.find((existingNode) => existingNode.id === matchedNodeId)
        : undefined;
      if (matchedNode && matchedNode.id !== node.id) {
        await this.store.saveEdge({
          srcId: node.id,
          dstId: matchedNode.id,
          weight: 1,
          type: "reentry",
        });
        savedReentryPairs.add(edgePairKey(node.id, matchedNode.id));
      }
    }

    if (this.config.reentryDetection !== false) {
      const currentRunReentryEdges = findCurrentRunReentryEdges({
        segments: absoluteSegments.map(({ relativeSegment }) => relativeSegment),
        messages: contextMessages,
        embeddings: contextEmbeddings,
        nodeByTopicOrder: nodeByDetectorTopicOrder,
        reentryThreshold: this.config.reentryThreshold ?? 0.85,
        existingPairs: savedReentryPairs,
      });

      for (const edge of currentRunReentryEdges) {
        await this.store.saveEdge(edge);
      }
    }

    await this.linkIncrementalEdges(sessionId, existingNodes, nodes);
    await this.store.updateSessionIngestState(sessionId, jobEndIndex);
    await this.clusterAssigner.classify(nodes);

    return nodes;
  }

  async processIngestionRun(
    run: IngestionRun,
    options: IngestPipelineOptions = {},
    workerId = `local-${process.pid}`,
    leaseDurationMs = 60_000,
  ): Promise<{ nodes: TopicNode[]; warnings: MemoGrafterWarning[]; run: IngestionRun }> {
    if (!this.store.transitionIngestionRun || !this.store.commitPreparedIngestion) {
      throw new MemoGrafterError("The configured store does not support durable ingestion.", { code: "CONFIGURATION_INVALID", operation: "ingest", retryable: false });
    }
    if (run.status === "completed" || run.status === "completed_with_warnings") {
      const allNodes = await this.store.getNodesBySession(run.sessionId);
      const episodes = await this.store.getEpisodesBySession?.(run.sessionId) ?? [];
      const topicIds = new Set(episodes
        .filter((episode) => episode.messageRange[0] >= run.startIndex && episode.messageRange[1] <= run.endIndex)
        .map((episode) => episode.topicId));
      const nodes = episodes.length > 0
        ? allNodes.filter((node) => topicIds.has(node.id))
        : allNodes.filter((node) => node.messageRange[0] >= run.startIndex && node.messageRange[1] <= run.endIndex);
      return { nodes, warnings: [], run };
    }
    const running = await this.store.transitionIngestionRun({ runId: run.id, from: ["accepted", "queued", "retry_pending"], to: "running", workerId, leaseExpiresAt: new Date(Date.now() + leaseDurationMs) });
    const heartbeat = this.store.renewIngestionRunLease ? setInterval(() => { void this.store.renewIngestionRunLease?.(run.id, workerId, new Date(Date.now() + leaseDurationMs)).catch((cause) => emitWarning(this.config.diagnostics, { code: "BEST_EFFORT_OPERATION_FAILED", operation: "ingest", context: { sessionId: run.sessionId, jobId: run.id }, cause })); }, Math.max(1000, Math.floor(leaseDurationMs / 3))) : undefined;
    try {
      const prepared = await this.prepareIngestion(running, options);
      const committed = await this.store.commitPreparedIngestion(prepared);
      const warnings = [...(prepared.warnings ?? []), ...await this.runBestEffortGraphStages(committed.nodes, running.sessionId),
        ...await this.clusterAssigner.classify(committed.nodes)];
      let completedRun = committed.run;
      if (warnings.length > 0) completedRun = await this.store.transitionIngestionRun({ runId: run.id, from: ["completed"], to: "completed_with_warnings" });
      return { nodes: committed.nodes, warnings, run: completedRun };
    } catch (error) {
      const typed = isMemoGrafterError(error) ? error : new MemoGrafterError(error instanceof Error ? error.message : "Durable ingestion failed.", { code: "INGESTION_FAILED", operation: "ingest", retryable: true, cause: error });
      await this.store.transitionIngestionRun({ runId: run.id, from: ["running"], to: typed.retryable ? "retry_pending" : "failed", error: { code: typed.code, ...(typed.stage ? { stage: typed.stage } : {}), message: `Ingestion failed${typed.stage ? ` during ${typed.stage}` : ""} (${typed.code}).`, retryable: typed.retryable } }).catch(() => undefined);
      throw enrichMemoGrafterError(typed, { context: { sessionId: run.sessionId, messageRange: [run.startIndex, run.endIndex], messagesPersisted: true, graphProcessed: false, cursorAdvanced: false, retrySafe: typed.retryable, jobId: run.id } });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private async prepareIngestion(run: IngestionRun, options: IngestPipelineOptions): Promise<PreparedIngestion> {
    const expectedCursor = run.startIndex - 1;
    const currentCursor = (await this.store.getSessionIngestState(run.sessionId))?.lastIngestedMessageIndex ?? -1;
    if (currentCursor !== expectedCursor) throw new MemoGrafterError(`Ingestion range is waiting for the preceding cursor ${expectedCursor}.`, { code: "INGESTION_ORDER_PENDING", operation: "ingest", stage: "message-persistence", retryable: true });
    const messages = await this.store.getMessagesBySession(run.sessionId, run.startIndex, run.endIndex);
    if (messages.length !== run.endIndex - run.startIndex + 1) throw new MemoGrafterError("Durable ingestion message range is incomplete.", { code: "INGESTION_FAILED", operation: "ingest", stage: "message-persistence", retryable: false });
    const overlapMessages = await this.store.getRecentMessagesBefore(run.sessionId, run.startIndex, INGEST_OVERLAP_MESSAGES);
    const contextStartIndex = run.startIndex - overlapMessages.length;
    const contextMessages = [...overlapMessages, ...messages];
    const [existingNodes, existingSegments] = await Promise.all([
      this.store.getNodesBySession(run.sessionId),
      typeof this.store.getSegmentsBySession === "function" ? this.store.getSegmentsBySession(run.sessionId) : Promise.resolve([]),
    ]);
    const contextEmbeddings = await Promise.all(contextMessages.map((message) => this.embedMessage(message)));
    const detector = await this.createDriftDetector(run.sessionId, options.minSegmentMessages);
    const { segments, reentryMap } = await detector.detectSegments(contextMessages, contextEmbeddings, existingNodes);
    const absoluteSegments = this.toNewAbsoluteSegments(segments, contextStartIndex, run.startIndex, existingNodes, existingSegments);
    const prepared: PreparedIngestion = { runId: run.id, sessionId: run.sessionId, startIndex: run.startIndex, endIndex: run.endIndex, expectedCursor, segments: [], nodes: [], topicUpdates: [], episodes: [], memories: [], requiredEdges: [] };
    const nodeByDetectorTopicOrder = new Map<number, TopicNode>();
    const { label, minSegmentMessages: _minSegmentMessages, ...segmentOptions } = options;
    for (const [index, item] of absoluteSegments.entries()) {
      const result = await this.segmentProcessor.prepare(item.segment, contextMessages, run.sessionId, { ...segmentOptions, ...(index === 0 && label ? { label } : {}) }, contextStartIndex, this.config.requirements?.memories !== "best-effort");
      const visibleTopics = [...existingNodes, ...prepared.nodes, ...(prepared.topicUpdates ?? [])];
      const assignment = this.store.saveEpisodeBundle
        ? await this.topicAssigner.assign(result.episode, result.node, visibleTopics)
        : { topic: result.node, createTopic: true, similarity: null };
      const assignedEpisode = {
        ...result.episode,
        topicId: assignment.topic.id,
        assignmentMethod: assignment.createTopic ? "created" as const : "embedding" as const,
        assignmentSimilarity: assignment.similarity,
      };
      prepared.segments.push(result.segment);
      prepared.episodes?.push(assignedEpisode);
      if (assignment.createTopic) prepared.nodes.push(assignment.topic);
      else {
        prepared.topicUpdates = (prepared.topicUpdates ?? []).filter((topic) => topic.id !== assignment.topic.id);
        prepared.topicUpdates.push(assignment.topic);
      }
      prepared.memories.push(...result.memories.map((memory) => ({ ...memory, topicNodeId: assignment.topic.id })));
      prepared.warnings = [...(prepared.warnings ?? []), ...result.warnings];
      nodeByDetectorTopicOrder.set(item.detectorTopicOrder, assignment.topic);
      const matched = existingNodes.find((node) => node.id === reentryMap.get(item.detectorTopicOrder));
      if (matched && matched.id !== assignment.topic.id) prepared.requiredEdges.push({ srcId: assignment.topic.id, dstId: matched.id, weight: 1, type: "reentry" });
      const temporal = index === 0 ? existingNodes.reduce<TopicNode | undefined>((latest, node) => !latest || (node.lastActiveAt ?? node.createdAt) > (latest.lastActiveAt ?? latest.createdAt) ? node : latest, undefined) : nodeByDetectorTopicOrder.get(absoluteSegments[index - 1]!.detectorTopicOrder);
      if (temporal && temporal.id !== assignment.topic.id) prepared.requiredEdges.push({ srcId: assignment.topic.id, dstId: temporal.id, weight: cosineSimilarity(assignment.topic.embedding, temporal.embedding), type: "temporal" });
    }
    if (this.config.reentryDetection !== false) prepared.requiredEdges.push(...findCurrentRunReentryEdges({ segments: absoluteSegments.map((item) => item.relativeSegment), messages: contextMessages, embeddings: contextEmbeddings, nodeByTopicOrder: nodeByDetectorTopicOrder, reentryThreshold: this.config.reentryThreshold ?? 0.85, existingPairs: new Set(prepared.requiredEdges.map((edge) => edgePairKey(edge.srcId, edge.dstId))) }));
    return prepared;
  }

  private async runBestEffortGraphStages(nodes: TopicNode[], sessionId: string): Promise<MemoGrafterWarning[]> {
    const warnings: MemoGrafterWarning[] = [];
    for (const node of nodes) {
      try {
        const similar = await this.store.getSimilarNodes(node.embedding, sessionId, { k: this.config.topK, excludeNodeId: node.id, minSimilarity: INCREMENTAL_SEMANTIC_THRESHOLD });
        for (const target of similar) await this.store.saveEdge({ srcId: node.id, dstId: target.id, weight: cosineSimilarity(node.embedding, target.embedding), type: "semantic" });
        await this.store.buildMemoryEdges(node.id, sessionId, INCREMENTAL_SEMANTIC_THRESHOLD);
      } catch (cause) {
        const warning: MemoGrafterWarning = { code: "BEST_EFFORT_OPERATION_FAILED", operation: "ingest", stage: "graph-processing", context: { sessionId }, cause };
        warnings.push(warning); emitWarning(this.config.diagnostics, warning);
      }
    }
    return warnings;
  }

  async runText(
    text: string,
    sessionId: string,
    options: IngestPipelineOptions = {},
  ): Promise<TopicNode[]> {
    if (text.trim().length === 0) return [];

    if (options.replace) {
      await this.store.clearSession(sessionId);
    }

    const chunks = splitTextForIngestion(text);
    if (chunks.length === 0) return [];

    const messages = await this.store.getMessagesBySession(sessionId);
    return this.run([
      ...messages,
      ...chunks.map((content): Message => ({ role: "user", content })),
    ], sessionId, {
      ...options,
      sourceType: options.sourceType ?? "document",
      minSegmentMessages: options.minSegmentMessages ?? 1,
    });
  }

  private toNewAbsoluteSegments(
    segments: DriftSegment[],
    contextStartIndex: number,
    firstNewMessageIndex: number,
    existingNodes: TopicNode[],
    existingSegments: import("../../core/types.js").TopicSegment[] = [],
  ): Array<{ segment: DriftSegment; detectorTopicOrder: number; relativeSegment: DriftSegment }> {
    const nextTopicOrder = Math.max(
      existingNodes.reduce((max, node) => Math.max(max, node.topicOrder), 0),
      existingSegments.reduce((max, segment) => Math.max(max, segment.topicOrder), 0),
    ) + 1;
    const absoluteSegments: Array<{
      segment: DriftSegment;
      detectorTopicOrder: number;
      relativeSegment: DriftSegment;
    }> = [];

    for (const segment of segments) {
      const absoluteStart = contextStartIndex + segment.start;
      const absoluteEnd = contextStartIndex + segment.end;
      if (absoluteEnd < firstNewMessageIndex) continue;

      absoluteSegments.push({
        detectorTopicOrder: segment.topicOrder,
        relativeSegment: segment,
        segment: {
          start: Math.max(absoluteStart, firstNewMessageIndex),
          end: absoluteEnd,
          topicOrder: nextTopicOrder + absoluteSegments.length,
          driftScore: segment.driftScore,
        },
      });
    }

    return absoluteSegments;
  }

  private async linkIncrementalEdges(
    sessionId: string,
    existingNodes: TopicNode[],
    newNodes: TopicNode[],
  ): Promise<void> {
    if (newNodes.length === 0) return;

    const previousNode = existingNodes.reduce<TopicNode | null>((previous, node) => {
      if (!previous || node.topicOrder > previous.topicOrder) return node;
      return previous;
    }, null);

    for (const [index, node] of newNodes.entries()) {
      const temporalTarget = index === 0 ? previousNode : newNodes[index - 1];
      if (temporalTarget && temporalTarget.id !== node.id) {
        await this.store.saveEdge({
          srcId: node.id,
          dstId: temporalTarget.id,
          weight: cosineSimilarity(node.embedding, temporalTarget.embedding),
          type: "temporal",
        });
      }

      const similarNodes = await this.store.getSimilarNodes(node.embedding, sessionId, {
        k: this.config.topK,
        excludeNodeId: node.id,
        minSimilarity: INCREMENTAL_SEMANTIC_THRESHOLD,
      });

      for (const similarNode of similarNodes) {
        if (similarNode.id === node.id) continue;
        await this.store.saveEdge({
          srcId: node.id,
          dstId: similarNode.id,
          weight: cosineSimilarity(node.embedding, similarNode.embedding),
          type: "semantic",
        });
      }
    }
  }

  private async embedMessage(message: Message): Promise<number[]> {
    const content = normalizeText(message.content) ?? message.content;
    return validateEmbedding(await this.embedder.embed(content), this.embedder.dimensions);
  }

  private async createDriftDetector(sessionId: string, minSegmentMessages?: number): Promise<TopicDriftDetector> {
    const adaptiveConfig = this.config.adaptiveSensitivity;
    const threshold = adaptiveConfig?.enabled
      ? resolveAdaptiveDriftThreshold(
        this.baseDriftThreshold,
        await this.store.getSegmentsBySession(sessionId),
        adaptiveConfig,
      ).threshold
      : this.baseDriftThreshold;

    return new TopicDriftDetector(
      {
        windowSize: this.config.windowSize,
        threshold,
        mode: this.config.mode,
        minSegmentMessages: minSegmentMessages ?? this.config.minSegmentMessages,
        llmAmbiguityDetection: this.config.llmAmbiguityDetection ?? false,
        reentryDetection: this.config.reentryDetection ?? true,
        reentryThreshold: this.config.reentryThreshold ?? 0.85,
      },
      this.llm,
    );
  }
}
