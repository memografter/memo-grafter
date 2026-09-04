import type {
  GraftRegistryEntry,
  MemoryEdge,
  MemoryDiff,
  MemoryHistoryOptions,
  MemoryHistoryResult,
  MemoryNode,
  MemoryNodeInsert,
  Message,
  SessionIngestState,
  TagFilterOptions,
  TopicEdge,
  TopicNode,
  TopicSegment,
} from "../core/types.js";
import type { MigrationReport } from "../schema/index.js";
import type { AcceptIngestionRequest, IngestionRun, IngestionTransition, PreparedIngestion, ReconciliationIssue } from "../ingestion/types.js";

export interface FleetAgentRecord {
  id: string;
  fleetId: string;
  sessionId: string;
  agentColor: string;
  createdAt: Date;
}

export interface GraphStore {
  initialize(): Promise<void>;
  migrate(): Promise<MigrationReport>;
  verifySchema(): Promise<void>;
  saveMessages(sessionId: string, messages: Message[]): Promise<void>;
  saveMessagesAt(sessionId: string, startIndex: number, messages: Message[]): Promise<void>;
  /** Atomically reserve indexes and append messages. Custom stores may omit this for legacy behavior. */
  appendMessages?(sessionId: string, messages: Message[]): Promise<{ startIndex: number; endIndex: number }>;
  acceptIngestionRun?(request: AcceptIngestionRequest): Promise<IngestionRun>;
  getIngestionRun?(runId: string): Promise<IngestionRun | null>;
  listIngestionRuns?(sessionId?: string, statuses?: IngestionRun["status"][]): Promise<IngestionRun[]>;
  transitionIngestionRun?(transition: IngestionTransition): Promise<IngestionRun>;
  renewIngestionRunLease?(runId: string, workerId: string, leaseExpiresAt: Date): Promise<void>;
  commitPreparedIngestion?(prepared: PreparedIngestion): Promise<{ nodes: TopicNode[]; run: IngestionRun }>;
  inspectIngestionConsistency?(sessionId?: string): Promise<ReconciliationIssue[]>;
  countActiveIngestionRuns?(): Promise<number>;
  getMessagesBySession(sessionId: string, startIndex?: number, endIndex?: number): Promise<Message[]>;
  getRecentMessagesBefore(sessionId: string, beforeIndex: number, limit: number): Promise<Message[]>;
  getSessionIngestState(sessionId: string): Promise<SessionIngestState | null>;
  updateSessionIngestState(sessionId: string, lastIngestedMessageIndex: number): Promise<void>;
  saveSegment(segment: TopicSegment): Promise<TopicSegment>;
  /** Atomically persist a segment and its topic when supported by the store. */
  saveSegmentWithNode?(segment: TopicSegment, node: TopicNode): Promise<{ segment: TopicSegment; node: TopicNode }>;
  saveNode(node: TopicNode): Promise<void>;
  saveEdge(edge: TopicEdge): Promise<void>;
  getEdgesByType(sessionId: string, type: string): Promise<TopicEdge[]>;
  getEdgesBySession(sessionId: string): Promise<TopicEdge[]>;
  getMemoriesBySession(sessionId: string): Promise<MemoryNode[]>;
  getMemoryEdgesBySession(sessionId: string): Promise<MemoryEdge[]>;
  getMemoryHistoryById(memoryNodeId: string, options?: MemoryHistoryOptions): Promise<MemoryHistoryResult>;
  getMemoryHistoryByFact(subject: string, predicate: string, options?: MemoryHistoryOptions): Promise<MemoryHistoryResult>;
  /** Stable revision of memory lifecycle state used to invalidate retrieval caches. */
  getMemoryRevision?(sessionIds: string[]): Promise<string>;
  getMemoryDiff(fromMemoryId: string, toMemoryId: string): Promise<MemoryDiff>;
  listMemoryNodesForMaintenance(): Promise<MemoryNode[]>;
  forgetMemory(memoryNodeId: string): Promise<boolean>;
  forgetMemories(memoryNodeIds: string[]): Promise<number>;
  suppressTopic(topicNodeId: string): Promise<boolean>;
  restoreTopic(topicNodeId: string): Promise<boolean>;
  pinTopic(sessionId: string, topicNodeId: string): Promise<boolean>;
  unpinTopic(sessionId: string, topicNodeId: string): Promise<boolean>;
  getPinnedTopics(sessionId: string): Promise<TopicNode[]>;
  markMemoryNodesConflicting(memoryNodeIds: string[]): Promise<number>;
  markMemoryNodeSuperseded(memoryNodeId: string, supersededBy: string): Promise<boolean>;
  markMemoryNodeDecayed(memoryNodeId: string): Promise<boolean>;
  updateMemoryNodeConfidence(memoryNodeId: string, confidence: number): Promise<boolean>;
  upsertMemoryEdge(edge: Pick<MemoryEdge, "sourceId" | "targetId" | "edgeType"> & {
    weight?: number;
  }): Promise<boolean>;
  clearSession(sessionId: string): Promise<void>;
  clearSessionGraph(sessionId: string): Promise<void>;
  deleteNode(nodeId: string, sessionId?: string): Promise<void>;
  getTopicNode(topicNodeId: string, sessionId?: string): Promise<TopicNode | null>;
  getNodeBySegment(segmentId: string): Promise<TopicNode | null>;
  getSessionNodeCount(sessionId: string): Promise<number>;
  getNodesBySession(sessionId: string, options?: TagFilterOptions): Promise<TopicNode[]>;
  getLastTopicNode(sessionId: string): Promise<TopicNode | null>;
  getSegmentsBySession(sessionId: string): Promise<TopicSegment[]>;
  insertMemories(nodes: MemoryNodeInsert[]): Promise<void>;
  getMemoriesBySegment(segmentId: string): Promise<MemoryNode[]>;
  getMemoriesByTopic(topicNodeId: string): Promise<MemoryNode[]>;
  /** Batch-load active memories for topic candidates. Optional for custom-store compatibility. */
  getActiveMemoriesByTopicIds?(topicNodeIds: string[], sessionIds?: string[]): Promise<MemoryNode[]>;
  searchMemories(
    embedding: number[],
    sessionId: string,
    limit: number,
    minSimilarity: number,
    options?: TagFilterOptions,
  ): Promise<(MemoryNode & { similarity: number })[]>;
  /** Retrieve nearest active memories without applying an absolute similarity cutoff. */
  searchMemoryCandidates?(
    embedding: number[],
    sessionId: string,
    limit: number,
    options?: TagFilterOptions,
  ): Promise<(MemoryNode & { similarity: number })[]>;
  /** Retrieve nearest active topics without applying an absolute similarity cutoff. */
  searchTopicCandidates?(
    embedding: number[],
    sessionId: string,
    limit: number,
    options?: TagFilterOptions,
  ): Promise<(TopicNode & { similarity: number })[]>;
  searchMemoriesAcrossSessions(
    embedding: number[],
    sessionIds: string[],
    limit: number,
    minSimilarity: number,
    options?: TagFilterOptions,
  ): Promise<(MemoryNode & { similarity: number })[]>;
  buildMemoryEdges(topicNodeId: string, sessionId: string, threshold: number): Promise<void>;
  getTopKSimilar(nodeId: string, embedding: number[], sessionId: string, k: number): Promise<TopicNode[]>;
  getSimilarNodes(
    embedding: number[],
    sessionId: string,
    options?: { k?: number; excludeNodeId?: string; minSimilarity?: number },
  ): Promise<TopicNode[]>;
  getSimilarNodesAcrossSessions(
    embedding: number[],
    sessionIds: string[],
    options?: { k?: number; excludeNodeId?: string; minSimilarity?: number },
  ): Promise<TopicNode[]>;
  getSimilarNodesAcrossFleet(
    fleetId: string,
    embedding: number[],
    options?: { k?: number; excludeNodeId?: string; minSimilarity?: number; agentColor?: string },
  ): Promise<TopicNode[]>;
  getNodesByColor(fleetId: string, agentColor: string): Promise<TopicNode[]>;
  saveFleet(fleetId: string, name?: string): Promise<void>;
  saveFleetAgent(agent: {
    id: string;
    fleetId: string;
    sessionId: string;
    agentColor: string;
  }): Promise<void>;
  getFleetAgents(fleetId: string): Promise<FleetAgentRecord[]>;
  tagSessionNodes(sessionId: string, metadata: {
    fleetId: string | null;
    agentId: string | null;
    agentColor: string | null;
  }): Promise<void>;
  setSessionTags(sessionId: string, tags: string[]): Promise<void>;
  getPreviousNode(sessionId: string, topicOrder: number): Promise<TopicNode | null>;
  nodeSimilarity(nodeAId: string, nodeBId: string): Promise<number>;
  getNeighbours(nodeIds: string[], hopDepth: number, sessionId?: string): Promise<TopicNode[]>;
  getBufferMessages(sessionId: string, start: number, end: number, maxChars?: number): Promise<Message[]>;
  insertGraftRegistry(entry: Omit<GraftRegistryEntry, "id" | "graftedAt">): Promise<GraftRegistryEntry>;
  getGraftRegistry(sessionId: string): Promise<GraftRegistryEntry[]>;
  deleteGraftRegistry(nodeId: string): Promise<void>;
  absorbNodes(
    nodes: TopicNode[],
    targetSessionId: string,
    options?: { agentColor?: string | null; fleetId?: string | null; agentId?: string | null },
  ): Promise<TopicNode[]>;
  rebuildEdgesForSession(sessionId: string, semanticTopK?: number, semanticThreshold?: number): Promise<void>;
  close(): Promise<void>;
}
