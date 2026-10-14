/** Trusted server-side identity. Never populate projectIds directly from an agent/tool payload. */
export interface AgentRunAccess {
  tenantId: string;
  agentId: string;
  /** Projects the host application has authorized this agent to read/write. */
  projectIds?: readonly string[];
}

export type AgentRunScope = { kind: "private" } | { kind: "project"; projectId: string };
export type AgentRunStatus = "running" | "interrupted" | "succeeded" | "failed" | "cancelled";
export interface StartAgentRunInput {
  /** Stable caller-generated key; reuse it to retry starting the same run. */
  runId: string;
  taskId: string;
  objective: string;
  sessionId?: string;
  scope?: AgentRunScope;
}
export interface AgentRun {
  runId: string;
  agentId: string;
  taskId: string;
  objective: string;
  sessionId: string | null;
  scope: AgentRunScope;
  status: AgentRunStatus;
  createdAt: Date;
  updatedAt: Date;
}
export type AgentEventData =
  | { type: "task.milestone"; label: string; summary: string }
  | { type: "task.started"; objective: string }
  | { type: "tool.call"; toolCallId: string; toolName: string; input: JsonValue }
  | { type: "tool.result"; toolCallId: string; outcome: "success" | "failure"; output: JsonValue }
  | { type: "observation"; text: string }
  | { type: "artifact"; uri: string; description?: string }
  | { type: "task.completed"; summary: string }
  | { type: "task.failed"; summary: string }
  | { type: "task.cancelled"; summary: string };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface AgentEventInput {
  eventId: string;
  /** Sequence zero is reserved for task.started. Out-of-order delivery is supported. */
  sequence: number;
  occurredAt: string;
  data: AgentEventData;
  source?: { uri: string; externalId?: string };
}
export interface AgentEvent extends AgentEventInput {
  runId: string;
  receivedAt: Date;
}
export interface CompleteAgentRunInput {
  eventId: string;
  sequence: number;
  occurredAt: string;
  outcome: "succeeded" | "failed" | "cancelled";
  summary: string;
}
/** All methods enforce the identity captured when this API was constructed. */
export interface AgentRunAPI {
  startRun(input: StartAgentRunInput): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun>;
  recordEvent(runId: string, event: AgentEventInput): Promise<AgentEvent>;
  listEvents(runId: string, options?: { afterSequence?: number; limit?: number }): Promise<AgentEvent[]>;
  interruptRun(runId: string): Promise<AgentRun>;
  resumeRun(runId: string): Promise<AgentRun>;
  completeRun(runId: string, input: CompleteAgentRunInput): Promise<AgentRun>;
}
export type AgentRunErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "ACCESS_DENIED" | "CONFLICT" | "INVALID_STATE" | "INCOMPLETE_HISTORY";
export class AgentRunError extends Error {
  constructor(readonly code: AgentRunErrorCode, message: string) {
    super(message);
    this.name = "AgentRunError";
  }
}
