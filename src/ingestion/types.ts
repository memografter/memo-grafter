import type { MemoryNodeInsert, Message, TopicEdge, TopicNode, TopicSegment } from "../core/types.js";
import type { MemoGrafterErrorCode, MemoGrafterStage, MemoGrafterWarning } from "../diagnostics.js";

export type IngestionKind = "messages" | "append" | "text";
export type IngestionRunStatus = "accepted" | "queued" | "running" | "retry_pending" | "completed" | "completed_with_warnings" | "failed" | "cancelled" | "abandoned";

export interface IngestionRun {
  id: string; sessionId: string; kind: IngestionKind; startIndex: number; endIndex: number;
  idempotencyKey?: string; status: IngestionRunStatus; attemptCount: number;
  queuedAt?: Date; startedAt?: Date; completedAt?: Date; failedAt?: Date;
  leaseExpiresAt?: Date; heartbeatAt?: Date; lastErrorCode?: MemoGrafterErrorCode;
  lastErrorStage?: MemoGrafterStage; lastErrorSafeMessage?: string; retryable?: boolean;
  workerId?: string; createdAt: Date; updatedAt: Date;
}

export interface AcceptIngestionRequest {
  sessionId: string; kind: IngestionKind; messages: Message[]; idempotencyKey?: string;
}

export interface IngestionTransition {
  runId: string; from: IngestionRunStatus[]; to: IngestionRunStatus; workerId?: string;
  leaseExpiresAt?: Date; error?: { code?: MemoGrafterErrorCode; stage?: MemoGrafterStage; message: string; retryable: boolean };
}

export interface PreparedIngestion {
  runId: string; sessionId: string; startIndex: number; endIndex: number; expectedCursor: number;
  segments: TopicSegment[]; nodes: TopicNode[]; memories: MemoryNodeInsert[]; requiredEdges: TopicEdge[]; warnings?: MemoGrafterWarning[];
}

export interface AnalyzeDetailedInput {
  sessionId: string; userMessage: string; assistantMessage: string; tags?: string[]; idempotencyKey?: string;
}

export interface AnalyzeReceipt {
  status: "processed" | "queued"; ingestionRunId: string; sessionId: string;
  messageRange: [number, number]; messagesPersisted: boolean; graphProcessed: boolean;
  nodes?: TopicNode[]; warnings?: MemoGrafterWarning[];
  job?: { id: string; queueName: string };
}

export interface IngestionRequirements {
  topic?: "required"; memories?: "required" | "best-effort";
  semanticEdges?: "required" | "best-effort"; telemetry?: "best-effort";
}
export type IngestionEventType = "accepted" | "queued" | "started" | "retry_scheduled" | "completed" | "completed_with_warnings" | "failed" | "abandoned";
export interface IngestionEvent { type: IngestionEventType; ingestionRunId: string; sessionId: string; messageRange: [number, number]; attemptCount: number; timestamp: number; jobId?: string; workerId?: string; errorCode?: MemoGrafterErrorCode }

export type ReconciliationIssueCode = "accepted-not-started" | "expired-worker-lease" | "retryable-failure" | "cursor-behind-buffer" | "cursor-ahead-of-buffer" | "topic-without-segment" | "segment-without-topic" | "completed-cursor-behind" | "duplicate-range";
export interface ReconciliationIssue { code: ReconciliationIssueCode; severity: "warning" | "error"; sessionId: string; runId?: string; message: string; repairable: boolean }
export interface ReconciliationReport { mode: "inspect" | "repair"; issues: ReconciliationIssue[]; repaired: ReconciliationIssueCode[] }
export interface ReconciliationOptions { mode?: "inspect" | "repair"; repairs?: Array<"requeue-retryable" | "recover-expired-lease" | "queue-accepted"> }

export interface MemoGrafterCloseOptions { drain?: boolean; timeoutMs?: number }
export class MemoGrafterShutdownError extends Error {
  constructor(message: string, readonly failures: string[], readonly pendingRunCount: number, readonly jobsMayBeActive: boolean) { super(message); this.name = "MemoGrafterShutdownError"; }
}
