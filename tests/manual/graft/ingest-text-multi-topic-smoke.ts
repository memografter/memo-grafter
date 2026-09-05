import {
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
  MemoGrafterAgent,
} from "../../../src/index.js";
import { skipWithoutDatabase } from "../../setup.js";

class MultiTopicLLMAdapter implements LLMAdapter {
  async complete(messages: Message[]): Promise<string> {
    const prompt = messages.at(-1)?.content ?? "";
    if (!prompt.includes("Conversation segment:")) {
      throw new Error("This smoke test should not generate an assistant response.");
    }

    const normalized = prompt.toLowerCase();
    const isHiring = normalized.includes("hiring") || normalized.includes("engineer");

    return JSON.stringify({
      label: isHiring ? "Engineering Hiring Plan" : "Document Import Roadmap",
      user_intent: isHiring
        ? "The text describes the engineering hiring plan."
        : "The text describes the document import roadmap.",
      outcome: isHiring
        ? "Hiring priorities and onboarding expectations were captured."
        : "Document import and editor workflow priorities were captured.",
      open: null,
      memories: [{
        memory_type: "fact",
        subject: isHiring ? "engineering team" : "product roadmap",
        predicate: "prioritizes",
        value: isHiring
          ? "backend hiring and graph-memory onboarding."
          : "document imports and editor autosave workflows.",
        quality: { explicitness: 0.95, sourceReliability: 0.95, stability: 0.95, salience: 0.95 },
      }],
    });
  }
}

class MultiTopicEmbedAdapter implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    const normalized = text.toLowerCase();

    if (normalized.includes("hiring") || normalized.includes("engineer") || normalized.includes("onboarding")) {
      vector[1] = 1;
    } else {
      vector[0] = 1;
    }

    return vector;
  }
}

if (await skipWithoutDatabase("manual/ingest-text-multi-topic-smoke")) {
  process.exit(0);
}

const agent = new MemoGrafterAgent({
  db: { connectionString: requiredEnv("DATABASE_URL") },
  llm: new MultiTopicLLMAdapter(),
  embedder: new MultiTopicEmbedAdapter(),
  drift: {
    mode: "intent",
    driftSensitivity: "low",
    minSegmentMessages: 3,
  },
});

await agent.initialize();

try {
  const bigText = [
    "The product roadmap prioritizes document imports for customer research.",
    "Users should be able to paste transcripts and upload reference documents.",
    "The classic editor should autosave the current document after typing pauses.",
    "Import provenance must be visible so applications can distinguish editor content from uploaded files.",
    "",
    "The engineering team also needs a hiring plan for the next quarter.",
    "We want to hire backend engineers who are comfortable with PostgreSQL and vector search.",
    "New engineers should complete the graph-memory onboarding walkthrough in their first week.",
    "The hiring plan should include pairing sessions with the platform team.",
  ].join("\n");

  await agent.ingestText(bigText, {
    replace: true,
    label: "Planning notes",
    source: "import",
  });

  const nodes = await agent.getActiveNodes();

  console.log("\nCreated topic nodes:");
  for (const node of nodes) {
    console.log({
      id: node.id,
      label: node.label,
      summary: node.summary,
      messageRange: node.messageRange,
      topicOrder: node.topicOrder,
      driftScore: node.driftScore,
      source: node.source,
    });
  }

  if (nodes.length < 2) {
    throw new Error(`Expected at least two topic nodes from one large text string, received ${nodes.length}.`);
  }

  if (agent.getHistory().length !== 0) {
    throw new Error("ingestText() changed public chat history.");
  }

  console.log(`\nSmoke passed: one ingestText() call created ${nodes.length} topic nodes.`);
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
