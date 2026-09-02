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
export type MemorySpeaker = "user" | "assistant" | "system" | "document";
export type MemoryExtractionMethod = "explicit" | "inferred" | "user-confirmed" | "document-extraction";

export interface MemoryProvenance {
  speaker: MemorySpeaker;
  /** Absolute indexes in the originating session's durable message buffer. */
  messageIndexes: number[];
  sessionId: string;
  extractionMethod: MemoryExtractionMethod;
}

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
  /** Null only for rows created before memory-level provenance was introduced. */
  provenance?: MemoryProvenance | null;
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
  /** Message indexes are one-based and relative to the extraction prompt. */
  provenance: Omit<MemoryProvenance, "sessionId">;
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
  /** Maximum number of nearest-neighbour candidates fetched before ranking. Default 40. */
  candidateLimit?: number;
  /** Maximum number of facts returned after ranking and adaptive selection. Default 10. */
  limit?: number;
  /** @deprecated Similarity is no longer used as a candidate-generation cutoff. */
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
  selection?: {
    /** Maximum number of topic blocks returned. Defaults to `limit`. */
    maxTopics?: number;
    /** Keep blocks whose score is at least this fraction of the best score. Default 0.75. */
    relativeScoreFloor?: number;
    /** Stop at an adjacent block-score drop at least this large. Default 0.15. */
    scoreGapThreshold?: number;
  };
  cache?: {
    ttlSeconds?: number;
  };
  /** Optional recent conversation used to make an underspecified query standalone before embedding. */
  contextualization?: {
    /** Defaults to true when recentMessages are supplied. */
    enabled?: boolean;
    recentMessages?: Message[];
    /** Maximum recent messages considered. Default 8. */
    maxMessages?: number;
    /** Approximate token budget for recent messages. Default 600. */
    maxTokens?: number;
  };
}

export interface RetrievalQueryMetadata {
  original: string;
  retrieval: string;
  contextualized: boolean;
  contextMessageCount: number;
  status: "not-needed" | "applied" | "fallback" | "disabled";
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
  /** The original and effective query used for semantic retrieval. */
  query?: RetrievalQueryMetadata;
  selection?: {
    candidateCount: number;
    memoryCandidateCount: number;
    topicCandidateCount: number;
    rankedCount: number;
    selectedFactCount: number;
    selectedTopicCount: number;
    topicOnlyMatchCount: number;
    reason: "exhausted" | "fact-limit" | "topic-limit" | "relative-score" | "score-gap" | "token-budget";
  };
  /** Explains which vector source allowed each selected topic to enter retrieval. */
  topicMatches?: Array<{
    topicId: string;
    matchedBy: Array<"memory" | "topic">;
    score: number;
  }>;
  /** Topics included because they are pinned in the requested session. */
  pinnedNodes?: TopicNode[];
  /** True when pinned context was compacted to fit its configured budget. */
  pinnedContextTruncated?: boolean;
  /** Budget reserved separately for pinned-topic context. */
  pinnedTokenBudget?: number;
  /** True when an optional subsystem failed but retrieval still succeeded. */
  degraded?: boolean;
  /** Structured, non-fatal problems encountered while producing this result. */
  warnings?: import("../diagnostics.js").MemoGrafterWarning[];
}

export interface MemoGrafterOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
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
  complete(messages: Message[], system?: string, options?: MemoGrafterOperationOptions): Promise<string>;
  validate?(): Promise<import("../diagnostics.js").AdapterReadiness>;
}

export interface EmbedAdapter {
  embed(text: string, options?: MemoGrafterOperationOptions): Promise<number[]>;
  validate?(): Promise<import("../diagnostics.js").AdapterReadiness>;
  dimensions?: number;
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
  kind: "messages" | "append" | "text" | "run";
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
  onAccepted?: (event: import("../ingestion/types.js").IngestionEvent) => void;
  onQueued?: (event: import("../ingestion/types.js").IngestionEvent) => void;
  onStarted?: (event: import("../ingestion/types.js").IngestionEvent) => void;
  onRetryScheduled?: (event: import("../ingestion/types.js").IngestionEvent) => void;
  onCompleted?: (event: import("../ingestion/types.js").IngestionEvent) => void;
  onCompletedWithWarnings?: (event: import("../ingestion/types.js").IngestionEvent) => void;
  onFailed?: (event: import("../ingestion/types.js").IngestionEvent) => void;
  onAbandoned?: (event: import("../ingestion/types.js").IngestionEvent) => void;
}

export interface MemoGrafterQueueConfig {
  redisUrl: string;
  queueName?: string;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  attempts?: number;
  backoff?: { type: "exponential" | "fixed"; delayMs: number };
  enqueueTimeoutMs?: number;
  processingTimeoutMs?: number;
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
  diagnostics?: import("../diagnostics.js").MemoGrafterDiagnostics;
  ingestion?: { requirements?: import("../ingestion/types.js").IngestionRequirements };
}
