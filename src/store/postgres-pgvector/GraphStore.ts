import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { FleetAgentRecord, GraphStore } from "../GraphStore.js";
import type { DatabaseQueryOperation, MemoGrafterDatabaseTelemetry } from "../../core/types.js";
import type { GraftRegistryEntry, GraftTopicsRequest, GraftTopicsResult, MemoryDiff, MemoryDiffField, MemoryEdge, MemoryHistoryEntry, MemoryHistoryOptions, MemoryHistoryResult, MemoryHistoryStatus, MemoryNode, MemoryNodeInsert, Message, SessionIngestState, TagFilterOptions, TopicEdge, TopicNode, TopicSegment } from "../../core/types.js";
import {
  memoGrafterCurrentMigrationVersion,
  memoGrafterExtensionNames,
  memoGrafterIndexNames,
  memoGrafterMigrationTableName,
  memoGrafterTableNames,
  type MigrationReport,
} from "../../schema/index.js";
import { cosineSimilarity } from "../../utils/drift/cosineSimilarity.js";
import { normalizeTags } from "../../utils/tags.js";
import { parseVector, toVectorLiteral } from "../../utils/vector/vectorLiteral.js";
import type { AcceptIngestionRequest, IngestionRun, IngestionTransition, PreparedIngestion, ReconciliationIssue } from "../../ingestion/types.js";
import { MemoGrafterError } from "../../diagnostics.js";
import { assertIngestionTransition } from "../../ingestion/stateMachine.js";

interface TopicNodeRow {
  id: string;
  session_id: string;
  segment_id: string;
  label: string | null;
  summary: string | null;
  embedding: string | number[] | null;
  tags: string[] | null;
  source: string | null;
  message_range: number[] | null;
  topic_order: number | null;
  drift_score: number | null;
  agent_color: string | null;
  fleet_id: string | null;
  agent_id: string | null;
  suppressed: boolean | null;
  suppressed_at: Date | null;
  pinned: boolean | null;
  pinned_at: Date | null;
  created_at: Date;
}

interface TopicSegmentRow {
  id: string;
  session_id: string;
  start_index: number;
  end_index: number;
  topic_order: number;
  drift_score: number;
  created_at: Date;
}

interface MemoryNodeRow {
  id: string;
  segment_id: string;
  topic_node_id: string;
  agent_id: string | null;
  session_id: string;
  memory_type: MemoryNode["memoryType"];
  source_type: MemoryNode["sourceType"];
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  embedding: string | number[] | null;
  tags: string[] | null;
  source: string | null;
  source_url: string | null;
  source_title: string | null;
  provenance_speaker: NonNullable<MemoryNode["provenance"]>["speaker"] | null;
  provenance_message_indexes: number[] | null;
  provenance_session_id: string | null;
  extraction_method: NonNullable<MemoryNode["provenance"]>["extractionMethod"] | null;
  superseded_by: string | null;
  decayed: boolean;
  forgotten: boolean | null;
  forgotten_at: Date | null;
  has_conflict: boolean | null;
  agent_color: string | null;
  fleet_id: string | null;
  created_at: Date;
}

interface MessageRow {
  session_id: string;
  message_index: number;
  role: "user" | "assistant";
  content: string;
}

interface SessionIngestStateRow {
  session_id: string;
  last_ingested_message_index: number;
  updated_at: Date;
}

interface IngestionRunRow {
  id: string; session_id: string; kind: IngestionRun["kind"]; start_index: number; end_index: number;
  idempotency_key: string | null; status: IngestionRun["status"]; attempt_count: number;
  queued_at: Date | null; started_at: Date | null; completed_at: Date | null; failed_at: Date | null;
  lease_expires_at: Date | null; heartbeat_at: Date | null; last_error_code: IngestionRun["lastErrorCode"] | null;
  last_error_stage: IngestionRun["lastErrorStage"] | null; last_error_safe_message: string | null;
  retryable: boolean | null; worker_id: string | null; created_at: Date; updated_at: Date;
}

interface EdgeRow {
  src_id: string;
  dst_id: string;
  weight: number;
  type: string;
}

interface MemoryEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: MemoryEdge["edgeType"];
  weight: number | null;
  created_at: Date;
}

interface GraftRegistryRow {
  id: string;
  session_id: string;
  node_id: string;
  source_session_id: string;
  source_node_id: string;
  grafted_at: Date;
}

interface AbsorbOptions {
  agentColor?: string | null;
  fleetId?: string | null;
  agentId?: string | null;
}

export function classifyDatabaseQuery(query: string): DatabaseQueryOperation {
  const normalized = query.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "").trimStart().toUpperCase();
  if (/^(SELECT|SHOW|EXPLAIN)\b/.test(normalized)) return "read";
  if (/^(INSERT|UPDATE|DELETE|MERGE)\b/.test(normalized)) return "write";
  if (/^WITH\b/.test(normalized)) {
    return /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(normalized) ? "write" : "read";
  }
  return "other";
}

export function safelyReportDatabaseQuery(
  telemetry: MemoGrafterDatabaseTelemetry | undefined,
  operation: DatabaseQueryOperation,
): void {
  try {
    telemetry?.onQuery?.({ operation });
  } catch {
    // Observability must never affect database behavior.
  }
}

export class PostgresGraphStore implements GraphStore {
  private readonly sql: Sql;

  constructor(connectionString: string, options: { telemetry?: MemoGrafterDatabaseTelemetry } = {}) {
    this.sql = postgres(connectionString, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => undefined,
      ...(options.telemetry?.onQuery
        ? {
          debug: (_connection: number, query: string) => {
            safelyReportDatabaseQuery(options.telemetry, classifyDatabaseQuery(query));
          },
        }
        : {}),
    });
  }

  async initialize(): Promise<void> {
    await this.verifySchema();
  }

  async verifySchema(): Promise<void> {
    const [extensions, tables] = await Promise.all([
      this.getExistingExtensions(memoGrafterExtensionNames),
      this.getExistingTables(memoGrafterTableNames),
    ]);
    const missingExtensions = memoGrafterExtensionNames.filter((name) => !extensions.has(name));
    const missingTables = memoGrafterTableNames.filter((name) => !tables.has(name));

    if (missingExtensions.length === 0 && missingTables.length === 0) {
      return;
    }

    const missing = [
      ...missingExtensions.map((name) => `extension ${name}`),
      ...missingTables.map((name) => `table ${name}`),
    ].join(", ");
    throw new Error(
      `MemoGrafter database schema is not initialized. Missing ${missing}. `
      + "Run: npx memo-grafter init, then npx memo-grafter migrate --db <connection-string>",
    );
  }

  async migrate(): Promise<MigrationReport> {
    const existingExtensions = await this.getExistingExtensions(memoGrafterExtensionNames);
    const existingTables = await this.getExistingTables(memoGrafterTableNames);
    const existingIndexes = await this.getExistingIndexes(memoGrafterIndexNames);

    await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await this.sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_message_buffer (
        session_id    TEXT NOT NULL,
        message_index INT NOT NULL,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        PRIMARY KEY (session_id, message_index)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_segments (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        start_index INT NOT NULL,
        end_index   INT NOT NULL,
        topic_order INT NOT NULL,
        drift_score FLOAT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (session_id, start_index, end_index)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_topic_nodes (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        segment_id    TEXT NOT NULL REFERENCES mg_segments(id) ON DELETE CASCADE,
        label         TEXT,
        summary       TEXT,
        embedding     vector(1536),
        tags          TEXT[] NOT NULL DEFAULT '{}',
        source        TEXT,
        message_range INT[],
        topic_order   INT NOT NULL DEFAULT 0,
        drift_score   FLOAT NOT NULL DEFAULT 0,
        agent_color   TEXT,
        fleet_id      TEXT,
        agent_id      TEXT,
        suppressed    BOOLEAN NOT NULL DEFAULT FALSE,
        suppressed_at TIMESTAMPTZ,
        pinned        BOOLEAN NOT NULL DEFAULT FALSE,
        pinned_at     TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (segment_id)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_topic_edges (
        src_id  TEXT NOT NULL,
        dst_id  TEXT NOT NULL,
        weight  FLOAT NOT NULL,
        type    TEXT NOT NULL,
        PRIMARY KEY (src_id, dst_id)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_memory_nodes (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        segment_id    TEXT NOT NULL REFERENCES mg_segments(id) ON DELETE CASCADE,
        topic_node_id TEXT NOT NULL REFERENCES mg_topic_nodes(id) ON DELETE CASCADE,
        agent_id      TEXT,
        session_id    TEXT NOT NULL,
        memory_type   TEXT NOT NULL CHECK (memory_type IN ('fact','insight','question','task','reference')),
        source_type   TEXT NOT NULL DEFAULT 'conversation' CHECK (source_type IN ('conversation','note','document','code')),
        subject       TEXT NOT NULL,
        predicate     TEXT NOT NULL,
        value         TEXT NOT NULL,
        confidence    FLOAT NOT NULL DEFAULT 1.0,
        embedding     vector(1536),
        tags          TEXT[] NOT NULL DEFAULT '{}',
        source        TEXT,
        source_url    TEXT,
        source_title  TEXT,
        provenance_speaker TEXT CHECK (provenance_speaker IN ('user','assistant','system','document')),
        provenance_message_indexes INT[],
        provenance_session_id TEXT,
        extraction_method TEXT CHECK (extraction_method IN ('explicit','inferred','user-confirmed','document-extraction')),
        superseded_by UUID REFERENCES mg_memory_nodes(id),
        decayed       BOOLEAN NOT NULL DEFAULT FALSE,
        forgotten     BOOLEAN NOT NULL DEFAULT FALSE,
        forgotten_at  TIMESTAMPTZ,
        has_conflict  BOOLEAN NOT NULL DEFAULT FALSE,
        agent_color   TEXT,
        fleet_id      TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      ALTER TABLE mg_topic_nodes
      ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'
    `;

    await this.sql`
      ALTER TABLE mg_memory_nodes
      ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'
    `;

    await this.sql`
      ALTER TABLE mg_memory_nodes
      ADD COLUMN IF NOT EXISTS has_conflict BOOLEAN NOT NULL DEFAULT FALSE
    `;

    await this.sql`
      ALTER TABLE mg_memory_nodes
      ADD COLUMN IF NOT EXISTS forgotten BOOLEAN NOT NULL DEFAULT FALSE
    `;

    await this.sql`
      ALTER TABLE mg_memory_nodes
      ADD COLUMN IF NOT EXISTS forgotten_at TIMESTAMPTZ
    `;

    await this.sql`
      ALTER TABLE mg_topic_nodes
      ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT FALSE
    `;

    await this.sql`
      ALTER TABLE mg_topic_nodes
      ADD COLUMN IF NOT EXISTS suppressed_at TIMESTAMPTZ
    `;

    await this.sql`ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`;
    await this.sql`ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`;

    await this.sql`
      ALTER TABLE mg_topic_nodes
      ADD COLUMN IF NOT EXISTS source TEXT
    `;

    await this.sql`
      ALTER TABLE mg_memory_nodes
      ADD COLUMN IF NOT EXISTS source TEXT
    `;
    await this.sql`ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS provenance_speaker TEXT`;
    await this.sql`ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS provenance_message_indexes INT[]`;
    await this.sql`ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS provenance_session_id TEXT`;
    await this.sql`ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS extraction_method TEXT`;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_memory_edges (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id  UUID NOT NULL REFERENCES mg_memory_nodes(id) ON DELETE CASCADE,
        target_id  UUID NOT NULL REFERENCES mg_memory_nodes(id) ON DELETE CASCADE,
        edge_type  TEXT NOT NULL CHECK (edge_type IN ('semantic','conflicts','updates','related')),
        weight     FLOAT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_fleets (
        id         TEXT PRIMARY KEY,
        name       TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_fleet_agents (
        id          TEXT PRIMARY KEY,
        fleet_id    TEXT NOT NULL REFERENCES mg_fleets(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        agent_color TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (fleet_id, agent_color)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_sessions (
        session_id  TEXT PRIMARY KEY,
        label       TEXT,
        description TEXT,
        tags        TEXT[] NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_session_ingest_state (
        session_id                  TEXT PRIMARY KEY,
        last_ingested_message_index INT NOT NULL DEFAULT -1,
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_ingestion_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id TEXT NOT NULL, kind TEXT NOT NULL,
        start_index INT NOT NULL CHECK (start_index >= 0), end_index INT NOT NULL CHECK (end_index >= start_index),
        idempotency_key TEXT, status TEXT NOT NULL CHECK (status IN ('accepted','queued','running','retry_pending','completed','completed_with_warnings','failed','cancelled','abandoned')),
        attempt_count INT NOT NULL DEFAULT 0, queued_at TIMESTAMPTZ, started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ, failed_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ, last_error_code TEXT, last_error_stage TEXT,
        last_error_safe_message TEXT, retryable BOOLEAN, worker_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (session_id, start_index, end_index, kind)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS mg_graft_registry (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id        TEXT NOT NULL,
        node_id           TEXT NOT NULL REFERENCES mg_topic_nodes(id) ON DELETE CASCADE,
        source_session_id TEXT NOT NULL,
        source_node_id    TEXT NOT NULL,
        grafted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.migrateExistingNodeTable();
    await this.createIndexes();
    await this.sql`
      CREATE TABLE IF NOT EXISTS ${this.sql(memoGrafterMigrationTableName)} (
        version    INT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await this.sql`
      INSERT INTO ${this.sql(memoGrafterMigrationTableName)} (version)
      VALUES (${memoGrafterCurrentMigrationVersion})
      ON CONFLICT (version) DO NOTHING
    `;

    return {
      extensions: memoGrafterExtensionNames.map((name) => ({
        name,
        status: existingExtensions.has(name) ? "exists" : "created",
      })),
      tables: memoGrafterTableNames.map((name) => ({
        name,
        status: existingTables.has(name) ? "exists" : "created",
      })),
      indexes: memoGrafterIndexNames.map((name) => ({
        name,
        status: existingIndexes.has(name) ? "exists" : "created",
      })),
    };
  }

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.saveMessagesAt(sessionId, 0, messages);
  }

  async saveMessagesAt(sessionId: string, startIndex: number, messages: Message[]): Promise<void> {
    for (const [index, message] of messages.entries()) {
      await this.sql`
        INSERT INTO mg_message_buffer (session_id, message_index, role, content)
        VALUES (${sessionId}, ${startIndex + index}, ${message.role}, ${message.content})
        ON CONFLICT (session_id, message_index)
        DO UPDATE SET role = EXCLUDED.role, content = EXCLUDED.content
      `;
    }
  }

  async appendMessages(
    sessionId: string,
    messages: Message[],
  ): Promise<{ startIndex: number; endIndex: number }> {
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`memo-grafter-session:${sessionId}`}))`;
      const rows = await transaction<{ start_index: number }[]>`
        SELECT COALESCE(MAX(message_index), -1)::int + 1 AS start_index
        FROM mg_message_buffer
        WHERE session_id = ${sessionId}
      `;
      const startIndex = rows[0]?.start_index ?? 0;

      for (const [offset, message] of messages.entries()) {
        await transaction`
          INSERT INTO mg_message_buffer (session_id, message_index, role, content)
          VALUES (${sessionId}, ${startIndex + offset}, ${message.role}, ${message.content})
        `;
      }

      return {
        startIndex,
        endIndex: startIndex + messages.length - 1,
      };
    });
  }

  async acceptIngestionRun(request: AcceptIngestionRequest): Promise<IngestionRun> {
    if (request.messages.length === 0) throw new MemoGrafterError("Cannot accept an empty ingestion run.", { code: "INPUT_INVALID", operation: "analyze", context: { field: "messages" } });
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`memo-grafter-session:${request.sessionId}`}))`;
      if (request.idempotencyKey) {
        const existing = await transaction<IngestionRunRow[]>`SELECT * FROM mg_ingestion_runs WHERE session_id = ${request.sessionId} AND idempotency_key = ${request.idempotencyKey} LIMIT 1`;
        if (existing[0]) {
          const buffered = await transaction<MessageRow[]>`SELECT * FROM mg_message_buffer WHERE session_id = ${request.sessionId} AND message_index BETWEEN ${existing[0].start_index} AND ${existing[0].end_index} ORDER BY message_index`;
          const identical = buffered.length === request.messages.length && buffered.every((row, index) => row.role === request.messages[index]?.role && row.content === request.messages[index]?.content);
          if (!identical || existing[0].kind !== request.kind) throw this.ingestionInvariant("An idempotency key was reused with different ingestion input.", request.sessionId, existing[0].id);
          return this.rowToIngestionRun(existing[0]);
        }
      }
      const rangeRows = await transaction<{ start_index: number }[]>`SELECT COALESCE(MAX(message_index), -1)::int + 1 AS start_index FROM mg_message_buffer WHERE session_id = ${request.sessionId}`;
      const startIndex = rangeRows[0]?.start_index ?? 0;
      for (const [offset, message] of request.messages.entries()) {
        await transaction`INSERT INTO mg_message_buffer (session_id, message_index, role, content) VALUES (${request.sessionId}, ${startIndex + offset}, ${message.role}, ${message.content})`;
      }
      const rows = await transaction<IngestionRunRow[]>`
        INSERT INTO mg_ingestion_runs (session_id, kind, start_index, end_index, idempotency_key, status)
        VALUES (${request.sessionId}, ${request.kind}, ${startIndex}, ${startIndex + request.messages.length - 1}, ${request.idempotencyKey ?? null}, 'accepted') RETURNING *`;
      if (!rows[0]) throw this.ingestionInvariant("Accepted ingestion run was not returned.", request.sessionId);
      return this.rowToIngestionRun(rows[0]);
    });
  }

  async getIngestionRun(runId: string): Promise<IngestionRun | null> {
    const rows = await this.sql<IngestionRunRow[]>`SELECT * FROM mg_ingestion_runs WHERE id = ${runId} LIMIT 1`;
    return rows[0] ? this.rowToIngestionRun(rows[0]) : null;
  }

  async listIngestionRuns(sessionId?: string, statuses?: IngestionRun["status"][]): Promise<IngestionRun[]> {
    const rows = await this.sql<IngestionRunRow[]>`SELECT * FROM mg_ingestion_runs WHERE TRUE
      ${sessionId === undefined ? this.sql`` : this.sql`AND session_id = ${sessionId}`}
      ${!statuses?.length ? this.sql`` : this.sql`AND status = ANY(${statuses})`}
      ORDER BY created_at`;
    return rows.map((row) => this.rowToIngestionRun(row));
  }

  async countActiveIngestionRuns(): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM mg_ingestion_runs WHERE status IN ('accepted','queued','running','retry_pending')`;
    return rows[0]?.count ?? 0;
  }

  async inspectIngestionConsistency(sessionId?: string): Promise<ReconciliationIssue[]> {
    const issues: ReconciliationIssue[] = [];
    const runs = await this.listIngestionRuns(sessionId);
    const now = Date.now();
    for (const run of runs) {
      if (run.status === "accepted") issues.push({ code: "accepted-not-started", severity: "warning", sessionId: run.sessionId, runId: run.id, message: "Accepted ingestion has not started.", repairable: true });
      if (run.status === "running" && run.leaseExpiresAt && run.leaseExpiresAt.getTime() < now) issues.push({ code: "expired-worker-lease", severity: "error", sessionId: run.sessionId, runId: run.id, message: "Running ingestion worker lease expired.", repairable: true });
      if ((run.status === "failed" && run.retryable) || run.status === "retry_pending") issues.push({ code: "retryable-failure", severity: "warning", sessionId: run.sessionId, runId: run.id, message: "Ingestion can be retried safely.", repairable: true });
    }
    const cursorRows = await this.sql<{ session_id: string; cursor: number; max_index: number }[]>`SELECT b.session_id, COALESCE(s.last_ingested_message_index,-1)::int AS cursor, MAX(b.message_index)::int AS max_index FROM mg_message_buffer b LEFT JOIN mg_session_ingest_state s ON s.session_id=b.session_id WHERE TRUE ${sessionId === undefined ? this.sql`` : this.sql`AND b.session_id=${sessionId}`} GROUP BY b.session_id,s.last_ingested_message_index`;
    for (const row of cursorRows) {
      if (row.cursor < row.max_index && !runs.some((run) => run.sessionId === row.session_id && ["accepted","queued","running","retry_pending"].includes(run.status))) issues.push({ code: "cursor-behind-buffer", severity: "warning", sessionId: row.session_id, message: "Cursor is behind durable messages without a pending run.", repairable: false });
      if (row.cursor > row.max_index) issues.push({ code: "cursor-ahead-of-buffer", severity: "error", sessionId: row.session_id, message: "Cursor is ahead of the durable message buffer.", repairable: false });
    }
    const cursorBySession = new Map(cursorRows.map((row) => [row.session_id, row.cursor]));
    for (const run of runs) if (["completed", "completed_with_warnings"].includes(run.status) && (cursorBySession.get(run.sessionId) ?? -1) < run.endIndex) issues.push({ code: "completed-cursor-behind", severity: "error", sessionId: run.sessionId, runId: run.id, message: "Completed run is not covered by the ingestion cursor.", repairable: false });
    const orphanTopics = await this.sql<{ session_id: string }[]>`SELECT DISTINCT n.session_id FROM mg_topic_nodes n LEFT JOIN mg_segments s ON s.id=n.segment_id WHERE s.id IS NULL ${sessionId === undefined ? this.sql`` : this.sql`AND n.session_id=${sessionId}`}`;
    for (const row of orphanTopics) issues.push({ code: "topic-without-segment", severity: "error", sessionId: row.session_id, message: "Topic exists without its segment.", repairable: false });
    const orphanSegments = await this.sql<{ session_id: string }[]>`SELECT DISTINCT s.session_id FROM mg_segments s LEFT JOIN mg_topic_nodes n ON n.segment_id=s.id WHERE n.id IS NULL ${sessionId === undefined ? this.sql`` : this.sql`AND s.session_id=${sessionId}`}`;
    for (const row of orphanSegments) issues.push({ code: "segment-without-topic", severity: "error", sessionId: row.session_id, message: "Segment exists without its required topic.", repairable: false });
    const duplicates = await this.sql<{ session_id: string }[]>`SELECT session_id FROM mg_ingestion_runs WHERE TRUE ${sessionId === undefined ? this.sql`` : this.sql`AND session_id=${sessionId}`} GROUP BY session_id,start_index,end_index,kind HAVING COUNT(*) > 1`;
    for (const row of duplicates) issues.push({ code: "duplicate-range", severity: "error", sessionId: row.session_id, message: "Duplicate ingestion processing range exists.", repairable: false });
    return issues;
  }

  async transitionIngestionRun(transition: IngestionTransition): Promise<IngestionRun> {
    assertIngestionTransition(transition.from, transition.to);
    const error = transition.error;
    const rows = await this.sql<IngestionRunRow[]>`
      UPDATE mg_ingestion_runs SET status = ${transition.to}, updated_at = NOW(),
        queued_at = CASE WHEN ${transition.to} = 'queued' THEN NOW() ELSE queued_at END,
        started_at = CASE WHEN ${transition.to} = 'running' THEN NOW() ELSE started_at END,
        completed_at = CASE WHEN ${transition.to} IN ('completed','completed_with_warnings') THEN NOW() ELSE completed_at END,
        failed_at = CASE WHEN ${transition.to} IN ('failed','abandoned') THEN NOW() ELSE failed_at END,
        attempt_count = attempt_count + CASE WHEN ${transition.to} = 'running' THEN 1 ELSE 0 END,
        worker_id = COALESCE(${transition.workerId ?? null}, worker_id),
        lease_expires_at = ${transition.leaseExpiresAt ?? null}, heartbeat_at = CASE WHEN ${transition.to} = 'running' THEN NOW() ELSE heartbeat_at END,
        last_error_code = ${error?.code ?? null}, last_error_stage = ${error?.stage ?? null},
        last_error_safe_message = ${error?.message.slice(0, 500) ?? null}, retryable = ${error?.retryable ?? null}
      WHERE id = ${transition.runId} AND status = ANY(${transition.from}) RETURNING *`;
    if (!rows[0]) throw this.ingestionInvariant(`Illegal ingestion transition to ${transition.to}.`, undefined, transition.runId);
    return this.rowToIngestionRun(rows[0]);
  }

  async renewIngestionRunLease(runId: string, workerId: string, leaseExpiresAt: Date): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`UPDATE mg_ingestion_runs SET heartbeat_at=NOW(),lease_expires_at=${leaseExpiresAt},updated_at=NOW() WHERE id=${runId} AND status='running' AND worker_id=${workerId} RETURNING id`;
    if (!rows[0]) throw this.ingestionInvariant("Running ingestion lease could not be renewed.", undefined, runId);
  }

  async commitPreparedIngestion(prepared: PreparedIngestion): Promise<{ nodes: TopicNode[]; run: IngestionRun }> {
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`memo-grafter-session:${prepared.sessionId}`}))`;
      const runRows = await transaction<IngestionRunRow[]>`SELECT * FROM mg_ingestion_runs WHERE id = ${prepared.runId} FOR UPDATE`;
      const run = runRows[0];
      if (!run || run.status !== "running" || run.session_id !== prepared.sessionId || run.start_index !== prepared.startIndex || run.end_index !== prepared.endIndex) throw this.ingestionInvariant("Ingestion run does not match the prepared commit.", prepared.sessionId, prepared.runId);
      const cursorRows = await transaction<{ last_ingested_message_index: number }[]>`SELECT last_ingested_message_index FROM mg_session_ingest_state WHERE session_id = ${prepared.sessionId} FOR UPDATE`;
      const cursor = cursorRows[0]?.last_ingested_message_index ?? -1;
      if (cursor !== prepared.expectedCursor) throw this.ingestionInvariant(`Expected cursor ${prepared.expectedCursor}, found ${cursor}.`, prepared.sessionId, prepared.runId);
      for (const segment of prepared.segments) await transaction`INSERT INTO mg_segments (id,session_id,start_index,end_index,topic_order,drift_score,created_at) VALUES (${segment.id},${segment.sessionId},${segment.startIndex},${segment.endIndex},${segment.topicOrder},${segment.driftScore},${segment.createdAt}) ON CONFLICT (session_id,start_index,end_index) DO UPDATE SET topic_order=EXCLUDED.topic_order,drift_score=EXCLUDED.drift_score`;
      for (const node of prepared.nodes) await transaction`INSERT INTO mg_topic_nodes (id,session_id,segment_id,label,summary,embedding,tags,source,message_range,topic_order,drift_score,agent_color,fleet_id,agent_id,created_at) VALUES (${node.id},${node.sessionId},${node.segmentId},${node.label},${node.summary},${toVectorLiteral(node.embedding)}::vector,${transaction.array(normalizeTags(node.tags))}::text[],${node.source ?? null},${node.messageRange},${node.topicOrder},${node.driftScore},${node.agentColor},${node.fleetId},${node.agentId},${node.createdAt}) ON CONFLICT (segment_id) DO UPDATE SET label=EXCLUDED.label,summary=EXCLUDED.summary,embedding=EXCLUDED.embedding,tags=EXCLUDED.tags,source=EXCLUDED.source,message_range=EXCLUDED.message_range,topic_order=EXCLUDED.topic_order,drift_score=EXCLUDED.drift_score`;
      for (const memory of prepared.memories) await transaction`INSERT INTO mg_memory_nodes (id,segment_id,topic_node_id,agent_id,session_id,memory_type,source_type,subject,predicate,value,confidence,embedding,tags,source,source_url,source_title,provenance_speaker,provenance_message_indexes,provenance_session_id,extraction_method,superseded_by,decayed,forgotten,has_conflict,agent_color,fleet_id) VALUES (${memory.id},${memory.segmentId},${memory.topicNodeId},${memory.agentId},${memory.sessionId},${memory.memoryType},${memory.sourceType},${memory.subject},${memory.predicate},${memory.value},${memory.confidence},${toVectorLiteral(memory.embedding)}::vector,${transaction.array(normalizeTags(memory.tags))}::text[],${memory.source ?? null},${memory.sourceUrl},${memory.sourceTitle},${memory.provenance?.speaker ?? null},${memory.provenance ? transaction.array(memory.provenance.messageIndexes) : null}::int[],${memory.provenance?.sessionId ?? null},${memory.provenance?.extractionMethod ?? null},${memory.supersededBy},${memory.decayed},${memory.forgotten ?? false},${memory.hasConflict ?? false},${memory.agentColor},${memory.fleetId}) ON CONFLICT (id) DO NOTHING`;
      for (const edge of prepared.requiredEdges) await transaction`INSERT INTO mg_topic_edges (src_id,dst_id,weight,type) VALUES (${edge.srcId},${edge.dstId},${edge.weight},${edge.type}) ON CONFLICT (src_id,dst_id) DO UPDATE SET weight=EXCLUDED.weight,type=EXCLUDED.type`;
      await transaction`INSERT INTO mg_session_ingest_state (session_id,last_ingested_message_index,updated_at) VALUES (${prepared.sessionId},${prepared.endIndex},NOW()) ON CONFLICT (session_id) DO UPDATE SET last_ingested_message_index=EXCLUDED.last_ingested_message_index,updated_at=NOW()`;
      const completed = await transaction<IngestionRunRow[]>`UPDATE mg_ingestion_runs SET status='completed',completed_at=NOW(),lease_expires_at=NULL,updated_at=NOW() WHERE id=${prepared.runId} AND status='running' RETURNING *`;
      if (!completed[0]) throw this.ingestionInvariant("Ingestion run could not be completed.", prepared.sessionId, prepared.runId);
      return { nodes: prepared.nodes, run: this.rowToIngestionRun(completed[0]) };
    });
  }

  async getMessagesBySession(sessionId: string, startIndex?: number, endIndex?: number): Promise<Message[]> {
    const rows = await this.sql<MessageRow[]>`
      SELECT * FROM mg_message_buffer
      WHERE session_id = ${sessionId}
        ${startIndex === undefined ? this.sql`` : this.sql`AND message_index >= ${startIndex}`}
        ${endIndex === undefined ? this.sql`` : this.sql`AND message_index <= ${endIndex}`}
      ORDER BY message_index ASC
    `;

    return rows.map((row) => ({
      role: row.role,
      content: row.content,
    }));
  }

  async getRecentMessagesBefore(sessionId: string, beforeIndex: number, limit: number): Promise<Message[]> {
    if (limit <= 0) return [];

    const rows = await this.sql<MessageRow[]>`
      SELECT * FROM mg_message_buffer
      WHERE session_id = ${sessionId}
        AND message_index < ${beforeIndex}
      ORDER BY message_index DESC
      LIMIT ${limit}
    `;

    return rows
      .reverse()
      .map((row) => ({
        role: row.role,
        content: row.content,
      }));
  }

  async getSessionIngestState(sessionId: string): Promise<SessionIngestState | null> {
    const rows = await this.sql<SessionIngestStateRow[]>`
      SELECT * FROM mg_session_ingest_state
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;

    return rows[0] ? this.rowToSessionIngestState(rows[0]) : null;
  }

  async updateSessionIngestState(sessionId: string, lastIngestedMessageIndex: number): Promise<void> {
    await this.sql`
      INSERT INTO mg_session_ingest_state (session_id, last_ingested_message_index, updated_at)
      VALUES (${sessionId}, ${lastIngestedMessageIndex}, NOW())
      ON CONFLICT (session_id)
      DO UPDATE SET
        last_ingested_message_index = EXCLUDED.last_ingested_message_index,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async saveSegment(segment: TopicSegment): Promise<TopicSegment> {
    const rows = await this.sql<TopicSegmentRow[]>`
      INSERT INTO mg_segments (id, session_id, start_index, end_index, topic_order, drift_score, created_at)
      VALUES (
        ${segment.id},
        ${segment.sessionId},
        ${segment.startIndex},
        ${segment.endIndex},
        ${segment.topicOrder},
        ${segment.driftScore},
        ${segment.createdAt}
      )
      ON CONFLICT (session_id, start_index, end_index)
      DO UPDATE SET
        topic_order = EXCLUDED.topic_order,
        drift_score = EXCLUDED.drift_score
      RETURNING *
    `;

    return this.rowToSegment(rows[0]);
  }

  async saveSegmentWithNode(
    segment: TopicSegment,
    node: TopicNode,
  ): Promise<{ segment: TopicSegment; node: TopicNode }> {
    return this.sql.begin(async (transaction) => {
      const segmentRows = await transaction<TopicSegmentRow[]>`
        INSERT INTO mg_segments (id, session_id, start_index, end_index, topic_order, drift_score, created_at)
        VALUES (
          ${segment.id}, ${segment.sessionId}, ${segment.startIndex}, ${segment.endIndex},
          ${segment.topicOrder}, ${segment.driftScore}, ${segment.createdAt}
        )
        ON CONFLICT (session_id, start_index, end_index)
        DO UPDATE SET
          topic_order = EXCLUDED.topic_order,
          drift_score = EXCLUDED.drift_score
        RETURNING *
      `;
      const savedSegment = this.rowToSegment(segmentRows[0]);
      const nodeRows = await transaction<TopicNodeRow[]>`
        INSERT INTO mg_topic_nodes (
          id, session_id, segment_id, label, summary, embedding, tags, source,
          message_range, topic_order, drift_score, agent_color, fleet_id, agent_id, created_at
        )
        VALUES (
          ${node.id}, ${node.sessionId}, ${savedSegment.id}, ${node.label}, ${node.summary},
          ${toVectorLiteral(node.embedding)}::vector,
          ${transaction.array(normalizeTags(node.tags))}::text[], ${node.source ?? null},
          ${node.messageRange}, ${node.topicOrder}, ${node.driftScore}, ${node.agentColor},
          ${node.fleetId}, ${node.agentId}, ${node.createdAt}
        )
        ON CONFLICT (segment_id)
        DO UPDATE SET
          session_id = EXCLUDED.session_id,
          label = EXCLUDED.label,
          summary = EXCLUDED.summary,
          embedding = EXCLUDED.embedding,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          message_range = EXCLUDED.message_range,
          topic_order = EXCLUDED.topic_order,
          drift_score = EXCLUDED.drift_score,
          agent_color = EXCLUDED.agent_color,
          fleet_id = EXCLUDED.fleet_id,
          agent_id = EXCLUDED.agent_id
        RETURNING *
      `;

      const savedNodeRow = nodeRows[0];
      if (!savedNodeRow) throw new Error("MemoGrafter topic upsert did not return a row.");
      return { segment: savedSegment, node: this.rowToNode(savedNodeRow) };
    });
  }

  async saveNode(node: TopicNode): Promise<void> {
    await this.sql`
      INSERT INTO mg_topic_nodes (
        id,
        session_id,
        segment_id,
        label,
        summary,
        embedding,
        tags,
        source,
        message_range,
        topic_order,
        drift_score,
        agent_color,
        fleet_id,
        agent_id,
        created_at
      )
      VALUES (
        ${node.id},
        ${node.sessionId},
        ${node.segmentId},
        ${node.label},
        ${node.summary},
        ${toVectorLiteral(node.embedding)}::vector,
        ${this.sql.array(normalizeTags(node.tags))}::text[],
        ${node.source ?? null},
        ${node.messageRange},
        ${node.topicOrder},
        ${node.driftScore},
        ${node.agentColor},
        ${node.fleetId},
        ${node.agentId},
        ${node.createdAt}
      )
      ON CONFLICT (segment_id)
      DO UPDATE SET
        session_id = EXCLUDED.session_id,
        label = EXCLUDED.label,
        summary = EXCLUDED.summary,
        embedding = EXCLUDED.embedding,
        tags = EXCLUDED.tags,
        source = EXCLUDED.source,
        message_range = EXCLUDED.message_range,
        topic_order = EXCLUDED.topic_order,
        drift_score = EXCLUDED.drift_score,
        agent_color = EXCLUDED.agent_color,
        fleet_id = EXCLUDED.fleet_id,
        agent_id = EXCLUDED.agent_id,
        created_at = EXCLUDED.created_at
    `;
  }

  async saveEdge(edge: TopicEdge): Promise<void> {
    await this.sql`
      INSERT INTO mg_topic_edges (src_id, dst_id, weight, type)
      VALUES (${edge.srcId}, ${edge.dstId}, ${edge.weight}, ${edge.type})
      ON CONFLICT (src_id, dst_id)
      DO UPDATE SET weight = EXCLUDED.weight, type = EXCLUDED.type
    `;
  }

  async getEdgesByType(sessionId: string, type: string): Promise<TopicEdge[]> {
    const rows = await this.sql<EdgeRow[]>`
      SELECT e.*
      FROM mg_topic_edges e
      JOIN mg_topic_nodes n ON n.id = e.src_id
      WHERE n.session_id = ${sessionId}
        AND e.type = ${type}
        AND n.suppressed = FALSE
    `;

    return rows.map((row) => ({
      srcId: row.src_id,
      dstId: row.dst_id,
      weight: row.weight,
      type: row.type,
    }));
  }

  async getEdgesBySession(sessionId: string): Promise<TopicEdge[]> {
    const nodes = await this.getNodesBySession(sessionId);
    if (nodes.length === 0) return [];

    const nodeIds = nodes.map((node) => node.id);
    const rows = await this.sql<EdgeRow[]>`
      SELECT src_id, dst_id, weight, type
      FROM mg_topic_edges
      WHERE src_id = ANY(${this.sql.array(nodeIds)})
         OR dst_id = ANY(${this.sql.array(nodeIds)})
    `;

    return rows.map((row) => ({
      srcId: row.src_id,
      dstId: row.dst_id,
      weight: row.weight,
      type: row.type,
    }));
  }

  async clearSession(sessionId: string): Promise<void> {
    const nodeRows = await this.sql<{ id: string }[]>`
      SELECT id FROM mg_topic_nodes
      WHERE session_id = ${sessionId}
    `;
    const nodeIds = nodeRows.map((row) => row.id);

    if (nodeIds.length > 0) {
      await this.sql`
        DELETE FROM mg_topic_edges
        WHERE src_id = ANY(${this.sql.array(nodeIds)})
           OR dst_id = ANY(${this.sql.array(nodeIds)})
      `;
    }

    await this.sql`
      DELETE FROM mg_topic_nodes
      WHERE session_id = ${sessionId}
    `;

    await this.sql`
      DELETE FROM mg_segments
      WHERE session_id = ${sessionId}
    `;

    await this.sql`
      DELETE FROM mg_message_buffer
      WHERE session_id = ${sessionId}
    `;

    await this.sql`
      DELETE FROM mg_session_ingest_state
      WHERE session_id = ${sessionId}
    `;
  }

  async clearSessionGraph(sessionId: string): Promise<void> {
    await this.clearSession(sessionId);
  }

  async deleteNode(nodeId: string, sessionId?: string): Promise<void> {
    await this.deleteEdgesByNodeIds([nodeId]);

    await this.sql`
      DELETE FROM mg_topic_nodes
      WHERE id = ${nodeId}
        ${sessionId ? this.sql`AND session_id = ${sessionId}` : this.sql``}
    `;
  }

  async getTopicNode(topicNodeId: string, sessionId?: string): Promise<TopicNode | null> {
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT * FROM mg_topic_nodes
      WHERE id = ${topicNodeId}
        ${sessionId ? this.sql`AND session_id = ${sessionId}` : this.sql``}
      LIMIT 1
    `;

    return rows[0] ? this.rowToNode(rows[0]) : null;
  }

  async getNodeBySegment(segmentId: string): Promise<TopicNode | null> {
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT * FROM mg_topic_nodes
      WHERE segment_id = ${segmentId}
      LIMIT 1
    `;

    return rows[0] ? this.rowToNode(rows[0]) : null;
  }

  async getSessionNodeCount(sessionId: string): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mg_topic_nodes
      WHERE session_id = ${sessionId}
        AND suppressed = FALSE
    `;

    return rows[0]?.count ?? 0;
  }

  async getNodesBySession(sessionId: string, options: TagFilterOptions = {}): Promise<TopicNode[]> {
    const tags = normalizeTags(options.tags);
    const searchTaggedSessions = options.scope === "tagged" && tags.length > 0;
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT * FROM mg_topic_nodes
      WHERE ${searchTaggedSessions ? this.sql`TRUE` : this.sql`session_id = ${sessionId}`}
        ${options.includeSuppressed ? this.sql`` : this.sql`AND suppressed = FALSE`}
        ${this.topicTagsFilterSql(tags, options.tagMode)}
      ORDER BY session_id ASC, topic_order ASC, created_at ASC
    `;

    return rows.map((row) => this.rowToNode(row));
  }

  async getLastTopicNode(sessionId: string): Promise<TopicNode | null> {
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT * FROM mg_topic_nodes
      WHERE session_id = ${sessionId}
        AND suppressed = FALSE
      ORDER BY topic_order DESC, created_at DESC
      LIMIT 1
    `;

    return rows[0] ? this.rowToNode(rows[0]) : null;
  }

  async getSegmentsBySession(sessionId: string): Promise<TopicSegment[]> {
    const rows = await this.sql<TopicSegmentRow[]>`
      SELECT * FROM mg_segments
      WHERE session_id = ${sessionId}
      ORDER BY topic_order ASC, created_at ASC
    `;

    return rows.map((row) => this.rowToSegment(row));
  }

  async insertMemories(nodes: MemoryNodeInsert[]): Promise<void> {
    if (nodes.length === 0) return;

    const rows = nodes.map((node) => ({
      id: node.id,
      segment_id: node.segmentId,
      topic_node_id: node.topicNodeId,
      agent_id: node.agentId,
      session_id: node.sessionId,
      memory_type: node.memoryType,
      source_type: node.sourceType,
      subject: node.subject,
      predicate: node.predicate,
      value: node.value,
      confidence: node.confidence,
      embedding: toVectorLiteral(node.embedding),
      tags: normalizeTags(node.tags),
      source: node.source ?? null,
      source_url: node.sourceUrl,
      source_title: node.sourceTitle,
      provenance_speaker: node.provenance?.speaker ?? null,
      provenance_message_indexes: node.provenance?.messageIndexes ?? null,
      provenance_session_id: node.provenance?.sessionId ?? null,
      extraction_method: node.provenance?.extractionMethod ?? null,
      superseded_by: node.supersededBy,
      decayed: node.decayed,
      has_conflict: node.hasConflict ?? false,
      agent_color: node.agentColor,
      fleet_id: node.fleetId,
    }));

    await this.sql`
      INSERT INTO mg_memory_nodes ${this.sql(
        rows,
        "id",
        "segment_id",
        "topic_node_id",
        "agent_id",
        "session_id",
        "memory_type",
        "source_type",
        "subject",
        "predicate",
        "value",
        "confidence",
        "embedding",
        "tags",
        "source",
        "source_url",
        "source_title",
        "provenance_speaker",
        "provenance_message_indexes",
        "provenance_session_id",
        "extraction_method",
        "superseded_by",
        "decayed",
        "has_conflict",
        "agent_color",
        "fleet_id",
      )}
    `;
  }

  async getMemoriesBySegment(segmentId: string): Promise<MemoryNode[]> {
    const rows = await this.sql<MemoryNodeRow[]>`
      SELECT * FROM mg_memory_nodes
      WHERE segment_id = ${segmentId}
      ORDER BY created_at ASC
    `;

    return rows.map((row) => this.rowToMemoryNode(row));
  }

  async getMemoriesByTopic(topicNodeId: string): Promise<MemoryNode[]> {
    const rows = await this.sql<MemoryNodeRow[]>`
      SELECT memory.*
      FROM mg_memory_nodes memory
      JOIN mg_topic_nodes topic ON topic.id = memory.topic_node_id
      WHERE memory.topic_node_id = ${topicNodeId}
        AND memory.decayed = false
        AND memory.superseded_by IS NULL
        AND memory.forgotten = false
        AND topic.suppressed = false
      ORDER BY memory.created_at ASC
    `;

    return rows.map((row) => this.rowToMemoryNode(row));
  }

  async getActiveMemoriesByTopicIds(topicNodeIds: string[], sessionIds?: string[]): Promise<MemoryNode[]> {
    if (topicNodeIds.length === 0 || sessionIds?.length === 0) return [];
    const rows = await this.sql<MemoryNodeRow[]>`
      SELECT memory.*
      FROM mg_memory_nodes memory
      JOIN mg_topic_nodes topic ON topic.id = memory.topic_node_id
      WHERE memory.topic_node_id = ANY(${this.sql.array(topicNodeIds)})
        ${sessionIds ? this.sql`AND memory.session_id = ANY(${this.sql.array(sessionIds)})` : this.sql``}
        AND memory.decayed = false
        AND memory.superseded_by IS NULL
        AND memory.forgotten = false
        AND topic.suppressed = false
      ORDER BY memory.created_at DESC, memory.id ASC
    `;
    return rows.map((row) => this.rowToMemoryNode(row));
  }

  async getMemoriesBySession(sessionId: string): Promise<MemoryNode[]> {
    const rows = await this.sql<MemoryNodeRow[]>`
      SELECT * FROM mg_memory_nodes
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    `;

    return rows.map((row) => this.rowToMemoryNode(row));
  }

  async getMemoryEdgesBySession(sessionId: string): Promise<MemoryEdge[]> {
    const rows = await this.sql<MemoryEdgeRow[]>`
      SELECT DISTINCT edge.*
      FROM mg_memory_edges edge
      JOIN mg_memory_nodes source ON source.id = edge.source_id
      JOIN mg_memory_nodes target ON target.id = edge.target_id
      WHERE source.session_id = ${sessionId}
         OR target.session_id = ${sessionId}
      ORDER BY edge.created_at ASC
    `;

    return rows.map((row) => this.rowToMemoryEdge(row));
  }

  async getMemoryHistoryById(
    memoryNodeId: string,
    options: MemoryHistoryOptions = {},
  ): Promise<MemoryHistoryResult> {
    const anchor = await this.getMemoryNodeById(memoryNodeId, options.sessionId);
    if (!anchor) {
      return {
        anchorMemoryId: memoryNodeId,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        entries: [],
        edges: [],
        currentMemory: null,
      };
    }

    const memories = await this.getMemoryNodesByFactKey(anchor.subject, anchor.predicate, {
      sessionId: options.sessionId ?? anchor.sessionId,
    });
    const byId = new Map<string, MemoryNode | null>(memories.map((memory) => [memory.id, memory]));
    byId.set(anchor.id, anchor);

    const firstPassEdges = await this.getMemoryEdgesForMemoryIds([...byId.keys()]);
    for (const id of this.getConnectedMemoryIds(firstPassEdges)) {
      if (!byId.has(id)) {
        byId.set(id, null);
      }
    }

    const missingIds = [...byId.entries()]
      .filter(([, memory]) => memory == null)
      .map(([id]) => id);
    for (const memory of await this.getMemoryNodesByIds(missingIds, options.sessionId ?? anchor.sessionId)) {
      byId.set(memory.id, memory);
    }

    const historyMemories = [...byId.values()].filter((memory): memory is MemoryNode => memory != null);
    const edges = await this.getMemoryEdgesForMemoryIds(historyMemories.map((memory) => memory.id));

    return this.buildMemoryHistoryResult(historyMemories, edges, {
      anchorMemoryId: memoryNodeId,
      subject: anchor.subject,
      predicate: anchor.predicate,
      sessionId: options.sessionId ?? anchor.sessionId,
    });
  }

  async getMemoryHistoryByFact(
    subject: string,
    predicate: string,
    options: MemoryHistoryOptions = {},
  ): Promise<MemoryHistoryResult> {
    const memories = await this.getMemoryNodesByFactKey(subject, predicate, options);
    const edges = await this.getMemoryEdgesForMemoryIds(memories.map((memory) => memory.id));

    return this.buildMemoryHistoryResult(memories, edges, {
      subject,
      predicate,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });
  }

  async getMemoryDiff(fromMemoryId: string, toMemoryId: string): Promise<MemoryDiff> {
    const [from, to] = await Promise.all([
      this.getMemoryNodeById(fromMemoryId),
      this.getMemoryNodeById(toMemoryId),
    ]);

    if (!from) {
      throw new Error(`Memory ${fromMemoryId} was not found.`);
    }

    if (!to) {
      throw new Error(`Memory ${toMemoryId} was not found.`);
    }

    const edges = (await this.getMemoryEdgesForMemoryIds([from.id, to.id]))
      .filter((edge) =>
        (edge.sourceId === from.id && edge.targetId === to.id)
        || (edge.sourceId === to.id && edge.targetId === from.id)
      );
    const updateEdges = edges.filter((edge) => edge.edgeType === "updates");
    const conflictEdges = edges.filter((edge) => edge.edgeType === "conflicts");
    const fields = this.diffMemoryFields(from, to);

    return {
      from,
      to,
      fields,
      changedFields: fields.filter((field) => field.changed),
      relationship: {
        supersedes: to.supersededBy === from.id || updateEdges.some((edge) => edge.sourceId === from.id && edge.targetId === to.id),
        supersededBy: from.supersededBy === to.id || updateEdges.some((edge) => edge.sourceId === to.id && edge.targetId === from.id),
        conflicts: conflictEdges.length > 0,
        updateEdges,
        conflictEdges,
      },
    };
  }

  async listMemoryNodesForMaintenance(): Promise<MemoryNode[]> {
    const rows = await this.sql<MemoryNodeRow[]>`
      SELECT memory.*
      FROM mg_memory_nodes memory
      JOIN mg_topic_nodes topic ON topic.id = memory.topic_node_id
      WHERE memory.forgotten = FALSE
        AND topic.suppressed = FALSE
      ORDER BY memory.session_id ASC, memory.created_at ASC, memory.id ASC
    `;

    return rows.map((row) => this.rowToMemoryNode(row));
  }

  async forgetMemory(memoryNodeId: string): Promise<boolean> {
    const changed = await this.forgetMemories([memoryNodeId]);
    return changed > 0;
  }

  async forgetMemories(memoryNodeIds: string[]): Promise<number> {
    if (memoryNodeIds.length === 0) return 0;

    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_memory_nodes
      SET
        forgotten = TRUE,
        forgotten_at = COALESCE(forgotten_at, NOW())
      WHERE id = ANY(${this.sql.array(memoryNodeIds)}::uuid[])
        AND forgotten = FALSE
      RETURNING id
    `;

    return rows.length;
  }

  async suppressTopic(topicNodeId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_topic_nodes
      SET
        suppressed = TRUE,
        suppressed_at = COALESCE(suppressed_at, NOW())
      WHERE id = ${topicNodeId}
        AND suppressed = FALSE
      RETURNING id
    `;

    return rows.length > 0;
  }

  async restoreTopic(topicNodeId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_topic_nodes
      SET
        suppressed = FALSE,
        suppressed_at = NULL
      WHERE id = ${topicNodeId}
        AND suppressed = TRUE
      RETURNING id
    `;

    return rows.length > 0;
  }

  async pinTopic(sessionId: string, topicNodeId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_topic_nodes
      SET pinned = TRUE, pinned_at = COALESCE(pinned_at, NOW())
      WHERE id = ${topicNodeId}
        AND session_id = ${sessionId}
        AND suppressed = FALSE
        AND pinned = FALSE
      RETURNING id
    `;
    return rows.length > 0;
  }

  async unpinTopic(sessionId: string, topicNodeId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_topic_nodes
      SET pinned = FALSE, pinned_at = NULL
      WHERE id = ${topicNodeId}
        AND session_id = ${sessionId}
        AND pinned = TRUE
      RETURNING id
    `;
    return rows.length > 0;
  }

  async getPinnedTopics(sessionId: string): Promise<TopicNode[]> {
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT * FROM mg_topic_nodes
      WHERE session_id = ${sessionId}
        AND pinned = TRUE
        AND suppressed = FALSE
      ORDER BY pinned_at ASC, topic_order ASC, created_at ASC, id ASC
    `;
    return rows.map((row) => this.rowToNode(row));
  }

  async markMemoryNodesConflicting(memoryNodeIds: string[]): Promise<number> {
    if (memoryNodeIds.length === 0) return 0;

    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_memory_nodes
      SET has_conflict = TRUE
      WHERE id = ANY(${this.sql.array(memoryNodeIds)}::uuid[])
        AND has_conflict = FALSE
      RETURNING id
    `;

    return rows.length;
  }

  async markMemoryNodeSuperseded(memoryNodeId: string, supersededBy: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_memory_nodes
      SET superseded_by = ${supersededBy}::uuid
      WHERE id = ${memoryNodeId}::uuid
        AND superseded_by IS NULL
      RETURNING id
    `;

    return rows.length > 0;
  }

  async markMemoryNodeDecayed(memoryNodeId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_memory_nodes
      SET decayed = TRUE
      WHERE id = ${memoryNodeId}::uuid
        AND decayed = FALSE
        AND superseded_by IS NULL
      RETURNING id
    `;

    return rows.length > 0;
  }

  async updateMemoryNodeConfidence(memoryNodeId: string, confidence: number): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE mg_memory_nodes
      SET confidence = ${confidence}
      WHERE id = ${memoryNodeId}::uuid
      RETURNING id
    `;

    return rows.length > 0;
  }

  async upsertMemoryEdge(edge: Pick<MemoryEdge, "sourceId" | "targetId" | "edgeType"> & {
    weight?: number;
  }): Promise<boolean> {
    const existing = edge.edgeType === "updates"
      ? await this.sql<{ id: string }[]>`
        SELECT id FROM mg_memory_edges
        WHERE source_id = ${edge.sourceId}::uuid
          AND target_id = ${edge.targetId}::uuid
          AND edge_type = ${edge.edgeType}
        LIMIT 1
      `
      : await this.sql<{ id: string }[]>`
        SELECT id FROM mg_memory_edges
        WHERE edge_type = ${edge.edgeType}
          AND (
            (source_id = ${edge.sourceId}::uuid AND target_id = ${edge.targetId}::uuid)
            OR (source_id = ${edge.targetId}::uuid AND target_id = ${edge.sourceId}::uuid)
          )
        LIMIT 1
      `;

    if (existing.length > 0) return false;

    await this.sql`
      INSERT INTO mg_memory_edges (source_id, target_id, edge_type, weight)
      VALUES (${edge.sourceId}::uuid, ${edge.targetId}::uuid, ${edge.edgeType}, ${edge.weight ?? 1})
    `;

    return true;
  }

  async searchMemories(
    embedding: number[],
    sessionId: string,
    limit: number,
    minSimilarity: number,
    options: TagFilterOptions = {},
  ): Promise<(MemoryNode & { similarity: number })[]> {
    if (options.sessionIds && options.sessionIds.length > 0) {
      return this.searchMemoriesAcrossSessions(embedding, options.sessionIds, limit, minSimilarity, options);
    }

    const tags = normalizeTags(options.tags);
    const searchTaggedSessions = options.scope === "tagged" && tags.length > 0;
    const rows = await this.sql<Array<MemoryNodeRow & { similarity: number }>>`
      SELECT memory.*, 1 - (memory.embedding <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM mg_memory_nodes memory
      JOIN mg_topic_nodes topic ON topic.id = memory.topic_node_id
      WHERE ${searchTaggedSessions ? this.sql`TRUE` : this.sql`memory.session_id = ${sessionId}`}
        AND memory.decayed = false
        AND memory.superseded_by IS NULL
        AND memory.forgotten = false
        AND topic.suppressed = false
        ${this.memoryTagsFilterSql(tags, options.tagMode, "memory")}
        AND 1 - (memory.embedding <=> ${toVectorLiteral(embedding)}::vector) >= ${minSimilarity}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      ...this.rowToMemoryNode(row),
      similarity: row.similarity,
    }));
  }

  async searchMemoryCandidates(
    embedding: number[],
    sessionId: string,
    limit: number,
    options: TagFilterOptions = {},
  ): Promise<(MemoryNode & { similarity: number })[]> {
    if (options.sessionIds && options.sessionIds.length > 0) {
      return this.searchMemoryCandidatesAcrossSessions(embedding, options.sessionIds, limit, options);
    }

    const tags = normalizeTags(options.tags);
    const searchTaggedSessions = options.scope === "tagged" && tags.length > 0;
    const rows = await this.sql<Array<MemoryNodeRow & { similarity: number }>>`
      SELECT memory.*, 1 - (memory.embedding <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM mg_memory_nodes memory
      JOIN mg_topic_nodes topic ON topic.id = memory.topic_node_id
      WHERE ${searchTaggedSessions ? this.sql`TRUE` : this.sql`memory.session_id = ${sessionId}`}
        AND memory.decayed = false
        AND memory.superseded_by IS NULL
        AND memory.forgotten = false
        AND topic.suppressed = false
        ${this.memoryTagsFilterSql(tags, options.tagMode, "memory")}
      ORDER BY memory.embedding <=> ${toVectorLiteral(embedding)}::vector
      LIMIT ${limit}
    `;

    return rows.map((row) => ({ ...this.rowToMemoryNode(row), similarity: row.similarity }));
  }

  async searchTopicCandidates(
    embedding: number[],
    sessionId: string,
    limit: number,
    options: TagFilterOptions = {},
  ): Promise<(TopicNode & { similarity: number })[]> {
    const tags = normalizeTags(options.tags);
    const configuredSessionIds = options.sessionIds?.filter(Boolean) ?? [];
    const searchTaggedSessions = options.scope === "tagged" && tags.length > 0;
    if (options.sessionIds && configuredSessionIds.length === 0) return [];
    const rows = await this.sql<Array<TopicNodeRow & { similarity: number }>>`
      SELECT topic.*, 1 - (topic.embedding <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM mg_topic_nodes topic
      WHERE ${configuredSessionIds.length > 0
        ? this.sql`topic.session_id = ANY(${this.sql.array(configuredSessionIds)})`
        : searchTaggedSessions ? this.sql`TRUE` : this.sql`topic.session_id = ${sessionId}`}
        AND topic.suppressed = false
        ${this.topicTagsFilterSql(tags, options.tagMode, "topic")}
      ORDER BY topic.embedding <=> ${toVectorLiteral(embedding)}::vector, topic.created_at DESC, topic.id ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...this.rowToNode(row), similarity: row.similarity }));
  }

  private async searchMemoryCandidatesAcrossSessions(
    embedding: number[],
    sessionIds: string[],
    limit: number,
    options: TagFilterOptions = {},
  ): Promise<(MemoryNode & { similarity: number })[]> {
    if (sessionIds.length === 0) return [];
    const tags = normalizeTags(options.tags);
    const rows = await this.sql<Array<MemoryNodeRow & { similarity: number }>>`
      SELECT memory.*, 1 - (memory.embedding <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM mg_memory_nodes memory
      JOIN mg_topic_nodes topic ON topic.id = memory.topic_node_id
      WHERE memory.session_id = ANY(${this.sql.array(sessionIds)})
        AND memory.decayed = false
        AND memory.superseded_by IS NULL
        AND memory.forgotten = false
        AND topic.suppressed = false
        ${this.memoryTagsFilterSql(tags, options.tagMode, "memory")}
      ORDER BY memory.embedding <=> ${toVectorLiteral(embedding)}::vector
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...this.rowToMemoryNode(row), similarity: row.similarity }));
  }

  async searchMemoriesAcrossSessions(
    embedding: number[],
    sessionIds: string[],
    limit: number,
    minSimilarity: number,
    options: TagFilterOptions = {},
  ): Promise<(MemoryNode & { similarity: number })[]> {
    if (sessionIds.length === 0) return [];

    const tags = normalizeTags(options.tags);
    const rows = await this.sql<Array<MemoryNodeRow & { similarity: number }>>`
      SELECT memory.*, 1 - (memory.embedding <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM mg_memory_nodes memory
      JOIN mg_topic_nodes topic ON topic.id = memory.topic_node_id
      WHERE memory.session_id = ANY(${this.sql.array(sessionIds)})
        AND memory.decayed = false
        AND memory.superseded_by IS NULL
        AND memory.forgotten = false
        AND topic.suppressed = false
        ${this.memoryTagsFilterSql(tags, options.tagMode, "memory")}
        AND 1 - (memory.embedding <=> ${toVectorLiteral(embedding)}::vector) >= ${minSimilarity}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      ...this.rowToMemoryNode(row),
      similarity: row.similarity,
    }));
  }

  async buildMemoryEdges(topicNodeId: string, sessionId: string, threshold: number): Promise<void> {
    try {
      const memories = (await this.getMemoriesByTopic(topicNodeId))
        .filter((memory) => memory.sessionId === sessionId);
      if (memories.length < 2) return;

      for (let sourceIndex = 0; sourceIndex < memories.length; sourceIndex += 1) {
        const source = memories[sourceIndex];
        if (!source) continue;

        for (let targetIndex = sourceIndex + 1; targetIndex < memories.length; targetIndex += 1) {
          const target = memories[targetIndex];
          if (!target || source.id === target.id) continue;

          const similarity = cosineSimilarity(source.embedding, target.embedding);
          if (!Number.isFinite(similarity) || similarity < threshold) continue;

          const existing = await this.sql<{ id: string }[]>`
            SELECT id FROM mg_memory_edges
            WHERE (source_id = ${source.id}::uuid AND target_id = ${target.id}::uuid)
               OR (source_id = ${target.id}::uuid AND target_id = ${source.id}::uuid)
            LIMIT 1
          `;
          if (existing.length > 0) continue;

          await this.sql`
            INSERT INTO mg_memory_edges (source_id, target_id, edge_type, weight)
            VALUES (${source.id}::uuid, ${target.id}::uuid, 'semantic', ${similarity})
          `;
        }
      }
    } catch (error) {
      console.warn("GraphStore memory edge build warning:", error);
    }
  }

  async getTopKSimilar(nodeId: string, embedding: number[], sessionId: string, k: number): Promise<TopicNode[]> {
    return this.getSimilarNodes(embedding, sessionId, { k, excludeNodeId: nodeId });
  }

  async getSimilarNodes(
    embedding: number[],
    sessionId: string,
    options: { k?: number; excludeNodeId?: string; minSimilarity?: number } = {},
  ): Promise<TopicNode[]> {
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT *, 1 - (embedding <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM mg_topic_nodes
      WHERE session_id = ${sessionId}
        AND suppressed = FALSE
        ${options.excludeNodeId ? this.sql`AND id != ${options.excludeNodeId}` : this.sql``}
        ${options.minSimilarity === undefined ? this.sql`` : this.sql`AND 1 - (embedding <=> ${toVectorLiteral(embedding)}::vector) >= ${options.minSimilarity}`}
      ORDER BY embedding <=> ${toVectorLiteral(embedding)}::vector ASC
      LIMIT ${options.k ?? 5}
    `;

    return rows.map((row) => this.rowToNode(row));
  }

  async getSimilarNodesAcrossSessions(
    embedding: number[],
    sessionIds: string[],
    options: { k?: number; excludeNodeId?: string; minSimilarity?: number } = {},
  ): Promise<TopicNode[]> {
    if (sessionIds.length === 0) return [];

    const rows = await this.sql<TopicNodeRow[]>`
      SELECT *, 1 - (embedding <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM mg_topic_nodes
      WHERE session_id = ANY(${this.sql.array(sessionIds)})
        AND suppressed = FALSE
        ${options.excludeNodeId ? this.sql`AND id != ${options.excludeNodeId}` : this.sql``}
        ${options.minSimilarity === undefined ? this.sql`` : this.sql`AND 1 - (embedding <=> ${toVectorLiteral(embedding)}::vector) >= ${options.minSimilarity}`}
      ORDER BY embedding <=> ${toVectorLiteral(embedding)}::vector ASC
      LIMIT ${options.k ?? 5}
    `;

    return rows.map((row) => this.rowToNode(row));
  }

  async getSimilarNodesAcrossFleet(
    fleetId: string,
    embedding: number[],
    options: { k?: number; excludeNodeId?: string; minSimilarity?: number; agentColor?: string } = {},
  ): Promise<TopicNode[]> {
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT *, 1 - (embedding <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM mg_topic_nodes
      WHERE fleet_id = ${fleetId}
        AND suppressed = FALSE
        ${options.agentColor ? this.sql`AND agent_color = ${options.agentColor}` : this.sql``}
        ${options.excludeNodeId ? this.sql`AND id != ${options.excludeNodeId}` : this.sql``}
        ${options.minSimilarity === undefined ? this.sql`` : this.sql`AND 1 - (embedding <=> ${toVectorLiteral(embedding)}::vector) >= ${options.minSimilarity}`}
      ORDER BY embedding <=> ${toVectorLiteral(embedding)}::vector ASC
      LIMIT ${options.k ?? 5}
    `;

    return rows.map((row) => this.rowToNode(row));
  }

  async getNodesByColor(fleetId: string, agentColor: string): Promise<TopicNode[]> {
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT * FROM mg_topic_nodes
      WHERE fleet_id = ${fleetId}
        AND agent_color = ${agentColor}
        AND suppressed = FALSE
      ORDER BY topic_order ASC, created_at ASC
    `;

    return rows.map((row) => this.rowToNode(row));
  }

  async saveFleet(fleetId: string, name?: string): Promise<void> {
    await this.sql`
      INSERT INTO mg_fleets (id, name)
      VALUES (${fleetId}, ${name ?? null})
      ON CONFLICT (id)
      DO UPDATE SET name = COALESCE(EXCLUDED.name, mg_fleets.name)
    `;
  }

  async saveFleetAgent(agent: {
    id: string;
    fleetId: string;
    sessionId: string;
    agentColor: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO mg_fleet_agents (id, fleet_id, session_id, agent_color)
      VALUES (${agent.id}, ${agent.fleetId}, ${agent.sessionId}, ${agent.agentColor})
      ON CONFLICT (fleet_id, agent_color)
      DO UPDATE SET
        id = EXCLUDED.id,
        session_id = EXCLUDED.session_id
    `;
  }

  async getFleetAgents(fleetId: string): Promise<FleetAgentRecord[]> {
    const rows = await this.sql<Array<{
      id: string;
      fleet_id: string;
      session_id: string;
      agent_color: string;
      created_at: Date;
    }>>`
      SELECT * FROM mg_fleet_agents
      WHERE fleet_id = ${fleetId}
      ORDER BY created_at ASC
    `;

    return rows.map((row) => ({
      id: row.id,
      fleetId: row.fleet_id,
      sessionId: row.session_id,
      agentColor: row.agent_color,
      createdAt: row.created_at,
    }));
  }

  async tagSessionNodes(sessionId: string, metadata: {
    fleetId: string | null;
    agentId: string | null;
    agentColor: string | null;
  }): Promise<void> {
    await this.sql`
      UPDATE mg_topic_nodes
      SET
        fleet_id = ${metadata.fleetId},
        agent_id = ${metadata.agentId},
        agent_color = ${metadata.agentColor}
      WHERE session_id = ${sessionId}
    `;

    await this.sql`
      UPDATE mg_memory_nodes
      SET
        fleet_id = ${metadata.fleetId},
        agent_id = ${metadata.agentId},
        agent_color = ${metadata.agentColor}
      WHERE session_id = ${sessionId}
    `;
  }

  async setSessionTags(sessionId: string, tags: string[]): Promise<void> {
    const normalized = normalizeTags(tags);

    await this.sql`
      UPDATE mg_topic_nodes
      SET tags = ${this.sql.array(normalized)}::text[]
      WHERE session_id = ${sessionId}
    `;

    await this.sql`
      UPDATE mg_memory_nodes
      SET tags = ${this.sql.array(normalized)}::text[]
      WHERE session_id = ${sessionId}
    `;
  }

  async getPreviousNode(sessionId: string, topicOrder: number): Promise<TopicNode | null> {
    const rows = await this.sql<TopicNodeRow[]>`
      SELECT *
      FROM mg_topic_nodes
      WHERE session_id = ${sessionId}
        AND topic_order = ${topicOrder - 1}
        AND suppressed = FALSE
      LIMIT 1
    `;

    return rows[0] ? this.rowToNode(rows[0]) : null;
  }

  async nodeSimilarity(nodeAId: string, nodeBId: string): Promise<number> {
    const rows = await this.sql<{ similarity: number }[]>`
      SELECT 1 - (n1.embedding <=> n2.embedding) AS similarity
      FROM mg_topic_nodes n1, mg_topic_nodes n2
      WHERE n1.id = ${nodeAId}
        AND n2.id = ${nodeBId}
    `;

    return rows[0]?.similarity ?? 0;
  }

  async getNeighbours(nodeIds: string[], hopDepth: number, sessionId?: string): Promise<TopicNode[]> {
    const visited = new Set(nodeIds);
    let frontier = [...nodeIds];

    for (let hop = 0; hop < hopDepth; hop += 1) {
      if (frontier.length === 0) break;

      const edges = await this.sql<EdgeRow[]>`
        SELECT * FROM mg_topic_edges
        WHERE src_id = ANY(${this.sql.array(frontier)})
           OR dst_id = ANY(${this.sql.array(frontier)})
      `;

      const nextFrontier: string[] = [];
      for (const edge of edges) {
        const candidates = [edge.src_id, edge.dst_id];
        for (const candidate of candidates) {
          if (!visited.has(candidate)) {
            visited.add(candidate);
            nextFrontier.push(candidate);
          }
        }
      }

      frontier = nextFrontier;
    }

    const ids = Array.from(visited);
    if (ids.length === 0) return [];

    const rows = await this.sql<TopicNodeRow[]>`
      SELECT * FROM mg_topic_nodes
      WHERE id = ANY(${this.sql.array(ids)})
        ${sessionId ? this.sql`AND session_id = ${sessionId}` : this.sql``}
        AND suppressed = FALSE
      ORDER BY topic_order ASC, created_at ASC
    `;

    return rows.map((row) => this.rowToNode(row));
  }

  async getBufferMessages(sessionId: string, start: number, end: number, maxChars = 600): Promise<Message[]> {
    const rows = await this.sql<MessageRow[]>`
      SELECT * FROM mg_message_buffer
      WHERE session_id = ${sessionId}
        AND message_index >= ${start}
        AND message_index <= ${end}
      ORDER BY message_index ASC
    `;

    return rows.map((row) => ({
      role: row.role,
      content: row.role === "assistant" ? this.cleanAssistantMessage(row.content, maxChars) : row.content,
    }));
  }

  async insertGraftRegistry(entry: Omit<GraftRegistryEntry, "id" | "graftedAt">): Promise<GraftRegistryEntry> {
    const rows = await this.sql<GraftRegistryRow[]>`
      INSERT INTO mg_graft_registry (
        session_id,
        node_id,
        source_session_id,
        source_node_id
      )
      VALUES (
        ${entry.sessionId},
        ${entry.nodeId},
        ${entry.sourceSessionId},
        ${entry.sourceNodeId}
      )
      ON CONFLICT (node_id)
      DO UPDATE SET
        session_id = EXCLUDED.session_id,
        source_session_id = EXCLUDED.source_session_id,
        source_node_id = EXCLUDED.source_node_id
      RETURNING *
    `;

    return this.rowToGraftRegistryEntry(rows[0]);
  }

  async getGraftRegistry(sessionId: string): Promise<GraftRegistryEntry[]> {
    const rows = await this.sql<GraftRegistryRow[]>`
      SELECT * FROM mg_graft_registry
      WHERE session_id = ${sessionId}
      ORDER BY grafted_at ASC
    `;

    return rows.map((row) => this.rowToGraftRegistryEntry(row));
  }

  async graftTopics(request: GraftTopicsRequest): Promise<GraftTopicsResult> {
    if (request.duplicatePolicy !== "skip") throw new Error(`Unsupported graft duplicate policy '${request.duplicatePolicy}'.`);
    if (request.sourceSessionId === request.targetSessionId) throw new Error("A topic cannot be grafted into its source session.");
    if (request.topicIds.length !== 1) throw new Error("Studio topic grafting currently requires exactly one topic ID.");

    const sourceTopicId = request.topicIds[0]!;
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`memo-grafter-session:${request.targetSessionId}`}))`;
      const sourceRows = await transaction<TopicNodeRow[]>`
        SELECT * FROM mg_topic_nodes
        WHERE id = ${sourceTopicId} AND session_id = ${request.sourceSessionId} AND suppressed = FALSE
        LIMIT 1
      `;
      const source = sourceRows[0] ? this.rowToNode(sourceRows[0]) : null;
      if (!source) throw new Error(`Active topic '${sourceTopicId}' was not found in source session '${request.sourceSessionId}'.`);

      const existing = await transaction<GraftRegistryRow[]>`
        SELECT * FROM mg_graft_registry
        WHERE session_id = ${request.targetSessionId}
          AND source_session_id = ${request.sourceSessionId}
          AND source_node_id = ${sourceTopicId}
        LIMIT 1
      `;
      if (existing[0]) {
        return {
          sourceSessionId: request.sourceSessionId,
          targetSessionId: request.targetSessionId,
          sourceTopicId,
          status: "skipped" as const,
          copiedTopics: [],
          copiedMemoryCount: 0,
          existingTargetTopicId: existing[0].node_id,
        };
      }

      const nextMessageRows = await transaction<{ next_index: number }[]>`
        SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index FROM mg_message_buffer
        WHERE session_id = ${request.targetSessionId}
      `;
      const nextOrderRows = await transaction<{ next_order: number }[]>`
        SELECT COALESCE(MAX(topic_order), -1) + 1 AS next_order FROM mg_topic_nodes
        WHERE session_id = ${request.targetSessionId}
      `;
      const messageIndex = nextMessageRows[0]?.next_index ?? 0;
      const topicOrder = nextOrderRows[0]?.next_order ?? 0;
      const segmentId = randomUUID();
      const copiedTopicId = randomUUID();
      const createdAt = new Date();

      await transaction`
        INSERT INTO mg_message_buffer (session_id, message_index, role, content)
        VALUES (${request.targetSessionId}, ${messageIndex}, 'assistant', ${this.formatGraftedMemoryMessage(source)})
      `;
      await transaction`
        INSERT INTO mg_segments (id, session_id, start_index, end_index, topic_order, drift_score, created_at)
        VALUES (${segmentId}, ${request.targetSessionId}, ${messageIndex}, ${messageIndex}, ${topicOrder}, ${source.driftScore}, ${createdAt})
      `;
      await transaction`
        INSERT INTO mg_topic_nodes (
          id, session_id, segment_id, label, summary, embedding, tags, source,
          message_range, topic_order, drift_score, agent_color, fleet_id, agent_id, created_at
        ) VALUES (
          ${copiedTopicId}, ${request.targetSessionId}, ${segmentId}, ${source.label}, ${source.summary},
          ${toVectorLiteral(source.embedding)}::vector, ${transaction.array(normalizeTags(source.tags))}::text[],
          ${source.source ?? null}, ${[messageIndex, messageIndex]}, ${topicOrder}, ${source.driftScore},
          ${source.agentColor}, ${source.fleetId}, ${source.agentId}, ${createdAt}
        )
      `;
      const copiedMemories = await transaction<{ id: string }[]>`
        INSERT INTO mg_memory_nodes (
          segment_id, topic_node_id, agent_id, session_id, memory_type, source_type,
          subject, predicate, value, confidence, embedding, tags, source, source_url,
          source_title, provenance_speaker, provenance_message_indexes, provenance_session_id,
          extraction_method, superseded_by, decayed, forgotten, has_conflict, agent_color, fleet_id
        )
        SELECT
          ${segmentId}, ${copiedTopicId}, agent_id, ${request.targetSessionId}, memory_type, source_type,
          subject, predicate, value, confidence, embedding, tags, source, source_url,
          source_title, provenance_speaker, provenance_message_indexes, provenance_session_id,
          extraction_method, NULL, FALSE, FALSE, has_conflict, agent_color, fleet_id
        FROM mg_memory_nodes
        WHERE topic_node_id = ${sourceTopicId} AND session_id = ${request.sourceSessionId}
          AND forgotten = FALSE AND decayed = FALSE AND superseded_by IS NULL
        RETURNING id
      `;
      await transaction`
        INSERT INTO mg_topic_edges (src_id, dst_id, weight, type)
        VALUES (${copiedTopicId}, ${sourceTopicId}, 1, 'grafted')
      `;
      await transaction`
        INSERT INTO mg_graft_registry (session_id, node_id, source_session_id, source_node_id)
        VALUES (${request.targetSessionId}, ${copiedTopicId}, ${request.sourceSessionId}, ${sourceTopicId})
      `;

      const copy: TopicNode = {
        ...source, id: copiedTopicId, sessionId: request.targetSessionId, segmentId,
        messageRange: [messageIndex, messageIndex], topicOrder, createdAt,
      };
      return {
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.targetSessionId,
        sourceTopicId,
        status: "copied" as const,
        copiedTopics: [copy],
        copiedMemoryCount: copiedMemories.length,
      };
    });
  }

  async removeGraftFromSession(targetSessionId: string, nodeId: string): Promise<GraftRegistryEntry | null> {
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`memo-grafter-session:${targetSessionId}`}))`;
      const registryRows = await transaction<GraftRegistryRow[]>`
        SELECT * FROM mg_graft_registry WHERE session_id = ${targetSessionId} AND node_id = ${nodeId} LIMIT 1
      `;
      const registry = registryRows[0];
      if (!registry) return null;
      const segmentRows = await transaction<{ segment_id: string }[]>`
        SELECT segment_id FROM mg_topic_nodes WHERE id = ${nodeId} AND session_id = ${targetSessionId}
      `;
      const segmentId = segmentRows[0]?.segment_id;
      await transaction`
        DELETE FROM mg_memory_edges
        WHERE source_id IN (SELECT id FROM mg_memory_nodes WHERE topic_node_id = ${nodeId})
           OR target_id IN (SELECT id FROM mg_memory_nodes WHERE topic_node_id = ${nodeId})
      `;
      await transaction`DELETE FROM mg_memory_nodes WHERE topic_node_id = ${nodeId}`;
      await transaction`DELETE FROM mg_topic_edges WHERE src_id = ${nodeId} OR dst_id = ${nodeId}`;
      await transaction`DELETE FROM mg_graft_registry WHERE node_id = ${nodeId}`;
      await transaction`DELETE FROM mg_topic_nodes WHERE id = ${nodeId} AND session_id = ${targetSessionId}`;
      if (segmentId) {
        await transaction`
          DELETE FROM mg_message_buffer WHERE session_id = ${targetSessionId}
            AND message_index IN (SELECT start_index FROM mg_segments WHERE id = ${segmentId})
        `;
        await transaction`DELETE FROM mg_segments WHERE id = ${segmentId}`;
      }
      return this.rowToGraftRegistryEntry(registry);
    });
  }

  async deleteGraftRegistry(nodeId: string): Promise<void> {
    await this.sql`
      DELETE FROM mg_graft_registry
      WHERE node_id = ${nodeId}
    `;
  }

  async absorbNodes(nodes: TopicNode[], targetSessionId: string, options: AbsorbOptions = {}): Promise<TopicNode[]> {
    const copiedNodes: TopicNode[] = [];
    const nextMessageIndex = await this.getNextMessageIndex(targetSessionId);
    const nextTopicOrder = await this.getNextTopicOrder(targetSessionId);

    for (const node of nodes) {
      if (node.suppressed) continue;

      const index = copiedNodes.length;
      const messageIndex = nextMessageIndex + index;
      await this.saveMessagesAt(targetSessionId, messageIndex, [{
        role: "assistant",
        content: this.formatGraftedMemoryMessage(node),
      }]);

      const segment = await this.saveSegment({
        id: randomUUID(),
        sessionId: targetSessionId,
        startIndex: messageIndex,
        endIndex: messageIndex,
        topicOrder: nextTopicOrder + index,
        driftScore: node.driftScore,
        createdAt: new Date(),
      });

      const copy: TopicNode = {
        ...node,
        id: randomUUID(),
        sessionId: targetSessionId,
        segmentId: segment.id,
        messageRange: [segment.startIndex, segment.endIndex],
        topicOrder: segment.topicOrder,
        driftScore: segment.driftScore,
        agentColor: options.agentColor ?? node.agentColor,
        fleetId: options.fleetId ?? node.fleetId,
        agentId: options.agentId ?? node.agentId,
        createdAt: new Date(),
      };

      await this.saveNode(copy);
      await this.copyActiveMemoriesForAbsorbedNode(node, copy, targetSessionId);
      await this.saveEdge({
        srcId: copy.id,
        dstId: node.id,
        weight: 1,
        type: "grafted",
      });
      await this.insertGraftRegistry({
        sessionId: targetSessionId,
        nodeId: copy.id,
        sourceSessionId: node.sessionId,
        sourceNodeId: node.id,
      });
      copiedNodes.push(copy);
    }

    return copiedNodes;
  }

  private async copyActiveMemoriesForAbsorbedNode(
    sourceNode: TopicNode,
    copiedNode: TopicNode,
    targetSessionId: string,
  ): Promise<void> {
    await this.sql`
      INSERT INTO mg_memory_nodes (
        segment_id,
        topic_node_id,
        agent_id,
        session_id,
        memory_type,
        source_type,
        subject,
        predicate,
        value,
        confidence,
        embedding,
        tags,
        source,
        source_url,
        source_title,
        provenance_speaker,
        provenance_message_indexes,
        provenance_session_id,
        extraction_method,
        superseded_by,
        decayed,
        agent_color,
        fleet_id
      )
      SELECT
        ${copiedNode.segmentId},
        ${copiedNode.id},
        ${copiedNode.agentId},
        ${targetSessionId},
        memory_type,
        source_type,
        subject,
        predicate,
        value,
        confidence,
        embedding,
        tags,
        source,
        source_url,
        source_title,
        provenance_speaker,
        provenance_message_indexes,
        provenance_session_id,
        extraction_method,
        NULL,
        FALSE,
        ${copiedNode.agentColor},
        ${copiedNode.fleetId}
      FROM mg_memory_nodes
      WHERE topic_node_id = ${sourceNode.id}
        AND session_id = ${sourceNode.sessionId}
        AND decayed = FALSE
        AND superseded_by IS NULL
        AND forgotten = FALSE
    `;
  }

  private async getMemoryNodeById(memoryNodeId: string, sessionId?: string): Promise<MemoryNode | null> {
    if (sessionId) {
      const rows = await this.sql<MemoryNodeRow[]>`
        SELECT *
        FROM mg_memory_nodes
        WHERE id = ${memoryNodeId}::uuid
          AND session_id = ${sessionId}
        LIMIT 1
      `;

      return rows[0] ? this.rowToMemoryNode(rows[0]) : null;
    }

    const rows = await this.sql<MemoryNodeRow[]>`
      SELECT *
      FROM mg_memory_nodes
      WHERE id = ${memoryNodeId}::uuid
      LIMIT 1
    `;

    return rows[0] ? this.rowToMemoryNode(rows[0]) : null;
  }

  private async getMemoryNodesByIds(memoryNodeIds: string[], sessionId?: string): Promise<MemoryNode[]> {
    if (memoryNodeIds.length === 0) return [];

    if (sessionId) {
      const rows = await this.sql<MemoryNodeRow[]>`
        SELECT *
        FROM mg_memory_nodes
        WHERE id = ANY(${this.sql.array(memoryNodeIds)}::uuid[])
          AND session_id = ${sessionId}
        ORDER BY created_at ASC, id ASC
      `;

      return rows.map((row) => this.rowToMemoryNode(row));
    }

    const rows = await this.sql<MemoryNodeRow[]>`
      SELECT *
      FROM mg_memory_nodes
      WHERE id = ANY(${this.sql.array(memoryNodeIds)}::uuid[])
      ORDER BY created_at ASC, id ASC
    `;

    return rows.map((row) => this.rowToMemoryNode(row));
  }

  private async getMemoryNodesByFactKey(
    subject: string,
    predicate: string,
    options: MemoryHistoryOptions = {},
  ): Promise<MemoryNode[]> {
    const normalizedSubject = this.normalizeMemoryHistoryPart(subject);
    const normalizedPredicate = this.normalizeMemoryHistoryPart(predicate);

    if (options.sessionId) {
      const rows = await this.sql<MemoryNodeRow[]>`
        SELECT *
        FROM mg_memory_nodes
        WHERE lower(regexp_replace(trim(subject), '[[:space:]]+', ' ', 'g')) = ${normalizedSubject}
          AND lower(regexp_replace(trim(predicate), '[[:space:]]+', ' ', 'g')) = ${normalizedPredicate}
          AND session_id = ${options.sessionId}
        ORDER BY created_at ASC, id ASC
      `;

      return rows.map((row) => this.rowToMemoryNode(row));
    }

    const rows = await this.sql<MemoryNodeRow[]>`
      SELECT *
      FROM mg_memory_nodes
      WHERE lower(regexp_replace(trim(subject), '[[:space:]]+', ' ', 'g')) = ${normalizedSubject}
        AND lower(regexp_replace(trim(predicate), '[[:space:]]+', ' ', 'g')) = ${normalizedPredicate}
      ORDER BY created_at ASC, id ASC
    `;

    return rows.map((row) => this.rowToMemoryNode(row));
  }

  private async getMemoryEdgesForMemoryIds(memoryNodeIds: string[]): Promise<MemoryEdge[]> {
    if (memoryNodeIds.length === 0) return [];

    const rows = await this.sql<MemoryEdgeRow[]>`
      SELECT DISTINCT *
      FROM mg_memory_edges
      WHERE source_id = ANY(${this.sql.array(memoryNodeIds)}::uuid[])
         OR target_id = ANY(${this.sql.array(memoryNodeIds)}::uuid[])
      ORDER BY created_at ASC, id ASC
    `;

    return rows.map((row) => this.rowToMemoryEdge(row));
  }

  private buildMemoryHistoryResult(
    memories: MemoryNode[],
    edges: MemoryEdge[],
    metadata: {
      anchorMemoryId?: string;
      subject?: string;
      predicate?: string;
      sessionId?: string;
    },
  ): MemoryHistoryResult {
    const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
    const visibleEdges = edges.filter((edge) => memoriesById.has(edge.sourceId) && memoriesById.has(edge.targetId));
    const sortedMemories = [...memories].sort((left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime()
      || left.id.localeCompare(right.id)
    );
    const entries: MemoryHistoryEntry[] = sortedMemories.map((memory, index) => {
      const updateEdges = visibleEdges.filter((edge) =>
        edge.edgeType === "updates"
        && (edge.sourceId === memory.id || edge.targetId === memory.id)
      );
      const conflictEdges = visibleEdges.filter((edge) =>
        edge.edgeType === "conflicts"
        && (edge.sourceId === memory.id || edge.targetId === memory.id)
      );
      const supersedes = [
        ...sortedMemories
          .filter((candidate) => candidate.supersededBy === memory.id)
          .map((candidate) => candidate.id),
        ...updateEdges
          .filter((edge) => edge.sourceId === memory.id)
          .map((edge) => edge.targetId),
      ];
      const conflictsWith = conflictEdges.map((edge) =>
        edge.sourceId === memory.id ? edge.targetId : edge.sourceId
      );

      return {
        memory,
        versionIndex: index,
        status: this.resolveMemoryHistoryStatus(memory, conflictEdges),
        supersedes: [...new Set(supersedes)],
        supersededBy: memory.supersededBy,
        conflictsWith: [...new Set(conflictsWith)],
        updateEdges,
        conflictEdges,
        createdAt: memory.createdAt,
      };
    });

    return {
      ...metadata,
      entries,
      edges: visibleEdges,
      currentMemory: this.resolveCurrentMemory(sortedMemories),
    };
  }

  private resolveMemoryHistoryStatus(memory: MemoryNode, conflictEdges: MemoryEdge[]): MemoryHistoryStatus {
    if (memory.forgotten) return "forgotten";
    if (memory.decayed) return "decayed";
    if (memory.supersededBy != null) return "superseded";
    if (memory.hasConflict || conflictEdges.length > 0) return "conflicting";
    return "active";
  }

  private resolveCurrentMemory(memories: MemoryNode[]): MemoryNode | null {
    return [...memories]
      .filter((memory) => !memory.forgotten && !memory.decayed && memory.supersededBy == null)
      .sort((left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime()
        || right.id.localeCompare(left.id)
      )[0] ?? null;
  }

  private getConnectedMemoryIds(edges: MemoryEdge[]): string[] {
    return [...new Set(edges.flatMap((edge) => [edge.sourceId, edge.targetId]))];
  }

  private diffMemoryFields(from: MemoryNode, to: MemoryNode): MemoryDiffField[] {
    const fields: Array<keyof MemoryNode> = [
      "sessionId",
      "topicNodeId",
      "agentId",
      "memoryType",
      "sourceType",
      "subject",
      "predicate",
      "value",
      "confidence",
      "tags",
      "source",
      "sourceUrl",
      "sourceTitle",
      "provenance",
      "supersededBy",
      "decayed",
      "forgotten",
      "forgottenAt",
      "hasConflict",
      "agentColor",
      "fleetId",
      "createdAt",
    ];

    return fields.map((field) => ({
      field,
      from: from[field],
      to: to[field],
      changed: !this.memoryDiffValuesEqual(from[field], to[field]),
    }));
  }

  private memoryDiffValuesEqual(left: unknown, right: unknown): boolean {
    if (left instanceof Date && right instanceof Date) {
      return left.getTime() === right.getTime();
    }

    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  private normalizeMemoryHistoryPart(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private async deleteEdgesByNodeIds(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    await this.sql`
      DELETE FROM mg_topic_edges
      WHERE src_id = ANY(${this.sql.array(nodeIds)})
         OR dst_id = ANY(${this.sql.array(nodeIds)})
    `;
  }

  async rebuildEdgesForSession(sessionId: string, semanticTopK = 5, semanticThreshold = 0.6): Promise<void> {
    const nodes = await this.getNodesBySession(sessionId);
    const nodeIds = nodes.map((node) => node.id);

    if (nodeIds.length > 0) {
      await this.sql`
        DELETE FROM mg_topic_edges
        WHERE type != 'grafted'
          AND (
            src_id = ANY(${this.sql.array(nodeIds)})
            OR dst_id = ANY(${this.sql.array(nodeIds)})
          )
      `;
    }

    for (let index = 1; index < nodes.length; index += 1) {
      const current = nodes[index];
      const previous = nodes[index - 1];
      if (!current || !previous) continue;

      await this.saveEdge({
        srcId: current.id,
        dstId: previous.id,
        weight: await this.nodeSimilarity(current.id, previous.id),
        type: "temporal",
      });
    }

    for (const node of nodes) {
      const similarNodes = await this.getSimilarNodes(node.embedding, sessionId, {
        k: semanticTopK,
        excludeNodeId: node.id,
        minSimilarity: semanticThreshold,
      });

      for (const similarNode of similarNodes) {
        await this.saveEdge({
          srcId: node.id,
          dstId: similarNode.id,
          weight: await this.nodeSimilarity(node.id, similarNode.id),
          type: "semantic",
        });
      }
    }
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  private async getExistingExtensions(extensionNames: readonly string[]): Promise<Set<string>> {
    if (extensionNames.length === 0) return new Set();

    const rows = await this.sql<{ extname: string }[]>`
      SELECT extname
      FROM pg_extension
    `;
    const expected = new Set(extensionNames);

    return new Set(rows.map((row) => row.extname).filter((name) => expected.has(name)));
  }

  private async getExistingTables(tableNames: readonly string[]): Promise<Set<string>> {
    if (tableNames.length === 0) return new Set();

    const rows = await this.sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
    const expected = new Set(tableNames);

    return new Set(rows.map((row) => row.table_name).filter((name) => expected.has(name)));
  }

  private async getExistingIndexes(indexNames: readonly string[]): Promise<Set<string>> {
    if (indexNames.length === 0) return new Set();

    const rows = await this.sql<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
    `;
    const expected = new Set(indexNames);

    return new Set(rows.map((row) => row.indexname).filter((name) => expected.has(name)));
  }

  private async migrateExistingNodeTable(): Promise<void> {
    await this.sql`ALTER TABLE mg_segments DROP COLUMN IF EXISTS node_id`;
    await this.sql`ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS segment_id TEXT`;
    await this.sql`ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS topic_order INT NOT NULL DEFAULT 0`;
    await this.sql`ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS drift_score FLOAT NOT NULL DEFAULT 0`;
    await this.sql`ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS agent_color TEXT`;
    await this.sql`ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS fleet_id TEXT`;
    await this.sql`ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS agent_id TEXT`;

    await this.sql`
      UPDATE mg_topic_nodes n
      SET
        topic_order = s.topic_order,
        drift_score = s.drift_score
      FROM mg_segments s
      WHERE s.id = n.segment_id
    `;

    await this.sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'mg_topic_nodes_segment_id_key'
        ) THEN
          ALTER TABLE mg_topic_nodes
          ADD CONSTRAINT mg_topic_nodes_segment_id_key UNIQUE (segment_id);
        END IF;
      END $$;
    `;
  }

  private async createIndexes(): Promise<void> {
    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_message_buffer_session_idx
      ON mg_message_buffer(session_id, message_index)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_segments_session_idx
      ON mg_segments(session_id, topic_order)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_nodes_session_idx
      ON mg_topic_nodes(session_id, topic_order)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_topic_nodes_active_lifecycle
      ON mg_topic_nodes(session_id, suppressed)
      WHERE suppressed = FALSE
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_topic_nodes_pinned_idx
      ON mg_topic_nodes(session_id, pinned_at)
      WHERE pinned = TRUE
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_topic_nodes_tags_idx
      ON mg_topic_nodes USING GIN(tags)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_nodes_fleet_idx
      ON mg_topic_nodes(fleet_id, agent_color)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_fleet_agents_fleet_idx
      ON mg_fleet_agents(fleet_id, agent_color)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_sessions_label_lower_idx
      ON mg_sessions(lower(label))
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_session_ingest_state_updated_idx
      ON mg_session_ingest_state(updated_at)
    `;

    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS mg_ingestion_runs_idempotency_idx ON mg_ingestion_runs(session_id,idempotency_key) WHERE idempotency_key IS NOT NULL`;
    await this.sql`CREATE INDEX IF NOT EXISTS mg_ingestion_runs_session_status_idx ON mg_ingestion_runs(session_id,status)`;
    await this.sql`CREATE INDEX IF NOT EXISTS mg_ingestion_runs_pending_idx ON mg_ingestion_runs(status,retryable,updated_at)`;
    await this.sql`CREATE INDEX IF NOT EXISTS mg_ingestion_runs_lease_idx ON mg_ingestion_runs(lease_expires_at) WHERE status='running'`;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_graft_registry_session
      ON mg_graft_registry(session_id)
    `;

    await this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_graft_registry_node_unique
      ON mg_graft_registry(node_id)
    `;

    await this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_graft_registry_source_target_unique
      ON mg_graft_registry(session_id, source_session_id, source_node_id)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_graft_registry_source
      ON mg_graft_registry(source_session_id, source_node_id)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS mg_nodes_embedding_idx
      ON mg_topic_nodes
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_topic
      ON mg_memory_nodes(topic_node_id)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_segment
      ON mg_memory_nodes(segment_id)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_session
      ON mg_memory_nodes(session_id)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_active_lifecycle
      ON mg_memory_nodes(session_id, forgotten, decayed)
      WHERE forgotten = FALSE
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_tags
      ON mg_memory_nodes USING GIN(tags)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_embedding
      ON mg_memory_nodes
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_memory_edges_source
      ON mg_memory_edges(source_id)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_memory_edges_target
      ON mg_memory_edges(target_id)
    `;
  }

  private cleanAssistantMessage(content: string, maxChars: number): string {
    const withoutCodeBlocks = content.replace(/```[\s\S]*?```/g, "[code omitted]");
    if (withoutCodeBlocks.length <= maxChars) return withoutCodeBlocks;

    const truncated = withoutCodeBlocks.slice(0, maxChars);
    const sentenceEnd = Math.max(
      truncated.lastIndexOf("."),
      truncated.lastIndexOf("!"),
      truncated.lastIndexOf("?"),
    );

    if (sentenceEnd >= Math.floor(maxChars * 0.5)) {
      return `${truncated.slice(0, sentenceEnd + 1)} [truncated]`;
    }

    return `${truncated.trimEnd()} [truncated]`;
  }

  private topicTagsFilterSql(tags: string[], tagMode: TagFilterOptions["tagMode"] = "all", tableAlias?: "topic") {
    if (tags.length === 0) return this.sql``;

    if (tableAlias === "topic") {
      return tagMode === "any"
        ? this.sql`AND topic.tags && ${this.sql.array(tags)}::text[]`
        : this.sql`AND topic.tags @> ${this.sql.array(tags)}::text[]`;
    }

    return tagMode === "any"
      ? this.sql`AND tags && ${this.sql.array(tags)}::text[]`
      : this.sql`AND tags @> ${this.sql.array(tags)}::text[]`;
  }

  private memoryTagsFilterSql(tags: string[], tagMode: TagFilterOptions["tagMode"] = "all", tableAlias?: string) {
    if (tags.length === 0) return this.sql``;

    if (tableAlias === "memory") {
      return tagMode === "any"
        ? this.sql`AND memory.tags && ${this.sql.array(tags)}::text[]`
        : this.sql`AND memory.tags @> ${this.sql.array(tags)}::text[]`;
    }

    return tagMode === "any"
      ? this.sql`AND tags && ${this.sql.array(tags)}::text[]`
      : this.sql`AND tags @> ${this.sql.array(tags)}::text[]`;
  }

  private async getNextMessageIndex(sessionId: string): Promise<number> {
    const rows = await this.sql<{ next_index: number | null }[]>`
      SELECT COALESCE(MAX(message_index) + 1, 0) AS next_index
      FROM mg_message_buffer
      WHERE session_id = ${sessionId}
    `;

    return rows[0]?.next_index ?? 0;
  }

  private async getNextTopicOrder(sessionId: string): Promise<number> {
    const rows = await this.sql<{ next_order: number | null }[]>`
      SELECT COALESCE(MAX(topic_order) + 1, 1) AS next_order
      FROM mg_topic_nodes
      WHERE session_id = ${sessionId}
    `;

    return rows[0]?.next_order ?? 1;
  }

  private formatGraftedMemoryMessage(node: TopicNode): string {
    return [
      `Grafted memory: ${node.label}`,
      node.summary,
    ].filter(Boolean).join("\n");
  }

  private rowToNode(row: TopicNodeRow): TopicNode {
    const [start = 0, end = start] = row.message_range ?? [];

    return {
      id: row.id,
      sessionId: row.session_id,
      segmentId: row.segment_id,
      label: row.label ?? "Untitled topic",
      summary: row.summary ?? "",
      embedding: parseVector(row.embedding),
      tags: normalizeTags(row.tags ?? []),
      ...(row.source ? { source: row.source } : {}),
      messageRange: [start, end],
      topicOrder: row.topic_order ?? 0,
      driftScore: row.drift_score ?? 0,
      agentColor: row.agent_color,
      fleetId: row.fleet_id,
      agentId: row.agent_id,
      suppressed: row.suppressed ?? false,
      suppressedAt: row.suppressed_at,
      pinned: row.pinned ?? false,
      pinnedAt: row.pinned_at,
      createdAt: row.created_at,
    };
  }

  private rowToMemoryNode(row: MemoryNodeRow): MemoryNode {
    return {
      id: row.id,
      segmentId: row.segment_id,
      topicNodeId: row.topic_node_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      memoryType: row.memory_type,
      sourceType: row.source_type,
      subject: row.subject,
      predicate: row.predicate,
      value: row.value,
      confidence: row.confidence,
      embedding: parseVector(row.embedding),
      tags: normalizeTags(row.tags ?? []),
      ...(row.source ? { source: row.source } : {}),
      sourceUrl: row.source_url,
      sourceTitle: row.source_title,
      provenance: row.provenance_speaker && row.provenance_message_indexes && row.provenance_session_id && row.extraction_method
        ? { speaker: row.provenance_speaker, messageIndexes: row.provenance_message_indexes, sessionId: row.provenance_session_id, extractionMethod: row.extraction_method }
        : null,
      supersededBy: row.superseded_by,
      decayed: row.decayed,
      forgotten: row.forgotten ?? false,
      forgottenAt: row.forgotten_at,
      hasConflict: row.has_conflict ?? false,
      agentColor: row.agent_color,
      fleetId: row.fleet_id,
      createdAt: row.created_at,
    };
  }

  private rowToMemoryEdge(row: MemoryEdgeRow): MemoryEdge {
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      edgeType: row.edge_type,
      weight: row.weight ?? 1,
      createdAt: row.created_at,
    };
  }

  private rowToSessionIngestState(row: SessionIngestStateRow): SessionIngestState {
    return {
      sessionId: row.session_id,
      lastIngestedMessageIndex: row.last_ingested_message_index,
      updatedAt: row.updated_at,
    };
  }

  private rowToIngestionRun(row: IngestionRunRow): IngestionRun {
    return { id: row.id, sessionId: row.session_id, kind: row.kind, startIndex: row.start_index, endIndex: row.end_index,
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}), status: row.status, attemptCount: row.attempt_count,
      ...(row.queued_at ? { queuedAt: row.queued_at } : {}), ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}), ...(row.failed_at ? { failedAt: row.failed_at } : {}),
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}), ...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {}),
      ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}), ...(row.last_error_stage ? { lastErrorStage: row.last_error_stage } : {}),
      ...(row.last_error_safe_message ? { lastErrorSafeMessage: row.last_error_safe_message } : {}), ...(row.retryable !== null ? { retryable: row.retryable } : {}),
      ...(row.worker_id ? { workerId: row.worker_id } : {}), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private ingestionInvariant(message: string, sessionId?: string, runId?: string): MemoGrafterError {
    return new MemoGrafterError(message, { code: "INGESTION_INVARIANT_VIOLATION", operation: "ingest", retryable: false, context: { ...(sessionId ? { sessionId } : {}), ...(runId ? { jobId: runId } : {}) } });
  }

  private rowToGraftRegistryEntry(row: GraftRegistryRow | undefined): GraftRegistryEntry {
    if (!row) {
      throw new Error("Expected graft registry row.");
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      nodeId: row.node_id,
      sourceSessionId: row.source_session_id,
      sourceNodeId: row.source_node_id,
      graftedAt: row.grafted_at,
    };
  }

  private rowToSegment(row: TopicSegmentRow | undefined): TopicSegment {
    if (!row) {
      throw new Error("Expected segment row.");
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      startIndex: row.start_index,
      endIndex: row.end_index,
      topicOrder: row.topic_order,
      driftScore: row.drift_score,
      createdAt: row.created_at,
    };
  }
}
