import assert from "node:assert/strict";
import {
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

function makeMemoryNode(
  overrides: Partial<ScoredMemoryNode> &
    Pick<MemoryNode, "id" | "topicNodeId" | "subject" | "value" | "quality">,
): ScoredMemoryNode {
  return {
    id: overrides.id,
    segmentId: `${overrides.topicNodeId}-segment`,
    topicNodeId: overrides.topicNodeId,
    agentId: null,
    sessionId: "confidence-ranking-session",
    memoryType: "fact",
    sourceType: "conversation",
    subject: overrides.subject,
    predicate: "uses",
    value: overrides.value,
    quality: overrides.quality,
    embedding: [0.1, 0.2, 0.3],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    agentColor: null,
    fleetId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    similarity: overrides.similarity ?? 0.9,
    ...overrides,
  };
}

function makeTopicNode(id: string, label: string, topicOrder: number): TopicNode {
  return {
    id,
    sessionId: "confidence-ranking-session",
    segmentId: `${id}-segment`,
    label,
    summary: `${label} summary.`,
    embedding: [0.1, 0.2, 0.3],
    messageRange: [0, 1],
    topicOrder,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const highSimilarityLowConfidence = makeMemoryNode({
  id: "high-similarity-low-confidence",
  topicNodeId: "topic-similarity",
  subject: "deployment fact",
  value: "matches the query very closely but has low extraction confidence",
  quality: { explicitness: 0.1, sourceReliability: 0.1, stability: 0.1, salience: 0.1 },
  similarity: 0.95,
});
const lowerSimilarityHighConfidence = makeMemoryNode({
  id: "lower-similarity-high-confidence",
  topicNodeId: "topic-confidence",
  subject: "deployment fact",
  value: "is slightly less similar but much more reliable",
  quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
  similarity: 0.88,
});
const topics = new Map([
  ["topic-similarity", makeTopicNode("topic-similarity", "High Similarity", 1)],
  ["topic-confidence", makeTopicNode("topic-confidence", "High Confidence", 2)],
]);

let searchMemoriesCallCount = 0;
const store = {
  searchMemories: async () => {
    searchMemoriesCallCount += 1;
    return [highSimilarityLowConfidence, lowerSimilarityHighConfidence];
  },
  getTopicNode: async (topicNodeId: string) => topics.get(topicNodeId) ?? null,
} as unknown as GraphStore;

const defaultRetriever = new RetrieverPipeline(store, new StableEmbedAdapter(), {
  limit: 2,
  minSimilarity: 0.5,
  tokenBudget: 1000,
});
const defaultResult = await defaultRetriever.run(
  "deployment config reliability",
  "confidence-ranking-session",
);

assert.equal(defaultResult.facts[0]?.id, "high-similarity-low-confidence");
assert.equal(defaultResult.nodes[0]?.id, highSimilarityLowConfidence.topicNodeId);
assert.equal(
  Object.hasOwn(defaultResult.facts[0] ?? {}, "retrievalScore"),
  false,
);

const similarityOnlyRetriever = new RetrieverPipeline(store, new StableEmbedAdapter(), {
  limit: 2,
  minSimilarity: 0.5,
  tokenBudget: 1000,
});
const similarityOnlyResult = await similarityOnlyRetriever.run(
  "deployment config reliability",
  "confidence-ranking-session",
);

assert.equal(similarityOnlyResult.facts[0]?.id, "high-similarity-low-confidence");
assert.equal(similarityOnlyResult.nodes[0]?.id, "topic-similarity");
assert.equal(searchMemoriesCallCount, 2);

console.log("relevance-first retrieval smoke passed");
console.log("default ranking:", defaultResult.facts.map((fact) => ({
  id: fact.id,
  similarity: fact.similarity,
  quality: fact.quality,
})));
console.log("similarity-only ranking:", similarityOnlyResult.facts.map((fact) => ({
  id: fact.id,
  similarity: fact.similarity,
  quality: fact.quality,
})));
