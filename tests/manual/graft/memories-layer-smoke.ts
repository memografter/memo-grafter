/*
This test verifies the memories layer end to end.
It runs a real session with two distinct topics, inspects what memory nodes
were extracted per segment, then compares two retrieval approaches side by side:

  A) graft() — topic summary injection (current approach, unchanged)
     Injects full narrative summaries of all topic nodes.
     Good for cold-start context. Coarser and more token-heavy.

  B) searchMemories() — targeted memory retrieval (new layer)
     Embeds a specific query, searches memory node embeddings directly.
     Returns only the most relevant granular memories.
     More precise and token-efficient for targeted questions.

The goal is to make the difference visible in the logs so you can see
what each approach returns for the same query.
*/

import {
  MemoGrafterAgent,
  OpenAIEmbedAdapter,
  OpenAILLMAdapter,
} from "../../../src/index.js";

const agent = new MemoGrafterAgent({
  db: { connectionString: process.env.DATABASE_URL! },
  llm: new OpenAILLMAdapter("gpt-4o-mini"),
  embedder: new OpenAIEmbedAdapter(),
  systemPrompt: "You are a helpful assistant.",
});

const assert = (label: string, condition: boolean) => {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}`);
};

await agent.initialize();

try {
  const prompts = [
    "I strongly prefer TypeScript over JavaScript for any backend work",
    "We decided to use PostgreSQL as our main database. We evaluated MongoDB but ruled it out due to lack of ACID transactions",
    "The infrastructure budget is fixed at $500 per month, we cannot exceed this",
    "We need to launch the MVP by end of August",
    "The authentication system is the highest priority feature right now",
    "We are still undecided on whether to build the notification system in-house or use a third party",
  ];

  for (const prompt of prompts) {
    console.log(`\nUSER: ${prompt}`);
    const response = await agent.invoke(prompt);
    console.log(`ASSISTANT: ${response}`);
  }

  const nodes = await agent.getActiveNodes();
  const segments = await agent.getActiveSegments();
  const core = agent["core"];
  const store = core.store;

  console.log(`\nTopics formed: ${nodes.length}`);
  console.log(`Segments formed: ${segments.length}`);

  const memoriesBySegment = await Promise.all(
    segments.map(async (segment) => ({
      segment,
      memories: await store.getMemoriesBySegment(segment.id),
    })),
  );

  for (const { segment, memories } of memoriesBySegment) {
    console.log(`\nSegment ${segment.topicOrder} — ${memories.length} memories:`);
    for (const m of memories) {
      console.log(`  [${m.memoryType}] ${m.subject} | ${m.predicate}: ${m.value} (explicitness: ${m.quality.explicitness})`);
    }
  }

  console.log("\n========================================");
  console.log("APPROACH A: graft() — topic summaries");
  console.log("========================================");
  const graftResult = await agent.graft();
  console.log(graftResult.systemPrompt);
  console.log(`\nToken estimate: ${graftResult.tokenCount}`);

  console.log("\n========================================");
  console.log("APPROACH B: searchMemories() — targeted");
  console.log("========================================");
  const embedder = core.embedder;
  const sessionId = agent.getSessionId();
  const queryEmbedding = await embedder.embed("infrastructure budget and database choice");
  const minSimilarity = 0.25;
  const matched = await store.searchMemories(queryEmbedding, sessionId, 5, minSimilarity);
  console.log(`Memories returned: ${matched.length}`);
  for (const m of matched) {
    console.log(`  [${m.memoryType}] ${m.subject} | ${m.predicate}: ${m.value}`);
    console.log(`    similarity: ${m.similarity.toFixed(3)} | explicitness: ${m.quality.explicitness}`);
  }

  const memoryTokenEstimate = matched.reduce(
    (sum, m) => sum + Math.ceil(`${m.subject} ${m.predicate}: ${m.value}`.length / 4),
    0,
  );
  console.log(`\nToken estimate (top 5 memories): ${memoryTokenEstimate}`);

  assert("at least one memory node exists", matched.length > 0);
  assert("at least one memory node exists per segment", memoriesBySegment.every(({ memories }) => memories.length > 0));
  assert("budget memory appears in results", matched.some((m) => m.value.toLowerCase().includes("500")));
  assert("database memory appears in results", matched.some((m) => m.value.toLowerCase().includes("postgresql")));
  assert("all results above min similarity", matched.every((m) => m.similarity >= minSimilarity));
  assert("searchMemories is more token-efficient than graft()", memoryTokenEstimate < graftResult.tokenCount);
} finally {
  await agent.close();
}
