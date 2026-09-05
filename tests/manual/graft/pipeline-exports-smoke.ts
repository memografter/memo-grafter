import assert from "node:assert/strict";
import {
  GrafterPipeline,
  IngestPipeline,
  RetrieverPipeline,
  type EmbedAdapter,
  type GraphStore,
  type MemoryNode,
  type TopicNode,
} from "../../../src/index.js";

type ScoredMemoryNode = MemoryNode & { similarity: number };

class StableEmbedAdapter implements EmbedAdapter {
  async embed(): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
}

function makeMemoryNode(): ScoredMemoryNode {
  return {
    id: "pipeline-export-memory",
    segmentId: "pipeline-export-segment",
    topicNodeId: "pipeline-export-topic",
    agentId: null,
    sessionId: "pipeline-export-session",
    memoryType: "fact",
    sourceType: "conversation",
    subject: "pipeline exports",
    predicate: "include",
    value: "RetrieverPipeline",
    quality: { explicitness: 0.98, sourceReliability: 0.98, stability: 0.98, salience: 0.98 },
    embedding: [0.1, 0.2, 0.3],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    agentColor: null,
    fleetId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    similarity: 0.99,
  };
}

function makeTopicNode(): TopicNode {
  return {
    id: "pipeline-export-topic",
    sessionId: "pipeline-export-session",
    segmentId: "pipeline-export-segment",
    label: "Pipeline Exports",
    summary: "Pipeline classes can be imported from the public entrypoint.",
    embedding: [0.1, 0.2, 0.3],
    messageRange: [0, 1],
    topicOrder: 1,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

let searchMemoriesCallCount = 0;
const store = {
  searchMemories: async () => {
    searchMemoriesCallCount += 1;
    return [makeMemoryNode()];
  },
  getTopicNode: async () => makeTopicNode(),
} as unknown as GraphStore;

assert.equal(typeof GrafterPipeline, "function");
assert.equal(typeof IngestPipeline, "function");
assert.equal(typeof RetrieverPipeline, "function");

const retriever = new RetrieverPipeline(store, new StableEmbedAdapter(), {
  limit: 8,
  minSimilarity: 0.55,
  tokenBudget: 1000,
});
const result = await retriever.run(
  "deployment config and Kubernetes namespace",
  "pipeline-export-session",
);

assert.equal(searchMemoriesCallCount, 1);
assert.equal(result.facts.length, 1);
assert.equal(result.nodes.length, 1);
assert.match(result.systemPrompt, /RetrieverPipeline/);

console.log("pipeline exports smoke passed");
console.log("facts:", result.facts);
console.log("system prompt:");
console.log(result.systemPrompt);
