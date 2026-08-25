import assert from "node:assert/strict";
import {
  RetrieverPipeline,
  type EmbedAdapter,
  type GraphStore,
  type MemoryNode,
  type TopicNode,
} from "../../../src/index.js";

type Candidate = MemoryNode & { similarity: number };

const SESSION_ID = "retrieval-impact-session";
const RELEVANT_ID = "relevant-below-legacy-cutoff";
const LEGACY_LIMIT = 10;
const LEGACY_MIN_SIMILARITY = 0.6;

class StableEmbedAdapter implements EmbedAdapter {
  dimensions = 3;

  async embed(): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
}

function candidate(index: number, similarity: number): Candidate {
  const relevant = index === 15;
  const id = relevant ? RELEVANT_ID : `distractor-${String(index).padStart(2, "0")}`;
  return {
    id,
    segmentId: `segment-${index}`,
    topicNodeId: `topic-${index}`,
    agentId: null,
    sessionId: SESSION_ID,
    memoryType: "fact",
    sourceType: "conversation",
    subject: relevant ? "production deployment region" : `unrelated preference ${index}`,
    predicate: relevant ? "uses" : "mentions",
    value: relevant ? "eu-west-1" : `distractor value ${index}`,
    confidence: relevant ? 1 : 0.05,
    embedding: [0.1, 0.2, 0.3],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    agentColor: null,
    fleetId: null,
    createdAt: new Date(`2026-01-${String(Math.min(index, 28)).padStart(2, "0")}T00:00:00.000Z`),
    similarity,
  };
}

function topic(index: number): TopicNode {
  return {
    id: `topic-${index}`,
    sessionId: SESSION_ID,
    segmentId: `segment-${index}`,
    label: index === 15 ? "Deployment configuration" : `Distractor topic ${index}`,
    summary: index === 15 ? "The production deployment region." : `Unrelated topic ${index}.`,
    embedding: [0.1, 0.2, 0.3],
    messageRange: [index, index],
    topicOrder: index,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const candidates = Array.from({ length: 40 }, (_, offset) => {
  const index = offset + 1;
  const similarity = index === 15 ? 0.58 : Number((0.73 - index * 0.01).toFixed(2));
  return candidate(index, similarity);
}).sort((a, b) => b.similarity - a.similarity);
const topics = new Map(Array.from({ length: 40 }, (_, offset) => {
  const node = topic(offset + 1);
  return [node.id, node] as const;
}));

const legacyCandidates = candidates
  .filter((fact) => fact.similarity >= LEGACY_MIN_SIMILARITY)
  .slice(0, LEGACY_LIMIT);
const legacySelected = legacyCandidates
  .map((fact) => ({ fact, score: fact.similarity * 0.7 + fact.confidence * 0.3 }))
  .sort((a, b) => b.score - a.score)
  .slice(0, LEGACY_LIMIT)
  .map(({ fact }) => fact);

let requestedCandidateLimit: number | undefined;
const store = {
  searchMemoryCandidates: async (_embedding: number[], _sessionId: string, limit: number) => {
    requestedCandidateLimit = limit;
    return candidates.slice(0, limit);
  },
  searchMemories: async () => {
    throw new Error("The adaptive path should use unthresholded candidate generation.");
  },
  getTopicNode: async (topicNodeId: string) => topics.get(topicNodeId) ?? null,
} as unknown as GraphStore;

const adaptive = await new RetrieverPipeline(store, new StableEmbedAdapter(), {
  candidateLimit: 40,
  limit: 10,
  tokenBudget: 1200,
}).run("Which region hosts the production deployment?", SESSION_ID);

const legacyHit = legacySelected.some((fact) => fact.id === RELEVANT_ID);
const adaptiveHit = adaptive.facts.some((fact) => fact.id === RELEVANT_ID);
const legacyPrecision = legacySelected.length === 0 ? 0 : Number(legacyHit) / legacySelected.length;
const adaptivePrecision = adaptive.facts.length === 0 ? 0 : Number(adaptiveHit) / adaptive.facts.length;

assert.equal(requestedCandidateLimit, 40, "adaptive retrieval should request the top 40 candidates");
assert.equal(legacyHit, false, "legacy threshold/top-10 retrieval should miss the relevant fact");
assert.equal(adaptiveHit, true, "adaptive retrieval should recover the relevant fact");
assert.equal(adaptive.facts[0]?.id, RELEVANT_ID, "confidence-aware ranking should place the relevant fact first");
assert.ok(adaptivePrecision > legacyPrecision, "adaptive selection should improve precision in this regression case");
assert.equal(adaptive.selection?.reason, "relative-score");

console.log("retrieval candidate/adaptive-selection impact test passed");
console.table([
  {
    strategy: "legacy cutoff + top-10",
    candidates: legacyCandidates.length,
    selected: legacySelected.length,
    relevantHit: legacyHit,
    precision: legacyPrecision.toFixed(2),
  },
  {
    strategy: "top-40 + adaptive",
    candidates: adaptive.selection?.candidateCount ?? 0,
    selected: adaptive.facts.length,
    relevantHit: adaptiveHit,
    precision: adaptivePrecision.toFixed(2),
  },
]);
console.log("adaptive selection diagnostics:", adaptive.selection);
