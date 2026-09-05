import assert from "node:assert/strict";
import {
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
  MemoGrafterAgent,
} from "../../../src/index.js";
import { skipWithoutDatabase } from "../../setup.js";

class RememberSmokeLLMAdapter implements LLMAdapter {
  responseCalls = 0;

  async complete(messages: Message[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    if (last.includes("Conversation segment:")) {
      return JSON.stringify({
        label: "Remembered Preference",
        user_intent: "The app is explicitly storing a user preference.",
        outcome: "The preference was captured for later recall.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "user",
          predicate: "prefers",
          value: "concise TypeScript examples.",
          quality: { explicitness: 0.99, sourceReliability: 0.99, stability: 0.99, salience: 0.99 },
        }],
      });
    }

    this.responseCalls += 1;
    return `Response to: ${last}`;
  }
}

class RememberSmokeEmbedAdapter implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    const lower = text.toLowerCase();
    vector[lower.includes("typescript") || lower.includes("preference") ? 1 : 0] = 1;
    return vector;
  }
}

if (await skipWithoutDatabase("manual/remember-smoke")) {
  process.exit(0);
}

const llm = new RememberSmokeLLMAdapter();
const agent = new MemoGrafterAgent({
  db: { connectionString: requiredEnv("DATABASE_URL") },
  llm,
  embedder: new RememberSmokeEmbedAdapter(),
  drift: {
    mode: "intent",
    minSegmentMessages: 1,
  },
});

await agent.initialize();

try {
  await agent.setSessionTags(["Preference", "remember-smoke"]);
  await agent.remember("The user prefers concise TypeScript examples.", {
    label: "User preference",
  });

  assert.equal(llm.responseCalls, 0, "remember() generated an assistant response");
  assert.equal(agent.getHistory().length, 0, "remember() changed public chat history");

  const snapshot = await agent.getGraphSnapshot();
  assert.equal(snapshot.nodes.length, 1, "expected one topic node after remember()");
  assert.equal(snapshot.memories.length, 1, "expected one memory node after remember()");

  const node = snapshot.nodes[0];
  const memory = snapshot.memories[0];
  assert.ok(node, "expected remembered topic node");
  assert.ok(memory, "expected remembered memory node");
  assert.equal(node.source, "remember", "remember() did not default topic source metadata");
  assert.equal(memory.source, "remember", "remember() did not default memory source metadata");
  assert.equal(memory.sourceType, "document", "remember() should reuse the ingestText source type");
  assert.equal(memory.quality.explicitness, 0.99, "remember() did not preserve extracted memory explicitness");
  assert.deepEqual(memory.tags, ["preference", "remember-smoke"], "remember() did not apply session tags");

  const recall = await agent.recall("TypeScript example preference", {
    minSimilarity: 0.1,
    tags: ["remember-smoke"],
  });
  assert.ok(recall.facts.length > 0, "expected remembered fact to be recallable");
  assert.equal(recall.facts[0]?.source, "remember", "recalled fact did not retain remember source");

  console.log("Smoke passed: remember() stored explicit memory through ingestText without changing chat history.");
} finally {
  await agent.close();
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Add it to .env and run with tsx --env-file=.env.`);
  }
  return value;
}
