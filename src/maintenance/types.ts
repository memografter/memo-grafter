import type { MemoryEdge, MemoryNode } from "../core/types.js";

export interface CrawlerConfig {
  intervalMs?: number;
  passes?: CrawlerPass[];
  stopOnPassError?: boolean;
  store?: CrawlerMaintenanceStore;
}

export interface CrawlerPass {
  name: string;
  run(context: CrawlerPassContext): Promise<CrawlerPassResult> | CrawlerPassResult;
}

export interface CrawlerPassContext {
  signal?: AbortSignal;
  store?: CrawlerMaintenanceStore;
}

export interface CrawlerPassResult {
  inspected?: number;
  annotated?: number;
  skipped?: number;
  conflictsDetected?: number;
  versionsDetected?: number;
  nodesMarkedConflicting?: number;
  conflictEdgesCreated?: number;
  nodesSuperseded?: number;
  updateEdgesCreated?: number;
  decayScored?: number;
  nodesDecayed?: number;
  wouldDecay?: number;
  minDecayScore?: number;
  maxDecayScore?: number;
  skippedAlreadyDecayed?: number;
  skippedSuperseded?: number;
  skippedDecayed?: number;
  skippedForgotten?: number;
  notes?: string[];
}

export interface CrawlerMaintenanceStore {
  listMemoryNodesForMaintenance(): Promise<MemoryNode[]>;
  markMemoryNodesConflicting(memoryNodeIds: string[]): Promise<number>;
  markMemoryNodeSuperseded(memoryNodeId: string, supersededBy: string): Promise<boolean>;
  markMemoryNodeDecayed(memoryNodeId: string): Promise<boolean>;
  updateMemoryNodeQuality?(memoryNodeId: string, quality: MemoryNode["quality"]): Promise<boolean>;
  upsertMemoryEdge(edge: Pick<MemoryEdge, "sourceId" | "targetId" | "edgeType"> & {
    weight?: number;
  }): Promise<boolean>;
}
export interface CrawlerPassReport {
  name: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result?: CrawlerPassResult;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface CrawlerReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passes: CrawlerPassReport[];
  ok: boolean;
}
