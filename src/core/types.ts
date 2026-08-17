export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export type DriftMode = "window" | "intent";
export type DriftSensitivity = "low" | "medium" | "high";

export interface TopicNode {
  id: string;
  sessionId: string;
  segmentId: string;
  label: string;
  summary: string;
  embedding: number[];
  tags?: string[];
  source?: string;
  messageRange: [number, number];
  topicOrder: number;
  driftScore: number;
  agentColor: string | null;
  fleetId: string | null;
  agentId: string | null;
  suppressed?: boolean;
  suppressedAt?: Date | null;
  pinned?: boolean;
  pinnedAt?: Date | null;
  createdAt: Date;
}

export interface TopicEdge {
  srcId: string;
  dstId: string;
  weight: number;
  type: string;
}

export interface TopicSegment {
  id: string;
  sessionId: string;
  startIndex: number;
  endIndex: number;
  topicOrder: number;
  driftScore: number;
  createdAt: Date;
}

export type MemoryType = "fact" | "insight" | "question" | "task" | "reference";
export type MemorySourceType = "conversation" | "note" | "document" | "code";

export interface MemoryNode {
  id: string;
  segmentId: string;
  topicNodeId: string;
  agentId: string | null;
  sessionId: string;
  memoryType: MemoryType;
  sourceType: MemorySourceType;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  embedding: number[];
  tags?: string[];
  source?: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  supersededBy: string | null;
  decayed: boolean;
  forgotten?: boolean;
  forgottenAt?: Date | null;
  hasConflict?: boolean;
  agentColor: string | null;
  fleetId: string | null;
  createdAt: Date;
}

export type MemoryNodeInsert = Omit<MemoryNode, "createdAt">;

export interface MemoryEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: "semantic" | "conflicts" | "updates" | "related";
  weight: number;
  createdAt: Date;
}

export type MemoryHistoryStatus = "active" | "superseded" | "conflicting" | "decayed" | "forgotten";

export interface MemoryHistoryEntry {
  memory: MemoryNode;
  versionIndex: number;
  status: MemoryHistoryStatus;
  supersedes: string[];
  supersededBy: string | null;
  conflictsWith: string[];
  updateEdges: MemoryEdge[];
  conflictEdges: MemoryEdge[];
  createdAt: Date;
}

export interface MemoryHistoryResult {
  anchorMemoryId?: string;
  subject?: string;
  predicate?: string;
  sessionId?: string;
  entries: MemoryHistoryEntry[];
  edges: MemoryEdge[];
  currentMemory: MemoryNode | null;
}

export interface MemoryHistoryOptions {
  sessionId?: string;
}

export interface MemoryDiffField {
  field: keyof MemoryNode;
  from: unknown;
  to: unknown;
  changed: boolean;
}

export interface MemoryDiff {
  from: MemoryNode;
  to: MemoryNode;
  fields: MemoryDiffField[];
  changedFields: MemoryDiffField[];
  relationship: {
    supersedes: boolean;
    supersededBy: boolean;
    conflicts: boolean;
    updateEdges: MemoryEdge[];
    conflictEdges: MemoryEdge[];
  };
}

export interface ExtractedMemory {
  memoryType: MemoryType;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
}

export interface SegmentExtractionResult {
  label: string;
  userIntent: string;
  outcome: string;
  open: string | null;
  memories: ExtractedMemory[];
}

export interface InjectionResult {
  systemPrompt: string;
  nodes: TopicNode[];
  memories?: MemoryNode[];
  tokenCount: number;
  tokenBudget?: number;
}

export interface GraftRegistryEntry {
  id: string;
  sessionId: string;
  nodeId: string;
  sourceSessionId: string;
  sourceNodeId: string;
  graftedAt: Date;
}

export type GraftDuplicatePolicy = "skip";

export interface GraftTopicsRequest {
  sourceSessionId: string;
  targetSessionId: string;
  topicIds: string[];
  duplicatePolicy: GraftDuplicatePolicy;
}

export interface GraftTopicsResult {
  sourceSessionId: string;
  targetSessionId: string;
  sourceTopicId: string;
  status: "copied" | "skipped";
  copiedTopics: TopicNode[];
  copiedMemoryCount: number;
  existingTargetTopicId?: string;
}

export interface GraftOrigin {
  sourceSessionId: string;
  sourceNodeId: string;
  graftedAt: Date;
}

export interface GraphSnapshotNode {
  node: TopicNode;
  lifecycle: {
    suppressed: boolean;
    suppressedAt: Date | null;
  };
  graftOrigin?: GraftOrigin;
}

export interface GraphSnapshotMemory {
  memory: MemoryNode;
  lifecycle: {
    forgotten: boolean;
    forgottenAt: Date | null;
    decayed: boolean;
    supersededBy: string | null;
    hasConflict: boolean;
  };
}

export interface GraphSnapshot {
  sessionId: string;
  nodes: TopicNode[];
  snapshotNodes: GraphSnapshotNode[];
  edges: TopicEdge[];
  memories: MemoryNode[];
  snapshotMemories: GraphSnapshotMemory[];
  memoryEdges: MemoryEdge[];
  capturedAt: string;
}

export interface SessionIngestState {
  sessionId: string;
  lastIngestedMessageIndex: number;
  updatedAt: Date;
}

export interface RetrieverConfig {
  limit?: number;
  minSimilarity?: number;
  tokenBudget?: number;
  tags?: string[];
  tagMode?: "all" | "any";
  scope?: "session" | "session-and-tags" | "tagged";
  sessionIds?: string[];
  scoring?: {
    /** Default 0.7. Weight applied to semantic similarity when ranking retrieved facts. */
    similarityWeight?: number;
    /** Default 0.3. Weight applied to memory confidence when ranking retrieved facts. */
    confidenceWeight?: number;
  };
  cache?: {
    ttlSeconds?: number;
  };
}

export interface TagFilterOptions {
  tags?: string[];
  tagMode?: "all" | "any";
  scope?: "session" | "session-and-tags" | "tagged";
  sessionIds?: string[];
  includeSuppressed?: boolean;
  includeForgotten?: boolean;
}

export interface IngestOptions {
  tags?: string[];
}

export interface IngestTextOptions {
  replace?: boolean;
  label?: string;
  source?: string;
}

export type RememberOptions = IngestTextOptions;

/** @internal */
export interface IngestPipelineOptions extends IngestOptions {
  replace?: boolean;
  label?: string;
  source?: string;
  sourceType?: MemorySourceType;
  minSegmentMessages?: number;
}

export interface RetrievalResult {
  facts: (MemoryNode & { similarity: number })[];
  nodes: TopicNode[];
  systemPrompt: string;
  tokenCount: number;
  tokenBudget?: number;
  /** Topics included because they are pinned in the requested session. */
  pinnedNodes?: TopicNode[];
  /** True when pinned context was compacted to fit its configured budget. */
  pinnedContextTruncated?: boolean;
  /** Budget reserved separately for pinned-topic context. */
  pinnedTokenBudget?: number;
}

export interface PinnedContextResult extends InjectionResult {
  truncated: boolean;
}

export interface AbsorbFromAgentOptions {
  topicIds?: string[];
  prompt?: string;
  minSimilarity?: number;
  limit?: number;
}

export type GraftExpansionStrategy = "none" | "graph";
export type FleetMemoryMode = "local" | "fleet" | "both";

export interface GraftByRelevanceOptions {
  topK?: number;
  minSimilarity?: number;
  hopDepth?: number;
  expansionStrategy?: GraftExpansionStrategy;
  sessionIds?: string[];
}

export interface LLMAdapter {
  complete(messages: Message[], system?: string): Promise<string>;
}

export interface EmbedAdapter {
  embed(text: string): Promise<number[]>;
}

export interface MemoGrafterDriftConfig {
  mode?: DriftMode;
  windowSize?: number;
  driftSensitivity?: DriftSensitivity;
  adaptiveSensitivity?: {
    enabled?: boolean;
    minSegments?: number;
    lookbackSegments?: number;
    targetSegmentMessages?: {
      min?: number;
      max?: number;
    };
    adjustmentStep?: number;
    maxAdjustment?: number;
    maxVarianceRatio?: number;
  };
  /** @deprecated Use driftSensitivity instead. */
  threshold?: number;
  minSegmentMessages?: number;
  llmAmbiguityDetection?: boolean;
  reentryDetection?: boolean;
  reentryThreshold?: number;
}

export interface MemoGrafterGraphConfig {
  topK?: number;
  hopDepth?: number;
}

export interface MemoGrafterInjectConfig {
  bufferSize?: number;
  tokenBudget?: number;
  /** Default 20. How many raw messages to keep after the pinned recall block. */
  recentWindowSize?: number;
  /** Default 6. How many recalled facts to inject before each invoke. */
  recallLimit?: number;
  /** Default 0.55. Minimum similarity for recalled facts injected before each invoke. */
  recallMinSimilarity?: number;
}

export type DatabaseQueryOperation = "read" | "write" | "other";

export interface DatabaseQueryTelemetryEvent {
  operation: DatabaseQueryOperation;
}

export interface MemoGrafterDatabaseTelemetry {
  /** Optional observation hook. Callback errors are ignored and never affect database operations. */
  onQuery?: (event: DatabaseQueryTelemetryEvent) => void;
}

export interface MemoGrafterDatabaseConfig {
  connectionString: string;
  telemetry?: MemoGrafterDatabaseTelemetry;
}

export interface QueueJobTelemetryEvent {
  jobId: string;
  kind: "messages" | "append" | "text";
  messageCount: number;
  /** UTF-8 byte length of the serialized BullMQ job data. */
  payloadBytes?: number;
  queuedAt: number;
  startedAt: number;
  completedAt: number;
}

export interface MemoGrafterQueueTelemetry {
  /** Optional observation hook. Callback errors are ignored and never affect queue operations. */
  onJobCompleted?: (event: QueueJobTelemetryEvent) => void;
  /** Optional observation hook for jobs whose final state is failed. */
  onJobFailed?: (event: QueueJobTelemetryEvent) => void;
}

export interface MemoGrafterQueueConfig {
  redisUrl: string;
  queueName?: string;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  telemetry?: MemoGrafterQueueTelemetry;
}

export interface MemoGrafterCacheConfig {
  connectionString: string;
  ttlSeconds?: number;
}

export interface MemoGrafterConfig {
  db: MemoGrafterDatabaseConfig;
  llm: LLMAdapter;
  embedder: EmbedAdapter;
  systemPrompt?: string;
  /** Reuse an existing session. Omit to create a new random session ID. */
  sessionId?: string;
  drift?: MemoGrafterDriftConfig;
  graph?: MemoGrafterGraphConfig;
  inject?: MemoGrafterInjectConfig;
  queue?: MemoGrafterQueueConfig;
  cache?: MemoGrafterCacheConfig;
}
