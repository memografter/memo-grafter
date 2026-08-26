import assert from "node:assert/strict";
import { MemoGrafter, OpenAIEmbedAdapter, OpenAILLMAdapter } from "../../src/index.js";

const CHAT_MODEL = "gpt-4o-mini";
const databaseUrl = requireEnv("DATABASE_URL");
requireEnv("OPENAI_API_KEY");
const sessionId = `contextualized-retrieval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const memo = new MemoGrafter({
  db: { connectionString: databaseUrl },
  llm: new OpenAILLMAdapter(CHAT_MODEL),
  embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
  drift: { mode: "intent", minSegmentMessages: 1 },
});

console.log("Conversational retrieval-query contextualization manual test\n");

try {
  await memo.initialize();

  const firstUserMessage = "I want healthy North Indian food with plenty of protein and not too much oil.";
  const firstAssistantMessage = "Dal, chana masala, rajma, tandoori paneer, roti, and vegetable sabzi are suitable options.";
  await memo.analyze({ sessionId, userMessage: firstUserMessage, assistantMessage: firstAssistantMessage });

  const before = await graphCounts(memo, sessionId);
  assert.ok(before.topics > 0, "Setup failed: the completed exchange created no topic nodes.");
  assert.ok(before.memories > 0, "Setup failed: the completed exchange created no atomic memories.");

  const followUp = "What else healthy food can I eat?";
  const result = await memo.context({
    sessionId,
    query: followUp,
    limit: 10,
    tokenBudget: 1200,
    contextualization: {
      recentMessages: [
        { role: "user", content: firstUserMessage },
        { role: "assistant", content: firstAssistantMessage },
      ],
    },
  });
  const after = await graphCounts(memo, sessionId);

  console.log(`Original query:   ${result.query?.original ?? "<missing>"}`);
  console.log(`Retrieval query:  ${result.query?.retrieval ?? "<missing>"}`);
  console.log(`Status:           ${result.query?.status ?? "<missing>"}`);
  console.log(`Retrieved facts:  ${result.facts.length}`);
  console.log(`Retrieved topics: ${result.nodes.length}`);
  console.log(`Graph before:     ${JSON.stringify(before)}`);
  console.log(`Graph after:      ${JSON.stringify(after)}\n`);

  assert.equal(result.query?.original, followUp, "The result did not preserve the original user query.");
  assert.equal(result.query?.status, "applied", "The context-dependent follow-up was not contextualized.");
  assert.equal(result.query?.contextualized, true, "The result was not marked as contextualized.");
  assert.notEqual(result.query?.retrieval, followUp, "Retrieval embedded the isolated follow-up unchanged.");
  assert.match(
    result.query?.retrieval ?? "",
    /north|indian|protein|oil|dal|chana|rajma|paneer|roti|sabzi/i,
    "The standalone retrieval query did not retain any subject detail from recent conversation.",
  );
  assert.ok(result.facts.length > 0, "The contextualized query retrieved no memories from the setup exchange.");
  assert.ok(result.systemPrompt.trim(), "The retrieved facts did not produce prompt-ready context.");
  assert.deepEqual(after, before, "Contextualization or retrieval mutated graph state.");

  console.log("PASS: contextualized retrieval used recent conversation, found memory, and left the graph unchanged.");
} finally {
  await memo.store.clearSession(sessionId).catch(() => undefined);
  await memo.close().catch(() => undefined);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Add it to the root .env file.`);
  return value;
}

async function graphCounts(target: MemoGrafter, targetSessionId: string) {
  const [topics, memories, topicEdges, memoryEdges] = await Promise.all([
    target.store.getNodesBySession(targetSessionId),
    target.store.getMemoriesBySession(targetSessionId),
    target.store.getEdgesBySession(targetSessionId),
    target.store.getMemoryEdgesBySession(targetSessionId),
  ]);
  return { topics: topics.length, memories: memories.length, topicEdges: topicEdges.length, memoryEdges: memoryEdges.length };
}
