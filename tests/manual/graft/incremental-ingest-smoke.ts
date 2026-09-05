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
        label: last.toLowerCase().includes("budget") ? "Japan Budget" : "Japan Travel",
        user_intent: "The user is discussing Japan travel preferences.",
        outcome: "The conversation captured Japan travel context that should persist incrementally.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "user",
          predicate: "discussed",
          value: last.toLowerCase().includes("budget")
            ? "A 2500 dollar Japan trip budget."
            : "A Japan trip with quiet towns and cafes.",
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
    const normalized = text.toLowerCase();
    vector[normalized.includes("budget") || normalized.includes("2500") ? 1 : 0] = 1;
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
      recentWindowSize: 6,
      recallLimit: 6,
      recallMinSimilarity: 0.2,
    },
  });
}

if (await skipWithoutDatabase("manual/incremental-ingest-smoke")) {
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

  console.log("\n=== Graft source into target ===");
  const copied = await target.absorbFromAgent(source, { topicIds: [sourceNodes[0]!.id] });
  console.log("copied nodes:", copied.map((node) => ({ id: node.id, label: node.label })));
  if (copied.length !== 1) throw new Error("Expected one copied node.");

  const copiedNodeId = copied[0]!.id;

  console.log("\n=== Target incremental invokes ===");
  await target.invoke("Tell me something new about the trip.");
  await target.invoke("Also remember that my budget is 2500 dollars.");

  const targetNodes = await target.getActiveNodes();
  console.log("target nodes:", targetNodes.map((node) => ({
    id: node.id,
    label: node.label,
    range: node.messageRange.join("-"),
  })));

  if (!targetNodes.some((node) => node.id === copiedNodeId)) {
    throw new Error("Smoke failed: copied graft node disappeared after incremental ingest.");
  }

  const nativeNodes = targetNodes.filter((node) => node.id !== copiedNodeId);
  const nativeLabels = nativeNodes.map((node) => node.label);
  const hasTravelNode = nativeNodes.some((node) => node.label === "Japan Travel" && node.messageRange.join("-") === "0-1");
  const hasBudgetNode = nativeNodes.some((node) => node.label === "Japan Budget" && node.messageRange.join("-") === "2-3");

  console.log("native drift nodes:", nativeNodes.map((node) => ({
    id: node.id,
    label: node.label,
    range: node.messageRange.join("-"),
  })));

  if (!hasTravelNode || !hasBudgetNode) {
    throw new Error([
      "Smoke failed: drift detection did not create the expected incremental native topic split.",
      `Expected native nodes Japan Travel range 0-1 and Japan Budget range 2-3.`,
      `Actual native labels: ${nativeLabels.join(", ") || "(none)"}.`,
    ].join(" "));
  }

  const ranges = new Set(targetNodes.map((node) => node.messageRange.join("-")));
  if (ranges.size !== targetNodes.length) {
    throw new Error("Smoke failed: duplicate topic ranges were created.");
  }

  console.log("\nSmoke passed: incremental ingest preserved grafted nodes, appended native nodes, and detected topic drift.");
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
