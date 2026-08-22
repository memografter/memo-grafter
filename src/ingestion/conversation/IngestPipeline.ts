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
import { type DriftSegment, TopicDriftDetector } from "./TopicDriftDetector.js";
import { enrichMemoGrafterError, isMemoGrafterError, MemoGrafterError } from "../../diagnostics.js";
import { validateEmbedding } from "../../adapters/validation.js";

const INGEST_OVERLAP_MESSAGES = 6;
const INCREMENTAL_SEMANTIC_THRESHOLD = 0.6;

export class IngestPipeline {
  private readonly segmentProcessor: SegmentProcessor;
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
    },
  ) {
    this.baseDriftThreshold = resolveDriftThreshold(config);
    this.segmentProcessor = new SegmentProcessor(store, llm, embedder, {
      topK: config.topK,
      semanticThreshold: 0.6,
      ...(config.diagnostics !== undefined ? { diagnostics: config.diagnostics } : {}),
    });
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

    const existingNodes = await this.store.getNodesBySession(sessionId);
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

    return nodes;
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
  ): Array<{ segment: DriftSegment; detectorTopicOrder: number; relativeSegment: DriftSegment }> {
    const nextTopicOrder = existingNodes.reduce(
      (max, node) => Math.max(max, node.topicOrder),
      0,
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
