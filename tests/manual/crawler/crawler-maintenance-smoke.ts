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

const testName = "crawler-maintenance-smoke";

if (await skipWithoutDatabase(testName)) {
  process.exit(0);
}

const crawlerSmokeLLMAdapter: LLMAdapter = {
  async complete(messages: Message[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    if (!last.includes("Conversation segment:")) {
      return `Response to: ${last}`;
    }

    const normalized = last.toLowerCase();
    const value = normalized.includes("bangalore") ? "Actually Bangalore now" : "Delhi";

    return JSON.stringify({
      label: "User Location",
      user_intent: "The user discussed where they live.",
      outcome: `The user said they live in ${value}.`,
      open: null,
      memories: [{
        memory_type: "fact",
        subject: "user",
        predicate: "location",
        value,
        quality: { explicitness: 0.98, sourceReliability: 0.98, stability: 0.98, salience: 0.98 },
      }],
    });
  },
};

const crawlerSmokeEmbedAdapter: EmbedAdapter = {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    const normalized = text.toLowerCase();
    vector[normalized.includes("bangalore") ? 1 : 0] = 1;
    return vector;
  },
};

const config: Partial<MemoGrafterConfig> = {
  llm: crawlerSmokeLLMAdapter,
  embedder: crawlerSmokeEmbedAdapter,
  drift: {
    mode: "intent",
    minSegmentMessages: 1,
    driftSensitivity: "low",
  },
  inject: {
    bufferSize: 0,
    tokenBudget: 2000,
  },
};

const memo = await createInitializedMemo(config);
const sessionId = `crawler-smoke-${Date.now()}`;

try {
  await memo.ingestNow([
    { role: "user", content: "I live in Delhi." },
    { role: "assistant", content: "I will remember that you live in Delhi." },
  ], sessionId);
  await memo.ingestNow([
    { role: "user", content: "I live in Delhi." },
    { role: "assistant", content: "I will remember that you live in Delhi." },
    { role: "user", content: "Correction: I live in Bangalore now." },
    { role: "assistant", content: "Got it, Bangalore is your current location." },
  ], sessionId);

  const memoriesBefore = await memo.store.getMemoriesBySession(sessionId);
  assert.ok(memoriesBefore.some((memory) => memory.value === "Delhi"));
  assert.ok(memoriesBefore.some((memory) => memory.value === "Actually Bangalore now"));

  const crawler = new MemoGrafterCrawler({
    store: memo.store,
    passes: [new ConflictDetectionPass(), new VersioningPass()],
  });
  const firstReport = await crawler.runOnce();
  const secondReport = await crawler.runOnce();

  const memoriesAfter = await memo.store.getMemoriesBySession(sessionId);
  const delhiMemory = memoriesAfter.find((memory) => memory.value === "Delhi");
  const bangaloreMemory = memoriesAfter.find((memory) => memory.value === "Actually Bangalore now");
  assert.ok(delhiMemory);
  assert.ok(bangaloreMemory);
  assert.equal(delhiMemory.supersededBy, bangaloreMemory.id);
  assert.equal(bangaloreMemory.supersededBy, null);
  assert.equal(delhiMemory.hasConflict, false);
  assert.equal(bangaloreMemory.hasConflict, false);

  const memoryEdges = await memo.store.getMemoryEdgesBySession(sessionId);
  assert.equal(memoryEdges.some((edge) => edge.edgeType === "conflicts"), false);
  assert.ok(memoryEdges.some((edge) =>
    edge.edgeType === "updates"
    && edge.sourceId === bangaloreMemory.id
    && edge.targetId === delhiMemory.id
  ));

  const graft = await memo.inject(sessionId, [delhiMemory.topicNodeId]);
  assert.match(graft.systemPrompt, /Summary: .*Delhi/s);
  assert.match(graft.systemPrompt, /Memory maintenance notes:/);
  assert.match(graft.systemPrompt, /superseded by "Actually Bangalore now"/);
  assert.match(graft.systemPrompt, /Prefer active memory facts over contradictory historical summary details/);
  assert.match(graft.systemPrompt, /Active memory facts:/);
  assert.match(graft.systemPrompt, /user location: Actually Bangalore now/);

  assert.equal(secondReport.passes[0]?.result?.conflictEdgesCreated, 0);
  assert.equal(secondReport.passes[1]?.result?.updateEdgesCreated, 0);

  console.log("crawler maintenance smoke passed");
  console.log(JSON.stringify(firstReport, null, 2));
  console.log("memory edges:", memoryEdges.map((edge) => ({
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    edgeType: edge.edgeType,
  })));
  console.log("graft prompt:");
  console.log(graft.systemPrompt);
} finally {
  await memo.close();
  await cleanupDatabase();
}
