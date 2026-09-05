import "dotenv/config";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  cleanupDatabase,
  createInitializedMemo,
  databaseUrl,
  skipWithoutDatabase,
} from "../../setup.js";
import {
  DecayScoringPass,
  MemoGrafterCrawler,
  type EmbedAdapter,
  type LLMAdapter,
  type MemoGrafterConfig,
  type Message,
} from "../../../src/index.js";

const testName = "crawler-decay-smoke";

if (await skipWithoutDatabase(testName)) {
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for crawler-decay-smoke.");
}

const decaySmokeLLMAdapter: LLMAdapter = {
  async complete(messages: Message[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    if (!last.includes("Conversation segment:")) {
      return `Response to: ${last}`;
    }

    return JSON.stringify({
      label: "Old Preference",
      user_intent: "The user discussed a long-lived preference.",
      outcome: "The user said they prefer a quiet workspace.",
      open: null,
      memories: [{
        memory_type: "fact",
        subject: "user",
        predicate: "prefers",
        value: "quiet workspace",
        quality: { explicitness: 0.4, sourceReliability: 0.4, stability: 0.4, salience: 0.4 },
      }],
    });
  },
};

const decaySmokeEmbedAdapter: EmbedAdapter = {
  async embed(): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    vector[0] = 1;
    return vector;
  },
};

const config: Partial<MemoGrafterConfig> = {
  llm: decaySmokeLLMAdapter,
  embedder: decaySmokeEmbedAdapter,
  drift: {
    mode: "intent",
    minSegmentMessages: 1,
    driftSensitivity: "low",
  },
};

const memo = await createInitializedMemo(config);
const sessionId = `crawler-decay-smoke-${Date.now()}`;
const sql = postgres(databaseUrl);

try {
  await memo.ingestNow([
    { role: "user", content: "I prefer a quiet workspace." },
    { role: "assistant", content: "I will remember that preference." },
  ], sessionId);

  const memoriesBefore = await memo.store.getMemoriesBySession(sessionId);
  assert.equal(memoriesBefore.length, 1);

  const staleMemory = memoriesBefore[0]!;
  await sql`
    UPDATE mg_memory_nodes
    SET created_at = ${new Date("2025-01-01T00:00:00.000Z")},
        quality_explicitness = 0.4, quality_source_reliability = 0.4, quality_stability = 0.4, quality_salience = 0.4, quality_updated_at = NOW() - INTERVAL '1 year'
    WHERE id = ${staleMemory.id}::uuid
  `;

  const crawler = new MemoGrafterCrawler({
    store: memo.store,
    passes: [
      new DecayScoringPass({ mode: "enforce",
        halfLifeDays: 30,
        minScore: 0.25,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      }),
    ],
  });

  const firstReport = await crawler.runOnce();
  const secondReport = await crawler.runOnce();
  const memoriesAfter = await memo.store.getMemoriesBySession(sessionId);

  assert.equal(memoriesAfter.length, 1);
  assert.equal(memoriesAfter[0]?.decayed, true);
  assert.equal(firstReport.passes[0]?.result?.decayScored, 1);
  assert.equal(firstReport.passes[0]?.result?.nodesDecayed, 1);
  assert.equal(secondReport.passes[0]?.result?.decayScored, 0);
  assert.equal(secondReport.passes[0]?.result?.nodesDecayed, 0);
  assert.equal(secondReport.passes[0]?.result?.skippedAlreadyDecayed, 1);

  console.log("crawler decay smoke passed");
  console.log(JSON.stringify(firstReport, null, 2));
} finally {
  await sql.end().catch(() => undefined);
  await memo.close();
  await cleanupDatabase();
}
