import "dotenv/config";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  createInitializedMemo,
  skipWithoutDatabase,
} from "../../setup.js";
import {
  ConflictDetectionPass,
  MemoGrafterCrawler,
  VersioningPass,
  type EmbedAdapter,
  type LLMAdapter,
  type MemoGrafterConfig,
  type Message,
} from "../../../src/index.js";

const testName = "crawler-broad-topic-conflict-smoke";

if (await skipWithoutDatabase(testName)) {
  process.exit(0);
}

const broadTopicLLMAdapter: LLMAdapter = {
  async complete(messages: Message[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    if (!last.includes("Conversation segment:")) {
      return `Response to: ${last}`;
    }

    return JSON.stringify({
      label: "Mixed Requests",
      user_intent: "The user discussed cooking and trip planning requests.",
      outcome: "The assistant captured multiple broad topics.",
      open: null,
      memories: [
        {
          memory_type: "fact",
          subject: "user",
          predicate: "asked_about",
          value: "how to cook rajma chawal",
          quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
        },
        {
          memory_type: "fact",
          subject: "user",
          predicate: "asked_about",
          value: "Goa trip plan",
          quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
        },
        {
          memory_type: "fact",
          subject: "user",
          predicate: "asked_about",
          value: "Vietnam trip plan",
          quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
        },
        {
          memory_type: "fact",
          subject: "user",
          predicate: "asked_about",
          value: "food in Vietnam",
          quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
        },
        {
          memory_type: "fact",
          subject: "user",
          predicate: "asked_about",
          value: "places to visit Vietnam",
          quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
        },
      ],
    });
  },
};

const broadTopicEmbedAdapter: EmbedAdapter = {
  async embed(): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    vector[0] = 1;
    return vector;
  },
};

const config: Partial<MemoGrafterConfig> = {
  llm: broadTopicLLMAdapter,
  embedder: broadTopicEmbedAdapter,
  drift: {
    mode: "intent",
    minSegmentMessages: 1,
    driftSensitivity: "low",
  },
};

const memo = await createInitializedMemo(config);
const sessionId = `crawler-broad-topic-smoke-${Date.now()}`;

try {
  await memo.ingestNow([
    { role: "user", content: "How do I cook rajma chawal? Also plan Goa and Vietnam trips." },
    { role: "assistant", content: "I can help with rajma chawal, Goa, and Vietnam planning." },
  ], sessionId);

  const memoriesBefore = await memo.store.getMemoriesBySession(sessionId);
  assert.equal(memoriesBefore.length, 5);
  assert.ok(memoriesBefore.some((memory) => memory.value === "how to cook rajma chawal"));
  assert.ok(memoriesBefore.some((memory) => memory.value === "Goa trip plan"));
  assert.ok(memoriesBefore.some((memory) => memory.value === "Vietnam trip plan"));
  assert.ok(memoriesBefore.some((memory) => memory.value === "food in Vietnam"));
  assert.ok(memoriesBefore.some((memory) => memory.value === "places to visit Vietnam"));

  const crawler = new MemoGrafterCrawler({
    store: memo.store,
    passes: [new ConflictDetectionPass(), new VersioningPass()],
  });
  const report = await crawler.runOnce();

  const memoriesAfter = await memo.store.getMemoriesBySession(sessionId);
  const memoryEdges = await memo.store.getMemoryEdgesBySession(sessionId);
  const rajmaMemory = memoriesAfter.find((memory) => memory.value === "how to cook rajma chawal");
  const goaMemory = memoriesAfter.find((memory) => memory.value === "Goa trip plan");
  const vietnamMemory = memoriesAfter.find((memory) => memory.value === "Vietnam trip plan");
  const vietnamFoodMemory = memoriesAfter.find((memory) => memory.value === "food in Vietnam");
  const vietnamPlacesMemory = memoriesAfter.find((memory) => memory.value === "places to visit Vietnam");
  assert.ok(rajmaMemory);
  assert.ok(goaMemory);
  assert.ok(vietnamMemory);
  assert.ok(vietnamFoodMemory);
  assert.ok(vietnamPlacesMemory);

  assert.equal(report.passes[0]?.result?.conflictsDetected, 1);
  assert.equal(report.passes[0]?.result?.conflictEdgesCreated, 1);
  assert.equal(report.passes[1]?.result?.versionsDetected, 0);
  assert.equal(report.passes[1]?.result?.nodesSuperseded, 0);
  assert.equal(memoryEdges.filter((edge) => edge.edgeType === "conflicts").length, 1);
  assert.ok(memoryEdges.some((edge) =>
    edge.edgeType === "conflicts"
    && [edge.sourceId, edge.targetId].includes(goaMemory.id)
    && [edge.sourceId, edge.targetId].includes(vietnamMemory.id)
  ));
  assert.equal(rajmaMemory.hasConflict, false);
  assert.equal(vietnamFoodMemory.hasConflict, false);
  assert.equal(vietnamPlacesMemory.hasConflict, false);
  assert.equal(rajmaMemory.supersededBy, null);
  assert.equal(goaMemory.supersededBy, null);
  assert.equal(vietnamMemory.supersededBy, null);
  assert.equal(vietnamFoodMemory.supersededBy, null);
  assert.equal(vietnamPlacesMemory.supersededBy, null);

  console.log("crawler broad topic conflict smoke passed");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await memo.close();
  await cleanupDatabase();
}
