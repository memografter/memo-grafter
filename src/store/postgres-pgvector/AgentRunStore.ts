import type { JSONValue, Sql, TransactionSql } from "postgres";
import {
  AgentRunError, type AgentEvent, type AgentEventInput, type AgentRun, type AgentRunAccess,
  type AgentRunAPI, type AgentRunStatus, type CompleteAgentRunInput, type StartAgentRunInput,
} from "../../agents/runs/types.js";
import { identifier, jsonSnapshot, nonblank, validateEvent } from "../../agents/runs/validation.js";
import { redactText, sanitizeEvent } from "../../agents/runs/redaction.js";
import type { AgentCaptureOptions } from "../../agents/runs/memoryTypes.js";

export interface RunRow {
  run_id: string; agent_id: string; task_id: string; objective: string;
  session_id: string | null; project_id: string | null; status: AgentRunStatus;
  created_at: Date; updated_at: Date;
}
interface EventRow { event: AgentEventInput; received_at: Date }
type Connection = Sql | TransactionSql;

/** Uses the graph store's pool; no LLM calls or conversation ingestion are involved. */
export class PostgresAgentRunStore implements AgentRunAPI {
  protected readonly tenantId: string;
  protected readonly agentId: string;
  protected readonly projectIds: string[];

  constructor(protected readonly sql: Sql, access: AgentRunAccess, protected readonly capture: AgentCaptureOptions = {}) {
    identifier(access?.tenantId, "tenantId"); identifier(access?.agentId, "agentId");
    if (access.projectIds !== undefined && !Array.isArray(access.projectIds)) throw new AgentRunError("INVALID_INPUT", "projectIds must be an array.");
    this.tenantId = access.tenantId;
    this.agentId = access.agentId;
    this.projectIds = [...new Set(access.projectIds ?? [])];
    this.projectIds.forEach(id => identifier(id, "projectId"));
  }

  async startRun(input: StartAgentRunInput): Promise<AgentRun> {
    const request = jsonSnapshot(input);
    identifier(request?.runId, "runId"); identifier(request.taskId, "taskId"); nonblank(request.objective, "objective");
    if (request.sessionId !== undefined) identifier(request.sessionId, "sessionId");
    request.objective = redactText(request.objective, this.capture);
    nonblank(request.objective, "objective");
    if (request.scope !== undefined && request.scope?.kind !== "private" && request.scope?.kind !== "project") throw new AgentRunError("INVALID_INPUT", "Invalid run scope.");
    const projectId = request.scope?.kind === "project" ? request.scope.projectId : null;
    if (projectId !== null) {
      identifier(projectId, "projectId");
      if (!this.projectIds.includes(projectId)) throw new AgentRunError("ACCESS_DENIED", "Project access was not granted by the host application.");
    }
    const result = await this.sql.begin(async tx => {
      await tx`INSERT INTO mg_agent_identities (tenant_id,agent_id) VALUES (${this.tenantId},${this.agentId}) ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO mg_agent_runs (tenant_id,run_id,agent_id,task_id,objective,session_id,project_id)
        VALUES (${this.tenantId},${request.runId},${this.agentId},${request.taskId},${request.objective},${request.sessionId ?? null},${projectId})
        ON CONFLICT (tenant_id,run_id) DO NOTHING`;
      const row = await this.readRun(tx, request.runId, true);
      if (row.task_id !== request.taskId || row.objective !== request.objective || row.session_id !== (request.sessionId ?? null) || row.project_id !== projectId) {
        throw new AgentRunError("CONFLICT", "runId already exists with different start parameters.");
      }
      const event: AgentEventInput = { eventId: "$start", sequence: 0, occurredAt: row.created_at.toISOString(), data: { type: "task.started", objective: request.objective } };
      await tx`INSERT INTO mg_agent_events (tenant_id,run_id,event_id,sequence,event)
        VALUES (${this.tenantId},${request.runId},${event.eventId},0,${tx.json(event as unknown as JSONValue)}) ON CONFLICT DO NOTHING`;
      return this.toRun(row);
    });
    return result as AgentRun;
  }

  async getRun(runId: string): Promise<AgentRun> { return this.toRun(await this.readRun(this.sql, runId)); }

  async recordEvent(runId: string, input: AgentEventInput): Promise<AgentEvent> {
    const event = validateEvent(sanitizeEvent(validateEvent(input), this.capture));
    if (event.data.type.startsWith("task.") && event.data.type !== "task.milestone") throw new AgentRunError("INVALID_INPUT", "Use completeRun to record a terminal task event.");
    return await this.sql.begin(async tx => {
      const row = await this.readRun(tx, runId, true);
      return this.insertEvent(tx, row, event);
    }) as AgentEvent;
  }

  async listEvents(runId: string, options: { afterSequence?: number; limit?: number } = {}): Promise<AgentEvent[]> {
    const after = options.afterSequence ?? -1;
    const limit = options.limit ?? 100;
    if (!Number.isInteger(after) || after < -1 || after > 2147483647 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new AgentRunError("INVALID_INPUT", "afterSequence must be >= -1; limit must be between 1 and 1000.");
    }
    await this.readRun(this.sql, runId);
    const rows = await this.sql<EventRow[]>`SELECT event,received_at FROM mg_agent_events
      WHERE tenant_id=${this.tenantId} AND run_id=${runId} AND sequence>${after} ORDER BY sequence LIMIT ${limit}`;
    return rows.map(row => this.toEvent(runId, row));
  }

  interruptRun(runId: string): Promise<AgentRun> { return this.transition(runId, "running", "interrupted"); }
  resumeRun(runId: string): Promise<AgentRun> { return this.transition(runId, "interrupted", "running"); }

  async completeRun(runId: string, input: CompleteAgentRunInput): Promise<AgentRun> {
    const request = jsonSnapshot(input);
    if (!["succeeded", "failed", "cancelled"].includes(request?.outcome)) throw new AgentRunError("INVALID_INPUT", "Invalid completion outcome.");
    const event = validateEvent({ eventId: request.eventId, sequence: request.sequence, occurredAt: request.occurredAt,
      data: { type: request.outcome === "succeeded" ? "task.completed" : request.outcome === "failed" ? "task.failed" : "task.cancelled", summary: request.summary } });
    event.data = sanitizeEvent(event, this.capture).data;
    validateEvent(event);
    return await this.sql.begin(async tx => {
      const row = await this.readRun(tx, runId, true);
      // An identical terminal retry succeeds even after the run is sealed.
      if (await this.existingEvent(tx, runId, event)) return this.toRun(row);
      if (row.status !== "running") throw new AgentRunError("INVALID_STATE", "Resume an interrupted run before completing it; terminal runs are immutable.");
      const [history] = await tx<{ count: number; max: number }[]>`SELECT COUNT(*)::int AS count,MAX(sequence)::int AS max
        FROM mg_agent_events WHERE tenant_id=${this.tenantId} AND run_id=${runId}`;
      if (!history || history.count !== event.sequence || history.max !== event.sequence - 1) {
        throw new AgentRunError("INCOMPLETE_HISTORY", "Completion must follow a gap-free event sequence starting at zero.");
      }
      const unmatched = await tx`SELECT 1 FROM mg_agent_events result WHERE result.tenant_id=${this.tenantId} AND result.run_id=${runId}
        AND result.event->'data'->>'type'='tool.result' AND NOT EXISTS (
          SELECT 1 FROM mg_agent_events call WHERE call.tenant_id=result.tenant_id AND call.run_id=result.run_id
          AND call.event->'data'->>'type'='tool.call' AND call.event->'data'->>'toolCallId'=result.event->'data'->>'toolCallId'
          AND call.sequence<result.sequence) LIMIT 1`;
      if (unmatched.length) throw new AgentRunError("INCOMPLETE_HISTORY", "Every tool result must reference an earlier tool call.");
      if (request.outcome === "succeeded") {
        const pending = await tx`SELECT 1 FROM mg_agent_events call WHERE call.tenant_id=${this.tenantId} AND call.run_id=${runId}
          AND call.event->'data'->>'type'='tool.call' AND NOT EXISTS (
            SELECT 1 FROM mg_agent_events result WHERE result.tenant_id=call.tenant_id AND result.run_id=call.run_id
            AND result.event->'data'->>'type'='tool.result' AND result.event->'data'->>'toolCallId'=call.event->'data'->>'toolCallId') LIMIT 1`;
        if (pending.length) throw new AgentRunError("INCOMPLETE_HISTORY", "A successful run cannot have pending tool calls.");
      }
      await this.insertEvent(tx, row, event);
      const [updated] = await tx<RunRow[]>`UPDATE mg_agent_runs SET status=${request.outcome},updated_at=NOW()
        WHERE tenant_id=${this.tenantId} AND run_id=${runId} RETURNING *`;
      return this.toRun(updated!);
    }) as AgentRun;
  }

  private async transition(runId: string, from: AgentRunStatus, to: AgentRunStatus): Promise<AgentRun> {
    return await this.sql.begin(async tx => {
      const row = await this.readRun(tx, runId, true);
      if (row.status === to) return this.toRun(row);
      if (row.status !== from) throw new AgentRunError("INVALID_STATE", `Cannot change ${row.status} to ${to}.`);
      const [updated] = await tx<RunRow[]>`UPDATE mg_agent_runs SET status=${to},updated_at=NOW()
        WHERE tenant_id=${this.tenantId} AND run_id=${runId} RETURNING *`;
      return this.toRun(updated!);
    }) as AgentRun;
  }

  protected async readRun(sql: Connection, runId: string, write = false): Promise<RunRow> {
    identifier(runId, "runId");
    // Access is part of the query: hidden runs and absent runs have the same error.
    const rows = await sql<RunRow[]>`SELECT * FROM mg_agent_runs WHERE tenant_id=${this.tenantId} AND run_id=${runId}
      AND (agent_id=${this.agentId} OR project_id=ANY(${this.projectIds}::text[]))
      AND (project_id IS NULL OR project_id=ANY(${this.projectIds}::text[])) ${write ? sql`FOR UPDATE` : sql``}`;
    const row = rows[0];
    if (!row) throw new AgentRunError("NOT_FOUND", "Run not found or not accessible.");
    if (write && row.agent_id !== this.agentId) throw new AgentRunError("ACCESS_DENIED", "Only the owning agent can modify a run.");
    return row;
  }

  private async existingEvent(tx: TransactionSql, runId: string, event: AgentEventInput): Promise<AgentEvent | undefined> {
    const [existing] = await tx<(EventRow & { identical: boolean })[]>`SELECT event,received_at,event=${tx.json(event as unknown as JSONValue)}::jsonb AS identical
      FROM mg_agent_events WHERE tenant_id=${this.tenantId} AND run_id=${runId} AND (event_id=${event.eventId} OR sequence=${event.sequence})`;
    if (!existing) return undefined;
    if (!existing.identical) throw new AgentRunError("CONFLICT", "eventId or sequence already exists with different content.");
    return this.toEvent(runId, existing);
  }

  private async insertEvent(tx: TransactionSql, run: RunRow, event: AgentEventInput): Promise<AgentEvent> {
    const existing = await this.existingEvent(tx, run.run_id, event);
    if (existing) return existing;
    if (run.status !== "running") throw new AgentRunError("INVALID_STATE", "New events require a running run; resume interrupted runs first.");
    if (event.data.type === "tool.call" || event.data.type === "tool.result") {
      const duplicate = await tx`SELECT 1 FROM mg_agent_events WHERE tenant_id=${this.tenantId} AND run_id=${run.run_id}
        AND event->'data'->>'type'=${event.data.type} AND event->'data'->>'toolCallId'=${event.data.toolCallId} LIMIT 1`;
      if (duplicate.length) throw new AgentRunError("CONFLICT", "A tool call ID can have only one call and one result; use a new ID for a new attempt.");
    }
    const [saved] = await tx<EventRow[]>`INSERT INTO mg_agent_events (tenant_id,run_id,event_id,sequence,event)
      VALUES (${this.tenantId},${run.run_id},${event.eventId},${event.sequence},${tx.json(event as unknown as JSONValue)}) RETURNING event,received_at`;
    await tx`UPDATE mg_agent_runs SET updated_at=NOW() WHERE tenant_id=${this.tenantId} AND run_id=${run.run_id}`;
    return this.toEvent(run.run_id, saved!);
  }

  protected toRun(row: RunRow): AgentRun {
    return { runId: row.run_id, agentId: row.agent_id, taskId: row.task_id, objective: row.objective, sessionId: row.session_id,
      scope: row.project_id === null ? { kind: "private" } : { kind: "project", projectId: row.project_id },
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private toEvent(runId: string, row: EventRow): AgentEvent { return { ...row.event, runId, receivedAt: row.received_at }; }
}
