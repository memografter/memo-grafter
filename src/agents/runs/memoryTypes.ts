import type { EmbedAdapter, LLMAdapter, MemoryNode, MemoryQuality } from "../../core/types.js";
import type { AgentEvent, AgentRun } from "./types.js";

export interface AgentCaptureOptions {
  /** Trusted host hook applied to descriptive text before storage and model calls. Keep it deterministic for retries. */
  redactText?: (text: string) => string;
  /** Tool payloads larger than this are replaced with a bounded preview and digest. Default 16000. */
  maxToolPayloadChars?: number;
}
export interface AgentMemoryOptions extends AgentCaptureOptions {
  llm?: LLMAdapter;
  embedder?: EmbedAdapter;
}
export interface AgentWorkingState {
  objective: string;
  currentStep: string | null;
  pendingActions: string[];
  blockers: string[];
}
export interface AgentWorkingStateSnapshot {
  revision: number;
  state: AgentWorkingState;
  updatedAt: Date;
}
export type AgentMemoryBasis = "observed-success" | "observed-failure";
export interface AgentMemoryCandidate {
  kind: "fact" | "lesson";
  subject: string;
  predicate: string;
  value: string;
  conditions: string[];
  basis: AgentMemoryBasis;
  evidenceEventIds: string[];
  quality: MemoryQuality;
}
export interface AgentTaskEpisode {
  id: string;
  runId: string;
  startSequence: number;
  endSequence: number;
  summary: string;
  /** Describes host-reported lifecycle state, never proof that a task succeeded. */
  reportedOutcome: string;
  rejectedCandidates: number;
  memoryIds: string[];
}
export interface AgentMemoryEvidence {
  runId: string;
  episodeId: string;
  kind: "fact" | "lesson";
  basis: AgentMemoryBasis;
  conditions: string[];
  eventIds: string[];
  artifactUris: string[];
}
export interface AgentDurableMemory {
  memory: MemoryNode;
  evidence: AgentMemoryEvidence[];
}
export interface AgentMemoryAPI {
  getWorkingState(runId: string): Promise<AgentWorkingStateSnapshot | null>;
  updateWorkingState(runId: string, input: { expectedRevision: number; state: AgentWorkingState }): Promise<AgentWorkingStateSnapshot>;
  /** Process completed runs or a prefix ending at task.milestone. Retries reuse committed episodes. */
  processRun(runId: string, options?: { throughSequence?: number }): Promise<AgentTaskEpisode[]>;
  listEpisodes(runId: string): Promise<AgentTaskEpisode[]>;
  /** Defaults to active memories; scope filters come from the captured trusted access context. */
  listMemories(options?: { runId?: string; includeInactive?: boolean; limit?: number }): Promise<AgentDurableMemory[]>;
  forgetAgentMemory(memoryId: string): Promise<boolean>;
  suppressEpisode(episodeId: string): Promise<boolean>;
  restoreEpisode(episodeId: string): Promise<boolean>;
}

/** Internal prepared output, persisted atomically with the graph and event references. */
export interface PreparedAgentEpisode {
  run: AgentRun;
  events: AgentEvent[];
  summary: string;
  embedding: number[];
  memories: Array<{ candidate: AgentMemoryCandidate; embedding: number[] }>;
  rejectedCandidates: number;
}
