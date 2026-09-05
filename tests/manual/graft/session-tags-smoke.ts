import assert from "node:assert/strict";
import {
  MemoGrafterAgent,
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
} from "../../../src/index.js";

class SmokeLLM implements LLMAdapter {
  async complete(messages: Message[]): Promise<string> {
    const prompt = messages.at(-1)?.content ?? "";

    if (prompt.includes("Analyze this conversation segment")) {
      if (prompt.toLowerCase().includes("blue-green")) {
        return JSON.stringify({
          label: "MemoGrafter Deployment",
          user_intent: "The user wanted to store a deployment decision for MemoGrafter.",
          outcome: "MemoGrafter staging uses blue-green rollout.",
          open: null,
          memories: [{
            memory_type: "fact",
            subject: "memo-grafter deployment",
            predicate: "uses",
            value: "Staging uses blue-green rollout.",
            quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
          }],
        });
      }

      return JSON.stringify({
        label: "Mobile Planning",
        user_intent: "The user wanted to store a mobile planning note.",
        outcome: "The mobile app uses React Native.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "mobile app",
          predicate: "uses",
          value: "React Native.",
          quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        }],
      });
    }

    return "Got it.";
  }
}

class SmokeEmbedder implements EmbedAdapter {
  async embed(): Promise<number[]> {
    return Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0);
  }
}

if (!process.env.DATABASE_URL) {
  console.log("SKIP session-tags-smoke: DATABASE_URL is not set.");
  process.exit(0);
}

const memoAgent = new MemoGrafterAgent({
  db: { connectionString: process.env.DATABASE_URL },
  llm: new SmokeLLM(),
  embedder: new SmokeEmbedder(),
});
const mobileAgent = new MemoGrafterAgent({
  db: { connectionString: process.env.DATABASE_URL },
  llm: new SmokeLLM(),
  embedder: new SmokeEmbedder(),
});

await memoAgent.initialize();
await mobileAgent.initialize();

try {
  await memoAgent.setSessionTags(["project:memo-grafter", "planning", "week:2026-05-25"]);
  await mobileAgent.setSessionTags(["project:mobile", "planning"]);

  await memoAgent.invoke("Remember that MemoGrafter staging uses blue-green rollout.");
  await mobileAgent.invoke("Remember that the mobile app uses React Native.");

  const memoNodes = await memoAgent.getActiveNodes({ tags: ["project:memo-grafter"] });
  const mobileNodesFromMemoFilter = await memoAgent.getActiveNodes({ tags: ["project:mobile"] });
  const projectRecall = await mobileAgent.recall("deployment rollout", {
    tags: ["project:memo-grafter"],
    scope: "tagged",
    minSimilarity: 0.1,
  });
  const mobileOnlyRecall = await mobileAgent.recall("deployment rollout", {
    tags: ["project:mobile"],
    scope: "tagged",
    minSimilarity: 0.1,
  });

  assert.equal(memoAgent.getSessionTags().includes("project:memo-grafter"), true);
  assert.equal(memoNodes.length, 1);
  assert.equal(mobileNodesFromMemoFilter.length, 0);
  assert.equal(projectRecall.facts.some((fact) => fact.subject === "memo-grafter deployment"), true);
  assert.equal(projectRecall.facts.every((fact) => fact.tags?.includes("project:memo-grafter")), true);
  assert.equal(mobileOnlyRecall.facts.some((fact) => fact.subject === "mobile app"), true);
  assert.equal(mobileOnlyRecall.facts.every((fact) => fact.tags?.includes("project:mobile")), true);

  console.log("session tags smoke passed");
  console.log(JSON.stringify({
    memoSessionId: memoAgent.getSessionId(),
    mobileSessionId: mobileAgent.getSessionId(),
    memoTags: memoAgent.getSessionTags(),
    memoNodes: memoNodes.map((node) => ({ label: node.label, tags: node.tags })),
    projectRecallFacts: projectRecall.facts.map((fact) => ({
      subject: fact.subject,
      predicate: fact.predicate,
      value: fact.value,
      sessionId: fact.sessionId,
      tags: fact.tags,
    })),
    mobileOnlyRecallFacts: mobileOnlyRecall.facts.map((fact) => ({
      subject: fact.subject,
      predicate: fact.predicate,
      value: fact.value,
      sessionId: fact.sessionId,
      tags: fact.tags,
    })),
  }, null, 2));
} finally {
  await memoAgent.close();
  await mobileAgent.close();
}
