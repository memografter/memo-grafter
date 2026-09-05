interface StudioMemoryQuality { explicitness: number; sourceReliability: number; stability: number; salience: number }
import type { Sql } from "postgres";

export interface StudioSessionSummary {
  id: string;
  label: string | null;
  displayLabel: string;
  messageCount: number;
  topicCount: number;
  memoryCount: number;
  lastUpdatedAt: Date | null;
}

export interface StudioTopicEdge {
  srcId: string;
  dstId: string;
  weight: number;
  type: string;
}

export interface StudioMemorySearchResult {
  id: string;
  segmentId: string;
  topicNodeId: string;
  agentId: string | null;
  sessionId: string;
  memoryType: string;
  sourceType: string;
  subject: string;
  predicate: string;
  value: string;
  quality: StudioMemoryQuality;
  tags?: string[];
  source?: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  supersededBy: string | null;
  decayed: boolean;
  forgotten: boolean;
  forgottenAt: Date | null;
  hasConflict: boolean;
  agentColor: string | null;
  fleetId: string | null;
  createdAt: Date;
}

export interface StudioTopicSearchResult {
  id: string;
  sessionId: string;
  segmentId: string;
  label: string;
  summary: string;
  tags?: string[];
  source: string | null;
  messageRange: number[] | null;
  topicOrder: number;
  driftScore: number;
  agentColor: string | null;
  fleetId: string | null;
  agentId: string | null;
  suppressed: boolean;
  suppressedAt: Date | null;
  pinned: boolean;
  pinnedAt: Date | null;
  createdAt: Date;
}

export interface StudioMemoryEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: string;
  weight: number;
  createdAt: Date;
}

export interface StudioTableBrowserTable {
  name: string;
  rows: Record<string, unknown>[];
}

interface SessionSummaryRow {
  id: string;
  label: string | null;
  first_topic_label: string | null;
  first_message_content: string | null;
  message_count: number | null;
  topic_count: number | null;
  memory_count: number | null;
  last_updated_at: Date | null;
}

interface TopicEdgeRow {
  src_id: string;
  dst_id: string;
  weight: number;
  type: string;
}

interface TopicSearchRow {
  id: string;
  session_id: string;
  segment_id: string;
  label: string;
  summary: string;
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

interface MemoryRow {
  id: string;
  segment_id: string;
  topic_node_id: string;
  agent_id: string | null;
  session_id: string;
  memory_type: string;
  source_type: string;
  subject: string;
  predicate: string;
  value: string;
  quality_explicitness: number;
  quality_source_reliability: number;
  quality_stability: number;
  quality_salience: number;
  quality_defaulted: Array<keyof StudioMemoryQuality> | null;
  quality_origin: "extracted" | "provided" | "legacy";
  quality_updated_at: Date | null;
  tags: string[] | null;
  source: string | null;
  source_url: string | null;
  source_title: string | null;
  superseded_by: string | null;
  decayed: boolean;
  forgotten: boolean | null;
  forgotten_at: Date | null;
  has_conflict: boolean | null;
  agent_color: string | null;
  fleet_id: string | null;
  created_at: Date;
}

interface MemoryEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  weight: number | null;
  created_at: Date;
}

export class StudioRepository {
  constructor(private readonly sql: Sql) {}

  async listSessions(query?: string): Promise<StudioSessionSummary[]> {
    const normalizedQuery = query?.trim() ?? "";
    const pattern = `%${normalizedQuery}%`;
    const rows = await this.sql<SessionSummaryRow[]>`
      WITH sessions AS (
        SELECT session_id FROM mg_sessions
        UNION
        SELECT session_id FROM mg_message_buffer
        UNION
        SELECT session_id FROM mg_segments
        UNION
        SELECT session_id FROM mg_topic_nodes
        UNION
        SELECT session_id FROM mg_memory_nodes
        UNION
        SELECT session_id FROM mg_session_ingest_state
      ),
      message_counts AS (
        SELECT session_id, COUNT(*)::int AS message_count, MAX(message_index)::int AS last_message_index
        FROM mg_message_buffer
        GROUP BY session_id
      ),
      topic_counts AS (
        SELECT session_id, COUNT(*)::int AS topic_count, MAX(created_at) AS last_topic_at
        FROM mg_topic_nodes
        GROUP BY session_id
      ),
      memory_counts AS (
        SELECT session_id, COUNT(*)::int AS memory_count, MAX(created_at) AS last_memory_at
        FROM mg_memory_nodes
        GROUP BY session_id
      ),
      ingest_updates AS (
        SELECT session_id, MAX(updated_at) AS last_ingest_at
        FROM mg_session_ingest_state
        GROUP BY session_id
      ),
      first_topics AS (
        SELECT DISTINCT ON (session_id)
          session_id,
          label AS first_topic_label
        FROM mg_topic_nodes
        WHERE label IS NOT NULL AND trim(label) != ''
        ORDER BY session_id ASC, topic_order ASC, created_at ASC, id ASC
      ),
      first_messages AS (
        SELECT DISTINCT ON (session_id)
          session_id,
          content AS first_message_content
        FROM mg_message_buffer
        WHERE role = 'user' AND trim(content) != ''
        ORDER BY session_id ASC, message_index ASC
      )
      SELECT
        sessions.session_id AS id,
        meta.label AS label,
        first_topics.first_topic_label,
        first_messages.first_message_content,
        COALESCE(message_counts.message_count, 0)::int AS message_count,
        COALESCE(topic_counts.topic_count, 0)::int AS topic_count,
        COALESCE(memory_counts.memory_count, 0)::int AS memory_count,
        GREATEST(topic_counts.last_topic_at, memory_counts.last_memory_at, ingest_updates.last_ingest_at, meta.updated_at) AS last_updated_at
      FROM sessions
      LEFT JOIN mg_sessions meta ON meta.session_id = sessions.session_id
      LEFT JOIN message_counts ON message_counts.session_id = sessions.session_id
      LEFT JOIN topic_counts ON topic_counts.session_id = sessions.session_id
      LEFT JOIN memory_counts ON memory_counts.session_id = sessions.session_id
      LEFT JOIN ingest_updates ON ingest_updates.session_id = sessions.session_id
      LEFT JOIN first_topics ON first_topics.session_id = sessions.session_id
      LEFT JOIN first_messages ON first_messages.session_id = sessions.session_id
      WHERE ${normalizedQuery ? this.sql`
        sessions.session_id ILIKE ${pattern}
        OR meta.label ILIKE ${pattern}
        OR first_topics.first_topic_label ILIKE ${pattern}
        OR first_messages.first_message_content ILIKE ${pattern}
      ` : this.sql`TRUE`}
      ORDER BY last_updated_at DESC NULLS LAST, sessions.session_id ASC
    `;

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      displayLabel: this.resolveDisplayLabel(row),
      messageCount: row.message_count ?? 0,
      topicCount: row.topic_count ?? 0,
      memoryCount: row.memory_count ?? 0,
      lastUpdatedAt: row.last_updated_at,
    }));
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM mg_sessions WHERE session_id = ${sessionId}
        UNION
        SELECT 1 FROM mg_message_buffer WHERE session_id = ${sessionId}
        UNION
        SELECT 1 FROM mg_segments WHERE session_id = ${sessionId}
        UNION
        SELECT 1 FROM mg_topic_nodes WHERE session_id = ${sessionId}
        UNION
        SELECT 1 FROM mg_memory_nodes WHERE session_id = ${sessionId}
        UNION
        SELECT 1 FROM mg_session_ingest_state WHERE session_id = ${sessionId}
      ) AS exists
    `;

    return rows[0]?.exists ?? false;
  }

  async upsertSessionLabel(sessionId: string, label: string | null): Promise<void> {
    await this.sql`
      INSERT INTO mg_sessions (session_id, label, updated_at)
      VALUES (${sessionId}, ${label}, NOW())
      ON CONFLICT (session_id)
      DO UPDATE SET
        label = EXCLUDED.label,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async nodeBelongsToSession(sessionId: string, nodeId: string): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM mg_topic_nodes
        WHERE session_id = ${sessionId}
          AND id = ${nodeId}
      ) AS exists
    `;

    return rows[0]?.exists ?? false;
  }

  async getTopicEdgesBySession(sessionId: string): Promise<StudioTopicEdge[]> {
    const rows = await this.sql<TopicEdgeRow[]>`
      SELECT DISTINCT edge.*
      FROM mg_topic_edges edge
      JOIN mg_topic_nodes source ON source.id = edge.src_id
      JOIN mg_topic_nodes target ON target.id = edge.dst_id
      WHERE source.session_id = ${sessionId}
         OR target.session_id = ${sessionId}
      ORDER BY edge.type ASC, edge.src_id ASC, edge.dst_id ASC
    `;

    return rows.map((row) => ({
      srcId: row.src_id,
      dstId: row.dst_id,
      weight: row.weight,
      type: row.type,
    }));
  }

  async getMemoryEdgesBySession(sessionId: string): Promise<StudioMemoryEdge[]> {
    const rows = await this.sql<MemoryEdgeRow[]>`
      SELECT DISTINCT edge.*
      FROM mg_memory_edges edge
      JOIN mg_memory_nodes source ON source.id = edge.source_id
      JOIN mg_memory_nodes target ON target.id = edge.target_id
      WHERE source.session_id = ${sessionId}
        AND target.session_id = ${sessionId}
      ORDER BY edge.created_at ASC, edge.id ASC
    `;

    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      edgeType: row.edge_type,
      weight: row.weight ?? 1,
      createdAt: row.created_at,
    }));
  }

  async getTablesBySession(sessionId: string): Promise<StudioTableBrowserTable[]> {
    const [
      messageBuffer,
      segments,
      topicNodes,
      topicEdges,
      memoryNodes,
      memoryEdges,
      fleets,
      fleetAgents,
      sessionMetadata,
      ingestState,
      graftRegistry,
    ] = await Promise.all([
      this.sql<Record<string, unknown>[]>`
        SELECT session_id, message_index, role, content
        FROM mg_message_buffer
        WHERE session_id = ${sessionId}
        ORDER BY message_index ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT id, session_id, start_index, end_index, topic_order, drift_score, created_at
        FROM mg_segments
        WHERE session_id = ${sessionId}
        ORDER BY topic_order ASC, start_index ASC, id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT
          id,
          session_id,
          segment_id,
          label,
          summary,
          embedding::text AS embedding,
          tags,
          source,
          message_range,
          topic_order,
          drift_score,
          agent_color,
          fleet_id,
          agent_id,
          suppressed,
          suppressed_at,
          pinned,
          pinned_at,
          created_at
        FROM mg_topic_nodes
        WHERE session_id = ${sessionId}
        ORDER BY topic_order ASC, message_range ASC, id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT DISTINCT edge.src_id, edge.dst_id, edge.weight, edge.type
        FROM mg_topic_edges edge
        JOIN mg_topic_nodes source ON source.id = edge.src_id
        JOIN mg_topic_nodes target ON target.id = edge.dst_id
        WHERE source.session_id = ${sessionId}
           OR target.session_id = ${sessionId}
        ORDER BY edge.type ASC, edge.src_id ASC, edge.dst_id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT
          id,
          segment_id,
          topic_node_id,
          agent_id,
          session_id,
          memory_type,
          source_type,
          subject,
          predicate,
          value,
          quality_explicitness,quality_source_reliability,quality_stability,quality_salience,
          embedding::text AS embedding,
          tags,
          source,
          source_url,
          source_title,
          superseded_by,
          decayed,
          forgotten,
          forgotten_at,
          has_conflict,
          agent_color,
          fleet_id,
          created_at
        FROM mg_memory_nodes
        WHERE session_id = ${sessionId}
        ORDER BY created_at ASC, id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT DISTINCT edge.id, edge.source_id, edge.target_id, edge.edge_type, edge.weight, edge.created_at
        FROM mg_memory_edges edge
        JOIN mg_memory_nodes source ON source.id = edge.source_id
        JOIN mg_memory_nodes target ON target.id = edge.target_id
        WHERE source.session_id = ${sessionId}
          AND target.session_id = ${sessionId}
        ORDER BY edge.created_at ASC, edge.id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT DISTINCT fleet.id, fleet.name, fleet.created_at
        FROM mg_fleets fleet
        JOIN mg_fleet_agents agent ON agent.fleet_id = fleet.id
        WHERE agent.session_id = ${sessionId}
        ORDER BY fleet.created_at ASC, fleet.id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT id, fleet_id, session_id, agent_color, created_at
        FROM mg_fleet_agents
        WHERE session_id = ${sessionId}
        ORDER BY created_at ASC, id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT session_id, label, description, tags, created_at, updated_at
        FROM mg_sessions
        WHERE session_id = ${sessionId}
        ORDER BY updated_at DESC, session_id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT session_id, last_ingested_message_index, updated_at
        FROM mg_session_ingest_state
        WHERE session_id = ${sessionId}
        ORDER BY updated_at DESC, session_id ASC
      `,
      this.sql<Record<string, unknown>[]>`
        SELECT id, session_id, node_id, source_session_id, source_node_id, grafted_at
        FROM mg_graft_registry
        WHERE session_id = ${sessionId}
        ORDER BY grafted_at ASC, id ASC
      `,
    ]);

    return [
      { name: "mg_message_buffer", rows: messageBuffer },
      { name: "mg_segments", rows: segments },
      { name: "mg_topic_nodes", rows: topicNodes },
      { name: "mg_topic_edges", rows: topicEdges },
      { name: "mg_memory_nodes", rows: memoryNodes },
      { name: "mg_memory_edges", rows: memoryEdges },
      { name: "mg_fleets", rows: fleets },
      { name: "mg_fleet_agents", rows: fleetAgents },
      { name: "mg_sessions", rows: sessionMetadata },
      { name: "mg_session_ingest_state", rows: ingestState },
      { name: "mg_graft_registry", rows: graftRegistry },
    ];
  }

  async searchMemories(sessionId: string, query: string, limit = 25): Promise<StudioMemorySearchResult[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const pattern = `%${query}%`;
    const rows = await this.sql<MemoryRow[]>`
      SELECT memory.*
      FROM mg_memory_nodes memory
      JOIN mg_topic_nodes topic ON topic.id = memory.topic_node_id
      WHERE memory.session_id = ${sessionId}
        AND memory.forgotten = FALSE
        AND memory.decayed = FALSE
        AND memory.superseded_by IS NULL
        AND topic.suppressed = FALSE
        AND (
          memory.subject ILIKE ${pattern}
          OR memory.predicate ILIKE ${pattern}
          OR memory.value ILIKE ${pattern}
        )
      ORDER BY memory.created_at DESC, memory.id ASC
      LIMIT ${boundedLimit}
    `;

    return rows.map((row) => this.rowToMemory(row));
  }

  async searchTopics(sessionId: string, query: string, limit = 25): Promise<StudioTopicSearchResult[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const pattern = `%${query}%`;
    const rows = await this.sql<TopicSearchRow[]>`
      SELECT topic.*
      FROM mg_topic_nodes topic
      WHERE topic.session_id = ${sessionId}
        AND (
          topic.id ILIKE ${pattern}
          OR topic.label ILIKE ${pattern}
          OR topic.summary ILIKE ${pattern}
          OR topic.source ILIKE ${pattern}
          OR EXISTS (
            SELECT 1
            FROM unnest(topic.tags) tag
            WHERE tag ILIKE ${pattern}
          )
        )
      ORDER BY topic.topic_order ASC, topic.created_at DESC, topic.id ASC
      LIMIT ${boundedLimit}
    `;

    return rows.map((row) => this.rowToTopicSearchResult(row));
  }

  private rowToTopicSearchResult(row: TopicSearchRow): StudioTopicSearchResult {
    return {
      id: row.id,
      sessionId: row.session_id,
      segmentId: row.segment_id,
      label: row.label,
      summary: row.summary,
      tags: row.tags ?? [],
      source: row.source,
      messageRange: row.message_range,
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

  private rowToMemory(row: MemoryRow): StudioMemorySearchResult {
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
      quality: { explicitness: row.quality_explicitness ?? 0.5, sourceReliability: row.quality_source_reliability ?? 0.5, stability: row.quality_stability ?? 0.5, salience: row.quality_salience ?? 0.5 },
      tags: row.tags ?? [],
      ...(row.source ? { source: row.source } : {}),
      sourceUrl: row.source_url,
      sourceTitle: row.source_title,
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

  private resolveDisplayLabel(row: SessionSummaryRow): string {
    const explicitLabel = row.label?.trim();
    if (explicitLabel) return explicitLabel;

    const topicLabel = row.first_topic_label?.trim();
    if (topicLabel) return topicLabel;

    const messagePreview = row.first_message_content?.trim();
    if (messagePreview) return this.truncateLabel(messagePreview);

    return this.shortSessionId(row.id);
  }

  private truncateLabel(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= 72 ? normalized : `${normalized.slice(0, 71)}...`;
  }

  private shortSessionId(sessionId: string): string {
    return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 8)}...`;
  }
}
