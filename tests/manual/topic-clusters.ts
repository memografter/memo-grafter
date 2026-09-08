/**
 * Run: npm run manual:clusters
 * Reads DATABASE_URL from the environment or .env; requires PostgreSQL 15+ with pgvector.
 * Creates a temporary schema, prints checkpoints, and removes its test data in finally.
 * Deterministic adapters test integration behavior, not real-provider classification accuracy.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PostgresGraphStore } from "../../src/store/index.js";
import { TopicClusterAssigner } from "../../src/ingestion/clustering/TopicClusterAssigner.js";
import { topicClusterMigrationSql } from "../../src/schema/topicClusterMigration.js";
import { memoGrafterTableNames } from "../../src/schema/index.js";
import { RetrieverPipeline } from "../../src/retrieval/RetrieverPipeline.js";
import type { ClusterDecision } from "../../src/store/GraphStore.js";
import type { TopicCluster, TopicNode } from "../../src/core/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required; this test uses a temporary schema and no external providers.");
const schema = `cluster_test_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const sql = postgres(url, { connect_timeout: 5, connection: { search_path: `${schema},public` }, onnotice: () => undefined });
const store = new PostgresGraphStore(url);
(store as unknown as { sql: typeof sql }).sql = sql;
const embedding = [1, ...Array<number>(1535).fill(0)];
const createdAt = new Date();

async function seed(id: string, label: string, sessionId = "s") {
  const segment = await store.saveSegment({ id: `segment-${id}`, sessionId, startIndex: id.length, endIndex: id.length,
    topicOrder: id.length, driftScore: 0, createdAt });
  const node: TopicNode = { id, sessionId, segmentId: segment.id, label, summary: `${label}: planning Japan travel.`,
    embedding, messageRange: [id.length, id.length], topicOrder: id.length, driftScore: 0,
    agentColor: null, fleetId: null, agentId: null, revision: 1, createdAt };
  await store.saveNode(node);
  return node;
}
function decision(topic: TopicNode, revision: string, label: string): ClusterDecision {
  const cluster: TopicCluster = { id: randomUUID(), sessionId: topic.sessionId, label, normalizedLabel: label.toLowerCase(),
    description: "Trips, holidays, visas and travel planning.", embedding: [1, 0], revision: 1, createdAt, updatedAt: createdAt };
  return { sessionId: topic.sessionId, topicId: topic.id, expectedTopicRevision: 1, expectedCatalogRevision: revision, cluster,
    assignment: { method: "created", similarity: null, classifierVersion: 1, topicRevision: 1,
      evaluatedAt: createdAt.toISOString(), retryAfter: null } };
}

try {
  await admin`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`;
  await admin`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await store.migrate();
  // The SDK verifier currently inspects public tables; inspect our isolated schema directly.
  const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema=${schema}`;
  assert.ok(memoGrafterTableNames.every(name => tables.some(table => table.table_name === name)), "Test schema must contain all migrated tables.");
  const a = await seed("japan", "Japan Trip");
  const b = await seed("visa-planning", "Visa Planning");
  const flights = await seed("flights", "Flights");
  const foreign = await seed("foreign", "Japan Trip", "other");
  const retriever = new RetrieverPipeline(store, { dimensions: 1536, embed: async () => embedding }, {});
  const baseline = await retriever.run("Japan travel planning", "s");
  assert.equal(baseline.nodes.length, 3, "The baseline must retrieve all three fixture topics.");
  console.log("PASS setup: three stable travel topics in an isolated schema.");

  // Simulate an existing stable-topic installation, then reapply the additive migration twice.
  await sql`ALTER TABLE mg_topic_nodes DROP COLUMN cluster_id, DROP COLUMN cluster_assignment`;
  await sql`DROP TABLE mg_topic_clusters`;
  await sql.unsafe(topicClusterMigrationSql);
  await sql.unsafe(topicClusterMigrationSql);
  assert.equal((await store.getTopicNode(a.id))?.clusterId, null);
  console.log("PASS migration: existing topics survive two applications of the cluster upgrade.");

  const catalog = await store.getTopicClusterCatalog("s");
  const first = decision(a, catalog.revision, "Travel");
  const second = decision(b, catalog.revision, "Trips");
  const outcomes = await Promise.all([store.commitTopicClusterDecision(first), store.commitTopicClusterDecision(second)]);
  assert.deepEqual([...outcomes].sort(), ["saved", "stale"]);
  const winner = (await store.getTopicClusterCatalog("s")).clusters[0]!;
  const loser = outcomes[0] === "saved" ? b : a;

  const llm = { complete: async (_messages: unknown, system?: string) => JSON.stringify(system?.startsWith("Classify")
    ? { label: "Journeys", description: "Trips, holidays, visas and travel planning.", confidence: 0.99 }
    : { action: "reuse", clusterId: winner.id, confidence: 0.99 }) };
  const assigner = new TopicClusterAssigner(store, llm, { dimensions: 2, embed: async () => [1, 0] }, { enabled: true });
  assert.deepEqual(await assigner.classify([loser, flights]), []);
  assert.equal((await store.getTopicClusters("s")).length, 1);
  assert.ok((await store.getTopicClusterCatalog("s")).clusters[0]!.aliases?.includes("journeys"));
  assert.equal((await store.getTopicNode(loser.id))?.clusterId, winner.id);
  assert.equal((await store.getTopicNode(flights.id))?.clusterId, winner.id);
  const classified = await retriever.run("Japan travel planning", "s");
  assert.deepEqual(classified.nodes.map(node => node.id), baseline.nodes.map(node => node.id));
  assert.deepEqual(classified.topicMatches, baseline.topicMatches);
  assert.deepEqual(classified.selection, baseline.selection);
  assert.equal(classified.systemPrompt, baseline.systemPrompt);
  assert.equal(classified.tokenCount, baseline.tokenCount);
  assert.equal(classified.clusterMetadata?.clusters.length, 1);
  assert.equal(classified.clusterMetadata?.topicClusters.length, 3);
  console.log(`PASS classification: ${winner.label} → Japan Trip, Visa Planning, Flights; equivalent labels reuse one cluster.`);
  console.log("PASS retrieval: domain metadata is present; selected topics, scores, prompt, and token count are unchanged.");

  await assert.rejects(sql`UPDATE mg_topic_nodes SET cluster_id=${winner.id}::uuid WHERE id=${foreign.id}`, { code: "23503" });
  await assert.rejects(sql`INSERT INTO mg_topic_clusters (session_id,label,normalized_label,description,embedding)
    VALUES ('s',${winner.label},${winner.normalizedLabel},'Duplicate domain','[1,0]'::vector)`, { code: "23505" });
  assert.deepEqual(await store.getTopicClusterMetadata([{ id: a.id, sessionId: "other" }]), { clusters: [], topicClusters: [] });
  assert.equal((await store.getTopicClusterMetadata([a, b])).topicClusters.length, 2);
  await store.suppressTopic(a.id);
  assert.equal((await store.getTopicClusterMetadata([a, b])).topicClusters.length, 1);
  await store.restoreTopic(a.id);

  const stale = decision(foreign, (await store.getTopicClusterCatalog("other")).revision, "Travel");
  await sql`UPDATE mg_topic_nodes SET revision=2 WHERE id=${foreign.id}`;
  assert.equal(await store.commitTopicClusterDecision(stale), "stale");
  assert.equal((await store.getTopicClusters("other")).length, 0);

  const copies = await store.absorbNodes([await store.getTopicNode(a.id) as TopicNode], "destination");
  assert.equal(copies[0]!.clusterId, null);
  assert.equal((await store.getTopicNode(copies[0]!.id))?.clusterId, null);

  assert.equal(await store.deleteTopicCluster("other", winner.id), false);
  assert.equal(await store.deleteTopicCluster("s", winner.id), true);
  assert.equal((await store.getTopicNode(a.id))?.clusterId, null);
  assert.equal((await store.getNodesBySession("s")).length, 3);
  assert.deepEqual(await assigner.classify([a]), []);
  await store.clearSession("s");
  assert.deepEqual(await store.getTopicClusters("s"), []);
  console.log("PASS topic clusters: additive migration, concurrency, semantic reuse, aliases, scope constraints, metadata, stale revisions, graft isolation, deletion, and cleanup.");
} finally {
  try {
    await store.close();
  } finally {
    try {
      await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
      console.log("CLEANUP: removed the temporary test schema.");
    } finally {
      await admin.end();
    }
  }
}
