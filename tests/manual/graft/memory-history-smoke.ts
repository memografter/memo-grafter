import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  MemoGrafter,
  type EmbedAdapter,
  type LLMAdapter,
  type MemoryHistoryResult,
  type MemoryNodeInsert,
  type TopicNode,
} from "../../../src/index.js";

const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

const llm: LLMAdapter = {
  complete: async () => "unused",
};

const embedder: EmbedAdapter = {
  embed: async () => vector,
};

function section(title: string): void {
  console.log("\n========================================");
  console.log(title);
  console.log("========================================");
}

function printHistory(history: MemoryHistoryResult): void {
  console.log(`History entries: ${history.entries.length}`);
  console.log(`Current memory: ${history.currentMemory?.id ?? "(none)"}`);
  for (const entry of history.entries) {
    console.log(`\n[${entry.versionIndex}] ${entry.status}`);
    console.log(`  memory: ${entry.memory.id}`);
    console.log(`  fact: ${entry.memory.subject} ${entry.memory.predicate}: ${entry.memory.value}`);
    console.log(`  createdAt: ${entry.createdAt.toISOString()}`);
    console.log(`  supersededBy: ${entry.supersededBy ?? "(none)"}`);
    console.log(`  supersedes: ${entry.supersedes.length ? entry.supersedes.join(", ") : "(none)"}`);
    console.log(`  conflictsWith: ${entry.conflictsWith.length ? entry.conflictsWith.join(", ") : "(none)"}`);
    console.log(`  updateEdges: ${entry.updateEdges.length}`);
    console.log(`  conflictEdges: ${entry.conflictEdges.length}`);
  }
}

function makeTopic(sessionId: string, label: string, order: number): TopicNode {
  const segmentId = randomUUID();
  return {
    id: randomUUID(),
    sessionId,
    segmentId,
    label,
    summary: `${label} summary.`,
    embedding: vector,
    messageRange: [order - 1, order - 1],
    topicOrder: order,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date(`2026-01-0${order}T00:00:00.000Z`),
  };
}

function makeMemory(overrides: Partial<MemoryNodeInsert> & Pick<MemoryNodeInsert, "id" | "segmentId" | "topicNodeId" | "sessionId" | "value">): MemoryNodeInsert {
  return {
    agentId: null,
    memoryType: "fact",
    sourceType: "conversation",
    subject: "user",
    predicate: "location",
    quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
    embedding: vector,
    tags: ["manual:history"],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    forgotten: false,
    forgottenAt: null,
    hasConflict: false,
    agentColor: null,
    fleetId: null,
    ...overrides,
  };
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for memory-history-smoke.");
}

const memo = new MemoGrafter({
  db: { connectionString: process.env.DATABASE_URL },
  llm,
  embedder,
});

await memo.initialize();

try {
  const sessionId = randomUUID();
  const oldTopic = makeTopic(sessionId, "Initial location", 1);
  const newTopic = makeTopic(sessionId, "Updated location", 2);
  const conflictTopic = makeTopic(sessionId, "Conflicting location", 3);

  section("1. Seed deterministic memory versions");
  for (const topic of [oldTopic, newTopic, conflictTopic]) {
    await memo.store.saveSegment({
      id: topic.segmentId,
      sessionId,
      startIndex: topic.messageRange[0],
      endIndex: topic.messageRange[1],
      topicOrder: topic.topicOrder,
      driftScore: topic.driftScore,
      createdAt: topic.createdAt,
    });
    await memo.store.saveNode(topic);
    console.log(`Created topic ${topic.id}: ${topic.label}`);
  }

  const oldMemoryId = randomUUID();
  const newMemoryId = randomUUID();
  const conflictMemoryId = randomUUID();
  await memo.store.insertMemories([
    makeMemory({
      id: oldMemoryId,
      segmentId: oldTopic.segmentId,
      topicNodeId: oldTopic.id,
      sessionId,
      value: "Delhi",
    }),
    makeMemory({
      id: newMemoryId,
      segmentId: newTopic.segmentId,
      topicNodeId: newTopic.id,
      sessionId,
      value: "Actually Bangalore now",
    }),
    makeMemory({
      id: conflictMemoryId,
      segmentId: conflictTopic.segmentId,
      topicNodeId: conflictTopic.id,
      sessionId,
      value: "Pune",
    }),
  ]);
  console.log(`Old memory: ${oldMemoryId} -> Delhi`);
  console.log(`New memory: ${newMemoryId} -> Actually Bangalore now`);
  console.log(`Conflicting memory: ${conflictMemoryId} -> Pune`);

  section("2. Add versioning and conflict metadata");
  await memo.store.markMemoryNodeSuperseded(oldMemoryId, newMemoryId);
  await memo.store.upsertMemoryEdge({
    sourceId: newMemoryId,
    targetId: oldMemoryId,
    edgeType: "updates",
  });
  await memo.store.markMemoryNodesConflicting([newMemoryId, conflictMemoryId]);
  await memo.store.upsertMemoryEdge({
    sourceId: newMemoryId,
    targetId: conflictMemoryId,
    edgeType: "conflicts",
  });
  console.log(`Marked ${oldMemoryId} as superseded by ${newMemoryId}.`);
  console.log(`Created updates edge: ${newMemoryId} -> ${oldMemoryId}.`);
  console.log(`Created conflicts edge between ${newMemoryId} and ${conflictMemoryId}.`);

  section("3. History by memory ID");
  const historyById = await memo.getMemoryHistory(newMemoryId, { sessionId });
  printHistory(historyById);
  assert.equal(historyById.entries.length, 3);
  assert.ok(historyById.currentMemory);
  assert.notEqual(historyById.currentMemory?.id, oldMemoryId);
  assert.ok(historyById.entries.some((entry) => entry.memory.id === oldMemoryId && entry.status === "superseded"));
  assert.ok(historyById.entries.some((entry) => entry.memory.id === newMemoryId && entry.conflictsWith.includes(conflictMemoryId)));

  section("4. History by subject/predicate");
  const historyByFact = await memo.getMemoryHistory(" user ", " location ", { sessionId });
  printHistory(historyByFact);
  assert.equal(historyByFact.entries.length, 3);

  section("5. Diff old -> new");
  const diff = await memo.getMemoryDiff(oldMemoryId, newMemoryId);
  console.log(`Changed fields: ${diff.changedFields.map((field) => field.field).join(", ")}`);
  console.log(`from value: ${diff.from.value}`);
  console.log(`to value: ${diff.to.value}`);
  console.log(`from superseded by to: ${diff.relationship.supersededBy}`);
  console.log(`updates edges between versions: ${diff.relationship.updateEdges.length}`);
  console.log(`conflict edges between versions: ${diff.relationship.conflictEdges.length}`);
  assert.ok(diff.changedFields.some((field) => field.field === "value"));
  assert.equal(diff.relationship.supersededBy, true);

  section("Result");
  console.log("Memory history smoke test passed.");
} finally {
  await memo.close();
}
