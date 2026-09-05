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

const testName = "crawler-conflict-vs-version-smoke";

if (await skipWithoutDatabase(testName)) {
  process.exit(0);
}

const distinctionLLMAdapter: LLMAdapter = {
  async complete(messages: Message[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    if (!last.includes("Conversation segment:")) {
      return `Response to: ${last}`;
    }

    const normalized = last.toLowerCase();
    const value = normalized.includes("mumbai")
      ? "Actually Mumbai now"
      : normalized.includes("pune")
        ? "Pune"
        : normalized.includes("bangalore")
          ? "Bangalore"
          : "Delhi";

    return JSON.stringify({
      label: "User Location",
      user_intent: "The user discussed their location.",
      outcome: `The user stated their location as ${value}.`,
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

const distinctionEmbedAdapter: EmbedAdapter = {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    vector[text.toLowerCase().includes("location") ? 0 : 1] = 1;
    return vector;
  },
};

const config: Partial<MemoGrafterConfig> = {
  llm: distinctionLLMAdapter,
  embedder: distinctionEmbedAdapter,
  drift: {
    mode: "intent",
    minSegmentMessages: 1,
    driftSensitivity: "low",
  },
};

const memo = await createInitializedMemo(config);
const conflictSessionId = `crawler-conflict-only-${Date.now()}`;
const versionSessionId = `crawler-version-only-${Date.now()}`;

try {
  await memo.ingestNow([
    { role: "user", content: "I live in Delhi." },
    { role: "assistant", content: "I will remember Delhi." },
  ], conflictSessionId);
  await memo.ingestNow([
    { role: "user", content: "I live in Delhi." },
    { role: "assistant", content: "I will remember Delhi." },
    { role: "user", content: "I also claim that I live in Bangalore." },
    { role: "assistant", content: "Those locations disagree." },
  ], conflictSessionId);

  await memo.ingestNow([
    { role: "user", content: "I live in Pune." },
    { role: "assistant", content: "I will remember Pune." },
  ], versionSessionId);
  await memo.ingestNow([
    { role: "user", content: "I live in Pune." },
    { role: "assistant", content: "I will remember Pune." },
    { role: "user", content: "Correction: I actually live in Mumbai now." },
    { role: "assistant", content: "I will use Mumbai as your current location." },
  ], versionSessionId);

  const crawler = new MemoGrafterCrawler({
    store: memo.store,
    passes: [new ConflictDetectionPass(), new VersioningPass()],
  });
  const report = await crawler.runOnce();

  const conflictMemories = await memo.store.getMemoriesBySession(conflictSessionId);
  const conflictEdges = await memo.store.getMemoryEdgesBySession(conflictSessionId);
  const delhi = conflictMemories.find((memory) => memory.value === "Delhi");
  const bangalore = conflictMemories.find((memory) => memory.value === "Bangalore");
  assert.ok(delhi);
  assert.ok(bangalore);
  assert.equal(delhi.hasConflict, true);
  assert.equal(bangalore.hasConflict, true);
  assert.equal(delhi.supersededBy, null);
  assert.equal(bangalore.supersededBy, null);
  assert.equal(conflictEdges.filter((edge) => edge.edgeType === "conflicts").length, 1);
  assert.equal(conflictEdges.filter((edge) => edge.edgeType === "updates").length, 0);

  const versionMemories = await memo.store.getMemoriesBySession(versionSessionId);
  const versionEdges = await memo.store.getMemoryEdgesBySession(versionSessionId);
  const pune = versionMemories.find((memory) => memory.value === "Pune");
  const mumbai = versionMemories.find((memory) => memory.value === "Actually Mumbai now");
  assert.ok(pune);
  assert.ok(mumbai);
  assert.equal(pune.hasConflict, false);
  assert.equal(mumbai.hasConflict, false);
  assert.equal(pune.supersededBy, mumbai.id);
  assert.equal(mumbai.supersededBy, null);
  assert.equal(versionEdges.filter((edge) => edge.edgeType === "conflicts").length, 0);
  assert.equal(versionEdges.filter((edge) => edge.edgeType === "updates").length, 1);

  console.log("crawler conflict vs version smoke passed");
  console.log("plain disagreement:", {
    conflictEdges: conflictEdges.filter((edge) => edge.edgeType === "conflicts").length,
    updateEdges: conflictEdges.filter((edge) => edge.edgeType === "updates").length,
    superseded: conflictMemories.filter((memory) => memory.supersededBy != null).length,
  });
  console.log("explicit correction:", {
    conflictEdges: versionEdges.filter((edge) => edge.edgeType === "conflicts").length,
    updateEdges: versionEdges.filter((edge) => edge.edgeType === "updates").length,
    superseded: versionMemories.filter((memory) => memory.supersededBy != null).length,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await memo.close();
  await cleanupDatabase();
}
