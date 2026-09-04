import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresGraphStore } from "../../src/store/postgres-pgvector/GraphStore.js";
import type { MemoryNodeInsert, TopicNode, TopicSegment } from "../../src/core/types.js";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required. Run with: npx tsx --env-file=.env tests/manual/memory-canonicalization.ts");
const store = new PostgresGraphStore(connectionString);
const sessionId = `manual-canonicalization-${randomUUID()}`;
const embedding = new Array<number>(1536).fill(0); embedding[0] = 1;

async function add(value: string, order: number): Promise<void> {
  const segment: TopicSegment = { id: randomUUID(), sessionId, startIndex: order, endIndex: order, topicOrder: order, driftScore: 0, createdAt: new Date() };
  const topic: TopicNode = { id: randomUUID(), sessionId, segmentId: segment.id, label: "Database preference", summary: value, embedding, messageRange: [order, order], topicOrder: order, driftScore: 0, agentColor: null, fleetId: null, agentId: null, createdAt: new Date() };
  await store.saveSegmentWithNode?.(segment, topic);
  const memory: MemoryNodeInsert = { id: randomUUID(), segmentId: segment.id, topicNodeId: topic.id, sessionId, agentId: null, memoryType: "fact", sourceType: "conversation", subject: order === 1 ? "The user" : "user", predicate: order === 1 ? "preference is" : "prefers", value, confidence: 0.95, embedding, sourceUrl: null, sourceTitle: null, provenance: { speaker: "user", messageIndexes: [order], sessionId, extractionMethod: "explicit" }, supersededBy: null, decayed: false, agentColor: null, fleetId: null };
  await store.insertMemories([memory]);
}

await store.migrate();
try {
  await add("Postgres.", 1);
  await add("PostgreSQL", 2);
  let memories = await store.getMemoriesBySession(sessionId);
  assert.equal(memories.length, 1, "equivalent wording should reinforce rather than insert");
  assert.equal(memories[0]?.reinforcementCount, 2);

  await add("MySQL", 3);
  memories = await store.getMemoriesBySession(sessionId);
  assert.equal(memories.length, 2);
  assert.ok(memories.every((memory) => memory.hasConflict), "unqualified competing values should conflict");

  await add("Actually, now SQLite", 4);
  memories = await store.getMemoriesBySession(sessionId);
  const active = memories.filter((memory) => memory.supersededBy == null);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.canonicalValue, "sqlite");
  const history = await store.getMemoryHistoryByFact("user", "prefers", { sessionId });
  assert.equal(history.entries.length, 3);
  assert.ok(history.entries.filter((entry) => entry.status === "superseded").length >= 2);
  console.log("Manual canonicalization test passed:", history.entries.map((entry) => ({ value: entry.memory.value, status: entry.status, reinforcements: entry.memory.reinforcementCount })));
} finally {
  await store.clearSession(sessionId).catch(() => undefined);
  await store.close();
}
