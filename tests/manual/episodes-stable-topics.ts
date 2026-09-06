/**
 * Deterministic manual integration test for episodes and stable topic re-entry.
 *
 * Run: npm run manual:episodes
 * Requires DATABASE_URL. It uses no external LLM or embedding provider.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  MemoGrafter,
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
} from "../../src/index.js";

class EpisodeTestLLM implements LLMAdapter {
  async complete(messages: Message[]): Promise<string> {
    const prompt = messages.at(-1)?.content ?? "";
    assert.ok(prompt.includes("Conversation segment:"), "Only extraction calls are expected.");
    const text = prompt.toLowerCase();

    if (text.includes("rooftop garden")) {
      return JSON.stringify({
        label: "Office Rooftop Garden",
        user_intent: "The user wanted ideas for arranging an office rooftop garden.",
        outcome: "The assistant proposed a simple garden layout.",
        open: "The final garden layout has not been selected.",
        memories: [],
      });
    }

    if (text.includes("seven years")) {
      return JSON.stringify({
        label: "Project Atlas Billing",
        user_intent: "The user returned to Project Atlas billing to record its audit retention requirement.",
        outcome: "The seven-year audit-event retention requirement was acknowledged.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "Project Atlas billing",
          predicate: "retains audit events for",
          value: "seven years.",
          quality: { explicitness: 0.98, sourceReliability: 0.9, stability: 0.95, salience: 0.95 },
          provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
        }],
      });
    }

    assert.ok(text.includes("project atlas") && text.includes("postgresql"), "Unexpected extraction fixture.");
    return JSON.stringify({
      label: "Project Atlas Billing",
      user_intent: "The user established the source-of-truth database for Project Atlas billing.",
      outcome: "PostgreSQL was recorded as the billing system's source of truth.",
      open: null,
      memories: [{
        memory_type: "fact",
        subject: "Project Atlas billing",
        predicate: "uses as source of truth",
        value: "PostgreSQL.",
        quality: { explicitness: 0.98, sourceReliability: 0.9, stability: 0.95, salience: 0.95 },
        provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
      }],
    });
  }
}

class EpisodeTestEmbedder implements EmbedAdapter {
  dimensions = 1536;

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    const normalized = text.toLowerCase();
    if (normalized.includes("atlas") || normalized.includes("billing") || normalized.includes("postgresql") || normalized.includes("audit")) {
      vector[0] = 1;
    } else if (normalized.includes("garden") || normalized.includes("rooftop")) {
      vector[1] = 1;
    } else {
      vector[2] = 1;
    }
    return vector;
  }
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required. Add it to .env before running this test.");

const sessionId = `manual-episodes-${randomUUID()}`;
const memo = new MemoGrafter({
  db: { connectionString: databaseUrl },
  llm: new EpisodeTestLLM(),
  embedder: new EpisodeTestEmbedder(),
  drift: {
    mode: "intent",
    minSegmentMessages: 1,
    driftSensitivity: "high",
    topicAssignment: { reuseThreshold: 0.9, candidateLimit: 5 },
  },
  graph: { topK: 5 },
});

const transcript: Message[] = [];
const exchanges: Message[][] = [
  [
    { role: "user", content: "For Project Atlas billing, PostgreSQL is the source of truth." },
    { role: "assistant", content: "Understood. PostgreSQL is authoritative for Project Atlas billing." },
  ],
  [
    { role: "user", content: "Help me brainstorm a rooftop garden layout for the office." },
    { role: "assistant", content: "We can arrange planters around a shaded central seating area." },
  ],
  [
    { role: "user", content: "Back to Project Atlas billing: audit events must be retained for seven years." },
    { role: "assistant", content: "Understood. Billing audit events have a seven-year retention requirement." },
  ],
];

console.log(`Episode and stable-topic manual test\nSession: ${sessionId}\n`);

try {
  // The feature requires migration 010. This is additive and also backfills legacy topic segments.
  await memo.store.migrate();
  await memo.initialize();

  for (const [index, exchange] of exchanges.entries()) {
    transcript.push(...exchange);
    const assignedTopics = await memo.ingestNow(transcript, sessionId);
    console.log(`Exchange ${index + 1}:`, assignedTopics.map((topic) => ({ id: topic.id, label: topic.label })));
  }

  const [topicsResult, episodes, memories] = await Promise.all([
    memo.getTopics(sessionId),
    memo.store.getEpisodesBySession?.(sessionId) ?? Promise.resolve([]),
    memo.store.getMemoriesBySession(sessionId),
  ]);
  const topics = topicsResult.nodes;

  assert.equal(topicsResult.segments.length, 3, "Expected one immutable segment per exchange.");
  assert.equal(episodes.length, 3, "Expected one episode per exchange, including the memory-free garden exchange.");
  assert.equal(topics.length, 2, "Expected A → B → A to produce two stable topics.");

  const billingEpisodes = episodes.filter((episode) => episode.summary.includes("Project Atlas") || episode.summary.includes("seven-year"));
  const gardenEpisodes = episodes.filter((episode) => episode.summary.toLowerCase().includes("garden"));
  assert.equal(billingEpisodes.length, 2, "Expected both billing interactions to remain as separate episodes.");
  assert.equal(gardenEpisodes.length, 1, "Expected the garden interaction to remain as an episode.");
  assert.equal(new Set(billingEpisodes.map((episode) => episode.topicId)).size, 1, "Billing re-entry should reuse one topic ID.");
  assert.notEqual(billingEpisodes[0]?.topicId, gardenEpisodes[0]?.topicId, "Unrelated episodes must not share a topic.");

  const billingTopicId = billingEpisodes[0]!.topicId;
  const billingTopic = topics.find((topic) => topic.id === billingTopicId);
  assert.ok(billingTopic, "The reused billing topic should exist.");
  assert.equal(billingTopic.episodeCount, 2, "The billing topic should aggregate two episodes.");
  assert.equal(billingTopic.embeddingCount, 2, "The billing centroid should represent two episode embeddings.");
  assert.equal(billingTopic.lastEpisodeId, billingEpisodes.at(-1)?.id, "Topic activity should point to the re-entry episode.");

  assert.equal(memories.length, 2, "Only the two durable billing facts should become memories.");
  assert.ok(memories.every((memory) => memory.topicNodeId === billingTopicId), "Durable billing memories should attach to the reused topic.");
  assert.equal(memories.filter((memory) => memory.segmentId === gardenEpisodes[0]!.segmentId).length, 0, "The garden episode should not create durable memory.");

  const recall = await memo.context({
    sessionId,
    query: "What happened with Project Atlas billing?",
    limit: 5,
    episodeLimit: 2,
    episodeTokenBudget: 300,
  });
  assert.equal(recall.episodes?.length, 2, "Recall should return both relevant billing episodes.");
  assert.ok(recall.episodes?.every((episode) => episode.topicId === billingTopicId), "Episode recall should exclude the unrelated garden topic.");
  assert.equal(recall.facts.length, 2, "Recall should independently return both durable billing facts.");
  assert.match(recall.systemPrompt, /historical context, not durable facts/i, "The prompt should label episode content as historical context.");

  console.table(episodes.map((episode) => ({
    order: episode.episodeOrder,
    topicId: episode.topicId,
    assignment: episode.assignmentMethod,
    similarity: episode.assignmentSimilarity,
    range: episode.messageRange.join("-"),
    summary: episode.summary,
  })));
  console.table(topics.map((topic) => ({
    id: topic.id,
    label: topic.label,
    episodeCount: topic.episodeCount,
    lastEpisodeId: topic.lastEpisodeId,
  })));
  console.table(memories.map((memory) => ({ topicId: memory.topicNodeId, fact: `${memory.subject} ${memory.predicate} ${memory.value}` })));
  console.log("\nPASS: episodes remained distinct, billing re-entry reused its topic, and durable memories stayed separate.");
} finally {
  await memo.store.clearSession(sessionId).catch(() => undefined);
  await memo.close().catch(() => undefined);
}
