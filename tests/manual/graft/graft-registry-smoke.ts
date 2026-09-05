import {
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
  MemoGrafterAgent,
} from "../../../src/index.js";
import { skipWithoutDatabase } from "../../setup.js";

class SmokeLLMAdapter implements LLMAdapter {
  async complete(messages: Message[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    if (last.includes("Conversation segment:")) {
      return JSON.stringify({
        label: "Japan Travel",
        user_intent: "The user is discussing Japan travel preferences.",
        outcome: "The conversation captured travel context for later grafting.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "user",
          predicate: "plans",
          value: "A Japan trip with quiet towns and cafes.",
          quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
        }],
      });
    }

    return `Response to: ${last}`;
  }
}

class SmokeEmbedAdapter implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    vector[text.toLowerCase().includes("japan") ? 0 : 1] = 1;
    return vector;
  }
}

function createAgent(): MemoGrafterAgent {
  return new MemoGrafterAgent({
    db: { connectionString: requiredEnv("DATABASE_URL") },
    llm: new SmokeLLMAdapter(),
    embedder: new SmokeEmbedAdapter(),
    drift: {
      mode: "intent",
      minSegmentMessages: 1,
      driftSensitivity: "low",
    },
    inject: {
      recallLimit: 6,
      recallMinSimilarity: 0.2,
    },
  });
}

if (await skipWithoutDatabase("manual/graft-registry-smoke")) {
  process.exit(0);
}

const source = createAgent();
const target = createAgent();

await source.initialize();
await target.initialize();

try {
  console.log("\n=== Source ingest ===");
  await source.invoke("I am planning a Japan trip with quiet towns and cafes.");
  const sourceNodes = await source.getActiveNodes();
  console.log("source nodes:", sourceNodes.map((node) => ({ id: node.id, label: node.label })));
  if (sourceNodes.length === 0) throw new Error("Expected source nodes.");

  console.log("\n=== Graft into target ===");
  const copied = await target.absorbFromAgent(source, { topicIds: [sourceNodes[0]!.id] });
  console.log("copied nodes:", copied.map((node) => ({ id: node.id, label: node.label })));
  if (copied.length !== 1) throw new Error("Expected one copied node.");

  const registry = await target.getGraftRegistry();
  console.log("registry:", registry.map((entry) => ({
    nodeId: entry.nodeId,
    sourceSessionId: entry.sourceSessionId,
    sourceNodeId: entry.sourceNodeId,
  })));

  if (registry.length !== 1) throw new Error("Expected one graft registry entry.");
  if (registry[0]?.nodeId !== copied[0]?.id) throw new Error("Registry node id did not match copied node.");
  if (registry[0]?.sourceSessionId !== source.getSessionId()) throw new Error("Registry source session id mismatch.");
  if (registry[0]?.sourceNodeId !== sourceNodes[0]?.id) throw new Error("Registry source node id mismatch.");

  const snapshot = await target.getGraphSnapshot();
  const graftSnapshot = snapshot.snapshotNodes?.find((item) => item.node.id === copied[0]?.id);
  console.log("snapshot graft origin:", graftSnapshot?.graftOrigin);
  if (!graftSnapshot?.graftOrigin) throw new Error("Snapshot did not include graft origin.");

  console.log("\n=== Remove graft ===");
  await target.removeGraft(copied[0]!.id);
  const afterRegistry = await target.getGraftRegistry();
  const afterNodes = await target.getActiveNodes();
  console.log("registry after remove:", afterRegistry.length);
  console.log("target nodes after remove:", afterNodes.map((node) => ({ id: node.id, label: node.label })));

  if (afterRegistry.length !== 0) throw new Error("Registry entry survived removeGraft().");
  if (afterNodes.some((node) => node.id === copied[0]?.id)) throw new Error("Copied node survived removeGraft().");

  console.log("\nSmoke passed: graft registry, snapshot provenance, and removeGraft() worked.");
} finally {
  await source.close();
  await target.close();
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Add it to .env and run with tsx --env-file=.env.`);
  }
  return value;
}
