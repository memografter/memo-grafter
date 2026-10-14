import { createHash } from "node:crypto";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import type { MemoryNode } from "../../core/types.js";
import { AgentRunError, type AgentEvent, type AgentRunAccess, type AgentRunAPI } from "../../agents/runs/types.js";
import type { AgentDurableMemory, AgentMemoryAPI, AgentMemoryEvidence, AgentMemoryOptions, AgentTaskEpisode, AgentWorkingState,
  AgentWorkingStateSnapshot, PreparedAgentEpisode } from "../../agents/runs/memoryTypes.js";
import { jsonSnapshot, nonblank } from "../../agents/runs/validation.js";
import { redactText, redactValue } from "../../agents/runs/redaction.js";
import { prepareAgentEpisode } from "../../ingestion/agent/AgentEpisodeProcessor.js";
import { PostgresAgentRunStore } from "./AgentRunStore.js";

export interface AgentGraphPersistence {
  commit(tx: TransactionSql, prepared: PreparedAgentEpisode, sessionId: string): Promise<{ episodeId: string; memoryIds: string[] }>;
  readMemories(ids: string[]): Promise<MemoryNode[]>;
  forget(id: string): Promise<boolean>;
  suppress(id: string): Promise<boolean>;
  restore(id: string): Promise<boolean>;
}

export class PostgresAgentMemoryStore extends PostgresAgentRunStore implements AgentRunAPI, AgentMemoryAPI {
  constructor(sql: Sql, access: AgentRunAccess, private readonly graph: AgentGraphPersistence, private readonly options: AgentMemoryOptions = {}) {
    super(sql, access, options);
  }

  async getWorkingState(runId: string): Promise<AgentWorkingStateSnapshot | null> {
    await this.readRun(this.sql, runId);
    const [row] = await this.sql<{ revision: number; state: AgentWorkingState; updated_at: Date }[]>`SELECT revision,state,updated_at
      FROM mg_agent_working_state WHERE tenant_id=${this.tenantId} AND run_id=${runId}`;
    return row ? { revision: row.revision, state: row.state, updatedAt: row.updated_at } : null;
  }

  async updateWorkingState(runId: string, input: { expectedRevision: number; state: AgentWorkingState }): Promise<AgentWorkingStateSnapshot> {
    const request = jsonSnapshot(input);
    if (!Number.isInteger(request?.expectedRevision) || request.expectedRevision < 0 || request.expectedRevision >= 2147483647) throw new AgentRunError("INVALID_INPUT", "expectedRevision must be a nonnegative integer.");
    const state = redactValue(request.state as unknown as import("../../agents/runs/types.js").JsonValue, this.options) as unknown as AgentWorkingState;
    nonblank(state?.objective, "objective");
    if (state.currentStep !== null) nonblank(state.currentStep, "currentStep");
    for (const list of [state.pendingActions, state.blockers]) {
      if (!Array.isArray(list) || list.length > 100) throw new AgentRunError("INVALID_INPUT", "Working state lists must have at most 100 entries.");
      list.forEach(value => nonblank(value, "working state entry"));
    }
    jsonSnapshot(state);
    return await this.sql.begin(async tx => {
      const run = await this.readRun(tx, runId, true);
      const [existing] = await tx<{ revision: number; state: AgentWorkingState; updated_at: Date; identical: boolean }[]>`SELECT *,state=${tx.json(state as unknown as JSONValue)}::jsonb AS identical
        FROM mg_agent_working_state WHERE tenant_id=${this.tenantId} AND run_id=${runId}`;
      if (existing?.revision === request.expectedRevision + 1 && existing.identical) return { revision: existing.revision, state: existing.state, updatedAt: existing.updated_at };
      if (!["running", "interrupted"].includes(run.status)) throw new AgentRunError("INVALID_STATE", "Terminal working state is immutable.");
      if ((existing?.revision ?? 0) !== request.expectedRevision) throw new AgentRunError("CONFLICT", "Working state revision changed; reload before updating.");
      const [saved] = await tx<{ revision: number; state: AgentWorkingState; updated_at: Date }[]>`INSERT INTO mg_agent_working_state (tenant_id,run_id,revision,state)
        VALUES (${this.tenantId},${runId},${request.expectedRevision + 1},${tx.json(state as unknown as JSONValue)})
        ON CONFLICT (tenant_id,run_id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,updated_at=clock_timestamp() RETURNING *`;
      return { revision: saved!.revision, state: saved!.state, updatedAt: saved!.updated_at };
    }) as AgentWorkingStateSnapshot;
  }

  async processRun(runId: string, options: { throughSequence?: number } = {}): Promise<AgentTaskEpisode[]> {
    const row = await this.readRun(this.sql, runId, true);
    const run = this.toRun(row);
    const end = options.throughSequence;
    if (end !== undefined && (!Number.isInteger(end) || end < 1 || end > 2147483647)) throw new AgentRunError("INVALID_INPUT", "throughSequence must be a positive integer.");
    if (end === undefined && ["running", "interrupted"].includes(run.status)) throw new AgentRunError("INVALID_STATE", "Complete the run or provide throughSequence ending at task.milestone.");
    const rows = await this.sql<{ event: AgentEvent; received_at: Date }[]>`SELECT event,received_at FROM mg_agent_events
      WHERE tenant_id=${this.tenantId} AND run_id=${runId} ${end === undefined ? this.sql`` : this.sql`AND sequence<=${end}`}
      ORDER BY sequence LIMIT 10001`;
    if (rows.length > 10000) throw new AgentRunError("INVALID_INPUT", "Run exceeds the 10000-event processing limit.");
    const events: AgentEvent[] = rows.map(item => ({ ...item.event, runId, receivedAt: item.received_at }));
    if (!events.length || events.some((event, i) => event.sequence !== i) || (end !== undefined && events.at(-1)?.sequence !== end)) throw new AgentRunError("INCOMPLETE_HISTORY", "Processing requires a contiguous event prefix from zero.");
    const last = events.at(-1)!;
    if (!["task.milestone", "task.completed", "task.failed", "task.cancelled"].includes(last.data.type)) throw new AgentRunError("INVALID_STATE", "Episode must end at a milestone or terminal task event.");
    const committed = await this.listEpisodes(runId);
    let start = 0;
    const pending = new Set<string>();
    for (const event of events) {
      if (event.data.type === "tool.call") pending.add(event.data.toolCallId);
      if (event.data.type === "tool.result") {
        if (!pending.delete(event.data.toolCallId)) throw new AgentRunError("INCOMPLETE_HISTORY", "Every tool result must reference an earlier tool call.");
      }
      if (!["task.milestone", "task.completed", "task.failed", "task.cancelled"].includes(event.data.type)) continue;
      // Keep a call and its result in the same episode, even if a milestone was emitted between them.
      if (event.data.type === "task.milestone" && pending.size) {
        if (event.sequence === last.sequence) throw new AgentRunError("INCOMPLETE_HISTORY", "Milestone has pending tool calls; process a later boundary after their results arrive.");
        continue;
      }
      const slice = events.slice(start, event.sequence + 1);
      if (!committed.some(episode => episode.endSequence === event.sequence)) {
        const prepared = await prepareAgentEpisode(run, slice, this.options);
        await this.commitEpisode(prepared);
      }
      start = event.sequence + 1;
    }
    return (await this.listEpisodes(runId)).filter(episode => episode.endSequence <= last.sequence);
  }

  async listEpisodes(runId: string): Promise<AgentTaskEpisode[]> {
    await this.readRun(this.sql, runId);
    const rows = await this.sql<{ episode_id: string; start_sequence: number; end_sequence: number; summary: string; outcome: string; rejected_candidates: number; memory_ids: string[] }[]>`
      SELECT l.*,e.summary,e.outcome,ARRAY(SELECT memory_id::text FROM mg_agent_memory_links m WHERE m.episode_id=l.episode_id ORDER BY memory_id) AS memory_ids
      FROM mg_agent_episode_links l JOIN mg_episodes e ON e.id=l.episode_id WHERE l.tenant_id=${this.tenantId} AND l.run_id=${runId} ORDER BY l.start_sequence`;
    return rows.map(row => ({ id: row.episode_id, runId, startSequence: row.start_sequence, endSequence: row.end_sequence,
      summary: row.summary, reportedOutcome: row.outcome, rejectedCandidates: row.rejected_candidates, memoryIds: row.memory_ids }));
  }

  async listMemories(options: { runId?: string; includeInactive?: boolean; limit?: number } = {}): Promise<AgentDurableMemory[]> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new AgentRunError("INVALID_INPUT", "limit must be from 1 to 1000.");
    if (options.runId !== undefined) await this.readRun(this.sql, options.runId);
    const ids = await this.sql<{ memory_id: string }[]>`SELECT DISTINCT l.memory_id FROM mg_agent_memory_links l
      JOIN mg_agent_runs r ON r.tenant_id=l.tenant_id AND r.run_id=l.run_id
      JOIN mg_memory_nodes m ON m.id=l.memory_id JOIN mg_topic_nodes t ON t.id=m.topic_node_id
      JOIN mg_episodes e ON e.id=l.episode_id JOIN mg_topic_nodes et ON et.id=e.topic_id
      WHERE r.tenant_id=${this.tenantId} AND (r.agent_id=${this.agentId} OR r.project_id=ANY(${this.projectIds}::text[]))
      AND (r.project_id IS NULL OR r.project_id=ANY(${this.projectIds}::text[]))
      ${options.runId === undefined ? this.sql`` : this.sql`AND r.run_id=${options.runId}`}
      ${options.includeInactive ? this.sql`` : this.sql`AND m.forgotten=FALSE AND m.decayed=FALSE AND m.superseded_by IS NULL AND m.has_conflict=FALSE AND t.suppressed=FALSE AND et.suppressed=FALSE`}
      ORDER BY l.memory_id LIMIT ${limit}`;
    if (!ids.length) return [];
    const memoryIds = ids.map(row => row.memory_id);
    const evidence = await this.sql<{ memory_id: string; run_id: string; episode_id: string; kind: AgentMemoryEvidence["kind"]; basis: AgentMemoryEvidence["basis"]; conditions: string[]; event_ids: string[]; artifact_uris: string[] }[]>`
      SELECT l.* FROM mg_agent_memory_links l JOIN mg_agent_runs r ON r.tenant_id=l.tenant_id AND r.run_id=l.run_id
      WHERE l.memory_id=ANY(${memoryIds}::uuid[]) AND r.tenant_id=${this.tenantId}
      AND (r.agent_id=${this.agentId} OR r.project_id=ANY(${this.projectIds}::text[])) AND (r.project_id IS NULL OR r.project_id=ANY(${this.projectIds}::text[])) ORDER BY l.run_id,l.episode_id`;
    return (await this.graph.readMemories(memoryIds)).map(memory => ({ memory, evidence: evidence.filter(row => row.memory_id === memory.id).map(row => ({
      runId: row.run_id, episodeId: row.episode_id, kind: row.kind, basis: row.basis, conditions: row.conditions, eventIds: row.event_ids, artifactUris: row.artifact_uris,
    })) }));
  }

  async forgetAgentMemory(memoryId: string): Promise<boolean> {
    await this.authorizeMemoryMutation(memoryId);
    return this.graph.forget(memoryId);
  }
  suppressEpisode(episodeId: string): Promise<boolean> { return this.setEpisodeSuppressed(episodeId, true); }
  restoreEpisode(episodeId: string): Promise<boolean> { return this.setEpisodeSuppressed(episodeId, false); }

  private async authorizeMemoryMutation(memoryId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(memoryId)) throw new AgentRunError("INVALID_INPUT", "Invalid memory ID.");
    const [link] = await this.sql<{ run_id: string }[]>`SELECT run_id FROM mg_agent_memory_links WHERE tenant_id=${this.tenantId} AND memory_id=${memoryId}::uuid LIMIT 1`;
    if (!link) throw new AgentRunError("NOT_FOUND", "Memory not found or not accessible.");
    await this.readRun(this.sql, link.run_id, true);
  }
  private async setEpisodeSuppressed(episodeId: string, suppressed: boolean): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(episodeId)) throw new AgentRunError("INVALID_INPUT", "Invalid episode ID.");
    const [link] = await this.sql<{ run_id: string; topic_id: string }[]>`SELECT l.run_id,e.topic_id FROM mg_agent_episode_links l
      JOIN mg_episodes e ON e.id=l.episode_id WHERE l.tenant_id=${this.tenantId} AND l.episode_id=${episodeId}::uuid`;
    if (!link) throw new AgentRunError("NOT_FOUND", "Episode not found or not accessible.");
    await this.readRun(this.sql, link.run_id, true);
    return suppressed ? this.graph.suppress(link.topic_id) : this.graph.restore(link.topic_id);
  }

  private async commitEpisode(prepared: PreparedAgentEpisode): Promise<void> {
    const first = prepared.events[0]!; const last = prepared.events.at(-1)!;
    const sessionId = `agent-memory:${createHash("sha256").update(JSON.stringify([this.tenantId, this.agentId, prepared.run.scope])).digest("hex")}`;
    await this.sql.begin(async tx => {
      await this.readRun(tx, prepared.run.runId, true);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`memo-grafter-session:${sessionId}`}))`;
      const existing = await tx`SELECT 1 FROM mg_agent_episode_links WHERE tenant_id=${this.tenantId} AND run_id=${prepared.run.runId} AND end_sequence=${last.sequence}`;
      if (existing.length) return;
      const [cursor] = await tx<{ end_sequence: number | null }[]>`SELECT MAX(end_sequence) AS end_sequence FROM mg_agent_episode_links WHERE tenant_id=${this.tenantId} AND run_id=${prepared.run.runId}`;
      if ((cursor?.end_sequence ?? -1) + 1 !== first.sequence) throw new AgentRunError("CONFLICT", "Episode cursor changed; retry processRun.");
      const saved = await this.graph.commit(tx, prepared, sessionId);
      await tx`INSERT INTO mg_agent_episode_links (tenant_id,run_id,start_sequence,end_sequence,episode_id,graph_session_id,rejected_candidates)
        VALUES (${this.tenantId},${prepared.run.runId},${first.sequence},${last.sequence},${saved.episodeId}::uuid,${sessionId},${prepared.rejectedCandidates})`;
      for (const [index, memory] of prepared.memories.entries()) {
        const c = memory.candidate;
        const artifacts = prepared.events.filter(event => c.evidenceEventIds.includes(event.eventId)).flatMap(event => [
          ...(event.data.type === "artifact" ? [event.data.uri] : []), ...(event.source ? [event.source.uri] : []),
        ]).map(uri => redactText(uri, this.options));
        await tx`INSERT INTO mg_agent_memory_links (tenant_id,run_id,episode_id,memory_id,kind,basis,conditions,event_ids,artifact_uris)
          VALUES (${this.tenantId},${prepared.run.runId},${saved.episodeId}::uuid,${saved.memoryIds[index]!}::uuid,${c.kind},${c.basis},${c.conditions},${c.evidenceEventIds},${artifacts})
          ON CONFLICT (tenant_id,run_id,episode_id,memory_id) DO UPDATE SET
            event_ids=ARRAY(SELECT DISTINCT unnest(mg_agent_memory_links.event_ids || EXCLUDED.event_ids)),
            artifact_uris=ARRAY(SELECT DISTINCT unnest(mg_agent_memory_links.artifact_uris || EXCLUDED.artifact_uris))`;
      }
    });
  }
}
