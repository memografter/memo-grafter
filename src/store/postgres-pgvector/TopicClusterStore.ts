import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { TopicCluster, TopicClusterMetadata } from "../../core/types.js";
import type { ClusterDecision } from "../GraphStore.js";
import { parseVector, toVectorLiteral } from "../../utils/vector/vectorLiteral.js";

interface ClusterRow {
  id: string; session_id: string; label: string; normalized_label: string;
  description: string; aliases: string[]; embedding?: string | number[] | null; revision: number;
  created_at: Date; updated_at: Date;
}

function metadata(row: ClusterRow): Omit<TopicCluster, "embedding"> {
  return { id: row.id, sessionId: row.session_id, label: row.label, normalizedLabel: row.normalized_label,
    description: row.description, aliases: row.aliases ?? [], revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}

function catalogRevision(rows: Array<{ id: string; revision: number }>): string {
  return createHash("sha256").update(JSON.stringify(rows.map(row => [row.id, row.revision]))).digest("hex");
}

/** Domain catalogs are small and session-scoped. Only the classifier's top K reach the provider. */
export class TopicClusterStore {
  constructor(private readonly sql: Sql) {}

  async catalog(sessionId: string): Promise<{ clusters: TopicCluster[]; revision: string }> {
    const rows = await this.sql<ClusterRow[]>`SELECT * FROM mg_topic_clusters WHERE session_id=${sessionId} ORDER BY id`;
    return { clusters: rows.map(row => ({ ...metadata(row), embedding: parseVector(row.embedding ?? null) })), revision: catalogRevision(rows) };
  }

  async list(sessionId: string): Promise<Array<Omit<TopicCluster, "embedding">>> {
    const rows = await this.sql<ClusterRow[]>`SELECT id,session_id,label,normalized_label,description,aliases,revision,created_at,updated_at
      FROM mg_topic_clusters WHERE session_id=${sessionId} ORDER BY label,id`;
    return rows.map(metadata);
  }

  async forTopics(topics: Array<{ id: string; sessionId: string }>): Promise<TopicClusterMetadata> {
    if (!topics.length) return { clusters: [], topicClusters: [] };
    // Match exact (topic, session) pairs, including episode-only selections. Never trust cached cluster IDs.
    const rows = await this.sql<Array<ClusterRow & { topic_id: string }>>`
      SELECT cluster.id,cluster.session_id,cluster.label,cluster.normalized_label,cluster.description,cluster.aliases,
        cluster.revision,cluster.created_at,cluster.updated_at,topic.id AS topic_id
      FROM unnest(${this.sql.array(topics.map(topic => topic.id))}::text[], ${this.sql.array(topics.map(topic => topic.sessionId))}::text[]) requested(id,session_id)
      JOIN mg_topic_nodes topic ON topic.id=requested.id AND topic.session_id=requested.session_id
      JOIN mg_topic_clusters cluster ON cluster.id=topic.cluster_id AND cluster.session_id=topic.session_id
      WHERE topic.suppressed=FALSE ORDER BY cluster.id,topic.id`;
    return { clusters: [...new Map(rows.map(row => [row.id, metadata(row)])).values()],
      topicClusters: [...new Map(rows.map(row => [row.topic_id, { topicId: row.topic_id, clusterId: row.id }])).values()] };
  }

  async commit(decision: ClusterDecision): Promise<"saved" | "stale"> {
    const result = await this.sql.begin(async tx => {
      // Serializes final decisions across workers, without holding locks during provider calls.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`topic-clusters:${decision.sessionId}`}, 0))`;
      const topics = await tx<{ revision: number; cluster_id: string | null }[]>`SELECT revision,cluster_id FROM mg_topic_nodes
        WHERE id=${decision.topicId} AND session_id=${decision.sessionId} AND suppressed=FALSE FOR UPDATE`;
      if (!topics[0] || topics[0].revision !== decision.expectedTopicRevision || topics[0].cluster_id) return "stale";
      const rows = await tx<{ id: string; revision: number }[]>`SELECT id,revision FROM mg_topic_clusters WHERE session_id=${decision.sessionId} ORDER BY id`;
      if (catalogRevision(rows) !== decision.expectedCatalogRevision) return "stale";
      const cluster = decision.cluster;
      if (cluster) {
        if (cluster.sessionId !== decision.sessionId) throw new Error("Cluster and topic must belong to the same session.");
        if (!rows.some(row => row.id === cluster.id)) {
          await tx`INSERT INTO mg_topic_clusters (id,session_id,label,normalized_label,description,embedding)
            VALUES (${cluster.id}::uuid,${cluster.sessionId},${cluster.label},${cluster.normalizedLabel},${cluster.description},${toVectorLiteral(cluster.embedding)}::vector)`;
        }
        if (decision.assignment.method === "verified" && decision.verifiedAlias && decision.verifiedAlias !== cluster.normalizedLabel) {
          await tx`UPDATE mg_topic_clusters SET aliases=array_append(aliases,${decision.verifiedAlias}),revision=revision+1,updated_at=NOW()
            WHERE id=${cluster.id}::uuid AND session_id=${decision.sessionId} AND NOT (${decision.verifiedAlias}=ANY(aliases))`;
        }
      }
      await tx`UPDATE mg_topic_nodes SET cluster_id=${cluster?.id ?? null}::uuid,cluster_assignment=${JSON.stringify(decision.assignment)}::jsonb
        WHERE id=${decision.topicId} AND session_id=${decision.sessionId}`;
      return "saved";
    });
    return result as "saved" | "stale";
  }

  async delete(sessionId: string, clusterId: string): Promise<boolean> {
    const result = await this.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`topic-clusters:${sessionId}`}, 0))`;
      const rows = await tx`DELETE FROM mg_topic_clusters WHERE session_id=${sessionId} AND id=${clusterId}::uuid RETURNING id`;
      return rows.length > 0;
    });
    return result as boolean;
  }
}
