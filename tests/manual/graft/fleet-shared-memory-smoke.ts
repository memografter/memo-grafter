import assert from "node:assert/strict";
import {
  MemoGrafterFleet,
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
} from "../../../src/index.js";
import { skipWithoutDatabase } from "../../setup.js";

class FleetSharedMemorySmokeLLM implements LLMAdapter {
  async complete(messages: Message[], system?: string): Promise<string> {
    const prompt = messages.at(-1)?.content ?? "";

    if (prompt.includes("Analyze this conversation segment")) {
      return JSON.stringify({
        label: "Refund Policy",
        user_intent: "The user provided a shared fleet refund policy.",
        outcome: "The refund policy was captured as shared fleet knowledge.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "refund policy",
          predicate: "allows",
          value: "Customers can request refunds within 30 days.",
          quality: { explicitness: 0.96, sourceReliability: 0.96, stability: 0.96, salience: 0.96 },
        }],
      });
    }

    if (system?.toLowerCase().includes("30 days")) {
      return "Shared policy says customers can request refunds within 30 days.";
    }

    return `Response to: ${prompt}`;
  }
}

class FleetSharedMemorySmokeEmbedder implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    const normalized = text.toLowerCase();
    vector[normalized.includes("refund") || normalized.includes("policy") ? 0 : 1] = 1;
    return vector;
  }
}

if (await skipWithoutDatabase("manual/fleet-shared-memory-smoke")) {
  process.exit(0);
}

const fleet = new MemoGrafterFleet({
  db: { connectionString: requiredEnv("DATABASE_URL") },
  llm: new FleetSharedMemorySmokeLLM(),
  embedder: new FleetSharedMemorySmokeEmbedder(),
  drift: {
    mode: "intent",
    minSegmentMessages: 1,
  },
  graph: {
    topK: 3,
    hopDepth: 1,
  },
  inject: {
    tokenBudget: 1200,
  },
}, {
  id: `manual-shared-memory-${Date.now()}`,
  name: "Manual Fleet Shared Memory Smoke",
});

await fleet.initialize();

try {
  await fleet.ingestToFleet("Company refund policy: customers can request refunds within 30 days.", {
    tags: ["policy", "support"],
    source: "support-handbook",
  });

  const shared = await fleet.getSharedMemory();
  assert.equal(shared.sessionId, fleet.getSharedSessionId());
  assert.ok(shared.nodes.length > 0, "shared fleet ingestion should create topic nodes");
  assert.ok(
    shared.memories.some((memory) => memory.value.toLowerCase().includes("30 days")),
    "shared fleet ingestion should create an inspectable refund fact",
  );
  assert.ok(shared.nodes.every((node) => node.fleetId === fleet.id));
  assert.ok(shared.memories.every((memory) => memory.fleetId === fleet.id));

  const directRecall = await fleet.recallFromFleet("refund policy", { minSimilarity: 0.1 });
  assert.ok(
    directRecall.facts.some((fact) => fact.value.toLowerCase().includes("30 days")),
    "fleet.recallFromFleet() should retrieve shared memory",
  );

  const supportLocal = await fleet.createWorker({ color: "support-local" });
  const localOnlyRecall = await supportLocal.recall("refund policy", {
    memory: "local",
    minSimilarity: 0.1,
  });
  assert.equal(localOnlyRecall.facts.length, 0, "local-only worker recall should not see fleet memory");

  const supportShared = await fleet.createWorker({ color: "support-shared", memory: "both" });
  const combinedRecall = await supportShared.recall("refund policy", {
    memory: "both",
    minSimilarity: 0.1,
  });
  assert.ok(
    combinedRecall.facts.some((fact) => fact.value.toLowerCase().includes("30 days")),
    "combined worker recall should include fleet memory",
  );

  const fleetGraft = await supportShared.graftByRelevance("refund policy", {
    memory: "fleet",
    minSimilarity: 0.1,
    expansionStrategy: "none",
  });
  assert.ok(
    fleetGraft.nodes.some((node) => node.sessionId === fleet.getSharedSessionId()),
    "fleet-only relevance graft should include shared fleet nodes",
  );

  const answer = await supportShared.invoke("What is the refund window?");
  assert.ok(
    answer.toLowerCase().includes("30 days"),
    "worker invoke() configured with memory: both should use shared fleet memory",
  );

  console.log("fleet shared memory smoke passed");
  console.log(JSON.stringify({
    fleetId: fleet.id,
    sharedSessionId: fleet.getSharedSessionId(),
    sharedNodes: shared.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      sessionId: node.sessionId,
      fleetId: node.fleetId,
      agentColor: node.agentColor,
      tags: node.tags,
    })),
    sharedFacts: shared.memories.map((memory) => ({
      subject: memory.subject,
      predicate: memory.predicate,
      value: memory.value,
      sessionId: memory.sessionId,
      fleetId: memory.fleetId,
      agentColor: memory.agentColor,
      tags: memory.tags,
    })),
    directRecallFacts: directRecall.facts.length,
    combinedRecallFacts: combinedRecall.facts.length,
    graftedNodeSessions: fleetGraft.nodes.map((node) => node.sessionId),
    invokeAnswer: answer,
  }, null, 2));
} finally {
  await fleet.close();
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Add it to .env and run with tsx --env-file=.env.`);
  }
  return value;
}
