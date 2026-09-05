import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cleanupDatabase,
  createInitializedAgent,
  databaseUrl,
  skipWithoutDatabase,
} from "../../setup.js";
import type {
  MemoryNodeInsert,
  MemoGrafterAgent,
  TopicNode,
  TopicSegment,
} from "../../../src/index.js";
import type { GraphStore } from "../../../src/store/index.js";

const testName = "graph-snapshot-smoke";

if (await skipWithoutDatabase(testName)) {
  process.exit(0);
}

function storeOf(agent: MemoGrafterAgent): GraphStore {
  return (agent as unknown as { core: { store: GraphStore } }).core.store;
}

function makeSegment(sessionId: string, topicOrder: number): TopicSegment {
  return {
    id: randomUUID(),
    sessionId,
    startIndex: topicOrder * 2,
    endIndex: topicOrder * 2 + 1,
    topicOrder,
    driftScore: 0,
    createdAt: new Date(),
  };
}

function makeTopicNode(segment: TopicSegment, overrides: Partial<TopicNode> = {}): TopicNode {
  return {
    id: randomUUID(),
    sessionId: segment.sessionId,
    segmentId: segment.id,
    label: `Snapshot Topic ${segment.topicOrder}`,
    summary: `Snapshot smoke topic ${segment.topicOrder}.`,
    embedding: new Array<number>(1536).fill(0),
    messageRange: [segment.startIndex, segment.endIndex],
    topicOrder: segment.topicOrder,
    driftScore: segment.driftScore,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMemory(
  node: TopicNode,
  overrides: Partial<MemoryNodeInsert> = {},
): MemoryNodeInsert {
  return {
    id: randomUUID(),
    segmentId: node.segmentId,
    topicNodeId: node.id,
    agentId: null,
    sessionId: node.sessionId,
    memoryType: "fact",
    sourceType: "conversation",
    subject: "graph snapshot smoke",
    predicate: "captures",
    value: "all memory rows for a session",
    quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
    embedding: new Array<number>(1536).fill(0),
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    agentColor: null,
    fleetId: null,
    ...overrides,
  };
}

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for graph-snapshot-smoke.");
}

const agent = await createInitializedAgent({
  drift: {
    mode: "intent",
    minSegmentMessages: 2,
    reentryDetection: true,
  },
});
const store = storeOf(agent);
const sessionId = agent.getSessionId();

try {
  const segmentA = await store.saveSegment(makeSegment(sessionId, 1));
  const segmentB = await store.saveSegment(makeSegment(sessionId, 2));
  const nodeA = makeTopicNode(segmentA);
  const nodeB = makeTopicNode(segmentB);
  await store.saveNode(nodeA);
  await store.saveNode(nodeB);
  await store.saveEdge({
    srcId: nodeA.id,
    dstId: nodeB.id,
    weight: 0.91,
    type: "semantic",
  });
  await store.saveEdge({
    srcId: `external-${randomUUID()}`,
    dstId: nodeA.id,
    weight: 0.82,
    type: "reentry",
  });

  const activeMemory = makeMemory(nodeA, {
    subject: "active memory",
    value: "active rows are included",
  });
  const decayedMemory = makeMemory(nodeA, {
    subject: "decayed memory",
    value: "decayed rows are included",
    decayed: true,
  });
  await store.insertMemories([activeMemory, decayedMemory]);
  await store.insertMemories([
    makeMemory(nodeB, {
      subject: "superseded memory",
      value: "superseded rows are included",
      supersededBy: activeMemory.id,
    }),
  ]);

  const snapshot = await agent.getGraphSnapshot();

  console.log("Snapshot session:", snapshot.sessionId);
  console.log("Nodes:", snapshot.nodes.map((node) => node.label));
  console.log("Edges:", snapshot.edges.map((edge) => `${edge.srcId} -> ${edge.dstId} (${edge.type})`));
  console.log("Memories:", snapshot.memories.map((memory) => ({
    subject: memory.subject,
    decayed: memory.decayed,
    supersededBy: memory.supersededBy,
  })));

  assert.equal(snapshot.sessionId, sessionId);
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.edges.length, 2);
  assert.equal(snapshot.memories.length, 3);
  assert.ok(snapshot.edges.some((edge) => edge.srcId === nodeA.id && edge.dstId === nodeB.id));
  assert.ok(snapshot.edges.some((edge) => edge.dstId === nodeA.id && edge.type === "reentry"));
  assert.ok(snapshot.memories.some((memory) => memory.decayed));
  assert.ok(snapshot.memories.some((memory) => memory.supersededBy === activeMemory.id));
  assert.equal(new Date(snapshot.capturedAt).toISOString(), snapshot.capturedAt);

  console.log("graph snapshot smoke passed");
} finally {
  await agent.close();
  await cleanupDatabase();
}
