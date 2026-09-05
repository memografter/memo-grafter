import assert from "node:assert/strict";
import {
  MemoGrafterAgent,
  OpenAIEmbedAdapter,
  OpenAILLMAdapter,
  type RetrievalResult,
} from "../../../src/index.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function printRecall(label: string, result: RetrievalResult): void {
  console.log(`\n========================================`);
  console.log(label);
  console.log("========================================");
  console.log(`Facts: ${result.facts.length}`);
  for (const fact of result.facts) {
    console.log(
      `  [${fact.memoryType}] ${fact.subject} ${fact.predicate}: ${fact.value}`,
    );
    console.log(`    similarity: ${fact.similarity.toFixed(3)} | explicitness: ${fact.quality.explicitness}`);
  }

  console.log(`Nodes: ${result.nodes.length}`);
  for (const node of result.nodes) {
    console.log(`  ${node.id} | ${node.label} | order ${node.topicOrder}`);
  }

  console.log(`Token estimate: ${result.tokenCount}`);
  console.log("\nSystem prompt:");
  console.log(result.systemPrompt);
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for recall-smoke.");
}

const agent = new MemoGrafterAgent({
  db: { connectionString: process.env.DATABASE_URL },
  llm: new OpenAILLMAdapter("gpt-4o-mini"),
  embedder: new OpenAIEmbedAdapter(),
  systemPrompt: "You are a helpful assistant.",
});

await agent.initialize();

try {
  const prompts = [
    "For deployment config, remember that staging uses blue-green rollout with canary checks.",
    "Production deploys require manual approval and the Kubernetes namespace is memografter-prod.",
    "For team onboarding, new engineers should complete the graph memory walkthrough first.",
    "Onboarding also includes pairing with the platform team during the first sprint.",
  ];

  for (const prompt of prompts) {
    console.log(`\nUSER: ${prompt}`);
    const response = await agent.invoke(prompt);
    console.log(`ASSISTANT: ${response}`);
  }

  // The default agent path is synchronous, but invoke() still schedules ingestion
  // through a background promise. This gives that promise a short moment to settle.
  await sleep(500);
  const activeNodes = await agent.getActiveNodes();
  console.log(`\nTopics available before recall: ${activeNodes.length}`);

  const deployment = await agent.recall(
    "deployment config manual approval Kubernetes namespace",
    { minSimilarity: 0.25 },
  );
  printRecall("RECALL: deployment config", deployment);

  const onboarding = await agent.recall("team onboarding", { minSimilarity: 0.25 });
  printRecall("RECALL: team onboarding", onboarding);

  const unrelated = await agent.recall(
    "medieval pottery glaze chemistry",
    { minSimilarity: 0.95 },
  );
  printRecall("RECALL: unrelated high-threshold query", unrelated);
  assert.equal(unrelated.facts.length, 0);
} finally {
  await agent.close();
}
