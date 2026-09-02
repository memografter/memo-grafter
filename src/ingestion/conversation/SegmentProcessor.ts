import { randomUUID } from "node:crypto";
import { buildSegmentExtractionPrompt } from "../../prompts/segmentExtractionPrompt.js";
import type { GraphStore } from "../../store/index.js";
import type {
  EmbedAdapter,
  ExtractedMemory,
  IngestPipelineOptions,
  LLMAdapter,
  MemoryNodeInsert,
  Message,
  SegmentExtractionResult,
  TopicNode,
  TopicSegment,
} from "../../core/types.js";
import { normalizeTags } from "../../utils/tags.js";
import {
  buildSegmentSummary,
  formatMemoryEmbeddingText,
  parseSegmentExtraction,
} from "../../utils/extraction/segmentExtraction.js";
import type { DriftSegment } from "./TopicDriftDetector.js";
import { emitWarning, type MemoGrafterDiagnostics } from "../../diagnostics.js";
import { validateCompletion, validateEmbedding } from "../../adapters/validation.js";
import { validateDurableMemories } from "../../utils/extraction/durableMemoryValidation.js";

export class SegmentProcessor {
  constructor(
    private readonly store: GraphStore,
    private readonly llm: LLMAdapter,
    private readonly embedder: EmbedAdapter,
    private readonly config: {
      topK: number;
      semanticThreshold: number;
      diagnostics?: MemoGrafterDiagnostics;
    },
  ) {}

  async process(
    segment: DriftSegment,
    messages: Message[],
    sessionId: string,
    options: IngestPipelineOptions = {},
    messageOffset = 0,
  ): Promise<TopicNode> {
    const candidateSegment = this.createSegment(segment, sessionId);
    const tags = normalizeTags(options.tags);
    const prepared = await this.prepareTopic(candidateSegment, messages, tags, options, messageOffset);
    const persisted = await this.persistTopic(candidateSegment, prepared.node);
    await this.processMemories(prepared.extracted.memories, persisted.segment, persisted.node, options, messages.slice(
      candidateSegment.startIndex - messageOffset,
      candidateSegment.endIndex - messageOffset + 1,
    ));
    return persisted.node;
  }

  async prepare(
    segment: DriftSegment, messages: Message[], sessionId: string,
    options: IngestPipelineOptions = {}, messageOffset = 0, memoriesRequired = true,
  ): Promise<{ segment: TopicSegment; node: TopicNode; memories: MemoryNodeInsert[]; warnings: import("../../diagnostics.js").MemoGrafterWarning[] }> {
    const candidateSegment = this.createSegment(segment, sessionId);
    const tags = normalizeTags(options.tags);
    const prepared = await this.prepareTopic(candidateSegment, messages, tags, options, messageOffset);
    try {
      const memories = await this.prepareMemories(prepared.extracted.memories, candidateSegment, prepared.node, options, messages.slice(
        candidateSegment.startIndex - messageOffset,
        candidateSegment.endIndex - messageOffset + 1,
      ));
      return { segment: candidateSegment, node: prepared.node, memories, warnings: [] };
    } catch (cause) {
      if (memoriesRequired) throw cause;
      const warning = { code: "BEST_EFFORT_OPERATION_FAILED" as const, operation: "ingest" as const, stage: "embedding" as const, context: { sessionId }, cause };
      emitWarning(this.config.diagnostics, warning);
      return { segment: candidateSegment, node: prepared.node, memories: [], warnings: [warning] };
    }
  }

  private createSegment(segment: DriftSegment, sessionId: string): TopicSegment {
    return {
      id: randomUUID(),
      sessionId,
      startIndex: segment.start,
      endIndex: segment.end,
      topicOrder: segment.topicOrder,
      driftScore: segment.driftScore,
      createdAt: new Date(),
    };
  }

  private async prepareTopic(
    segment: TopicSegment,
    messages: Message[],
    tags: string[],
    options: IngestPipelineOptions,
    messageOffset: number,
  ): Promise<{ extracted: SegmentExtractionResult; node: TopicNode }> {
    const segmentMessages = messages.slice(
      segment.startIndex - messageOffset,
      segment.endIndex - messageOffset + 1,
    );
    const extractionPrompt = buildSegmentExtractionPrompt(segmentMessages, options.label, options.sourceType ?? "conversation");
    const raw = validateCompletion(await this.llm.complete([{ role: "user", content: extractionPrompt }]));
    const extracted = parseSegmentExtraction(raw, this.config.diagnostics);
    const summary = buildSegmentSummary(extracted);
    const embedding = validateEmbedding(await this.embedder.embed(summary), this.embedder.dimensions);

    return {
      extracted,
      node: {
        id: randomUUID(),
        sessionId: segment.sessionId,
        segmentId: segment.id,
        label: extracted.label,
        summary,
        embedding,
        tags,
        ...(options.source ? { source: options.source } : {}),
        messageRange: [segment.startIndex, segment.endIndex],
        topicOrder: segment.topicOrder,
        driftScore: segment.driftScore,
        agentColor: null,
        fleetId: null,
        agentId: null,
        createdAt: new Date(),
      },
    };
  }

  private async persistTopic(
    segment: TopicSegment,
    node: TopicNode,
  ): Promise<{ segment: TopicSegment; node: TopicNode }> {
    if (this.store.saveSegmentWithNode) return this.store.saveSegmentWithNode(segment, node);

    const savedSegment = await this.store.saveSegment(segment);
    const existingNode = typeof this.store.getNodeBySegment === "function"
      ? await this.store.getNodeBySegment(savedSegment.id)
      : null;
    const stableNode = {
      ...node,
      id: existingNode?.id ?? node.id,
      segmentId: savedSegment.id,
    };
    await this.store.saveNode(stableNode);
    return { segment: savedSegment, node: stableNode };
  }

  private async processMemories(
    memories: ExtractedMemory[],
    segment: TopicSegment,
    topicNode: TopicNode,
    options: IngestPipelineOptions,
    segmentMessages: Message[],
  ): Promise<void> {
    if (memories.length === 0) return;

    try {
      const nodes = await this.prepareMemories(memories, segment, topicNode, options, segmentMessages);
      await this.store.insertMemories(nodes);
      await this.store.buildMemoryEdges(topicNode.id, segment.sessionId, this.config.semanticThreshold);
    } catch (error) {
      emitWarning(this.config.diagnostics, { code: "BEST_EFFORT_OPERATION_FAILED", operation: "analyze", stage: "graph-processing", context: { sessionId: segment.sessionId, messageRange: [segment.startIndex, segment.endIndex] }, cause: error });
      console.warn("SegmentProcessor memory processing warning:", error);
    }
  }

  private async prepareMemories(memories: ExtractedMemory[], segment: TopicSegment, topicNode: TopicNode, options: IngestPipelineOptions, segmentMessages: Message[]): Promise<MemoryNodeInsert[]> {
    const nodes: MemoryNodeInsert[] = [];
    const validation = validateDurableMemories(memories, segmentMessages, segment, options.sourceType ?? "conversation");
    for (const rejection of validation.rejected) {
      console.warn(`SegmentProcessor rejected non-durable memory (${rejection.reason}):`, rejection.memory.value);
    }
    for (const memory of validation.accepted) {
      const embedding = validateEmbedding(await this.embedder.embed(formatMemoryEmbeddingText(memory)), this.embedder.dimensions);
      nodes.push({ id: randomUUID(), segmentId: segment.id, topicNodeId: topicNode.id, sessionId: segment.sessionId,
        agentId: topicNode.agentId, agentColor: topicNode.agentColor, fleetId: topicNode.fleetId,
        memoryType: memory.memoryType, sourceType: options.sourceType ?? "conversation", subject: memory.subject,
        predicate: memory.predicate, value: memory.value, confidence: memory.confidence, embedding,
        tags: topicNode.tags ?? [], ...(options.source ? { source: options.source } : {}), sourceUrl: null,
        sourceTitle: null, provenance: memory.absoluteProvenance, supersededBy: null, decayed: false });
    }
    return nodes;
  }
}
