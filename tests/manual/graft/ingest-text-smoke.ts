import {
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
  MemoGrafterAgent,
} from "../../../src/index.js";
import { skipWithoutDatabase } from "../../setup.js";

class SmokeLLMAdapter implements LLMAdapter {
  responseCalls = 0;

  async complete(messages: Message[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    if (last.includes("Conversation segment:")) {
      return JSON.stringify({
        label: last.toLowerCase().includes("roadmap") ? "Product Roadmap" : "Morning Notes",
        user_intent: "The text records useful planning context.",
        outcome: "The planning context was captured for later recall.",
        open: null,
        memories: [{
          memory_type: "fact",
          subject: "project",
          predicate: "focuses on",
          value: last.toLowerCase().includes("roadmap")
            ? "document import workflows."
            : "quiet morning planning.",
          quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
        }],
      });
    }

    this.responseCalls += 1;
    return `Response to: ${last}`;
  }
}

class SmokeEmbedAdapter implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    vector[text.toLowerCase().includes("roadmap") || text.toLowerCase().includes("import") ? 1 : 0] = 1;
    return vector;
  }
}

if (await skipWithoutDatabase("manual/ingest-text-smoke")) {
  process.exit(0);
}

const llm = new SmokeLLMAdapter();
const agent = new MemoGrafterAgent({
  db: { connectionString: requiredEnv("DATABASE_URL") },
  llm,
  embedder: new SmokeEmbedAdapter(),
  drift: {
    mode: "intent",
    minSegmentMessages: 1,
  },
});

await agent.initialize();

try {
  await agent.ingestText([
    "A quiet morning planning note.",
    "The product roadmap now focuses on document import workflows.",
  ].join("\n"), {
    label: "Morning entry",
    source: "classic-editor",
  });

  if (llm.responseCalls !== 0) throw new Error("ingestText() generated an assistant response.");
  if (agent.getHistory().length !== 0) throw new Error("ingestText() changed public chat history.");

  const firstSnapshot = await agent.getGraphSnapshot();
  if (firstSnapshot.nodes.length !== 2) throw new Error("Expected two topic nodes after multi-topic text ingestion.");
  if (firstSnapshot.nodes[0]?.source !== "classic-editor") throw new Error("Topic source metadata was not stored.");
  if (firstSnapshot.memories[0]?.source !== "classic-editor") throw new Error("Memory source metadata was not stored.");
  if (firstSnapshot.memories[0]?.sourceType !== "document") throw new Error("Text memory source type was not document.");

  await agent.ingestText("The product roadmap now focuses on document import workflows.", {
    replace: true,
    source: "import",
  });

  const replacementSnapshot = await agent.getGraphSnapshot();
  if (replacementSnapshot.nodes.length !== 1) throw new Error("replace: true stacked topic nodes.");
  if (replacementSnapshot.nodes[0]?.source !== "import") throw new Error("Replacement source metadata was not stored.");

  const answer = await agent.invoke("What does the roadmap focus on?");
  if (!answer) throw new Error("invoke() did not return a response after text ingestion.");
  if (agent.getHistory().length !== 2) throw new Error("invoke() chat history behavior changed.");

  console.log("Smoke passed: ingestText() built replaceable graph memory without changing invoke() history behavior.");
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
