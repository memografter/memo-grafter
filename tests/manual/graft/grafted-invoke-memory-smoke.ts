import {
  type EmbedAdapter,
  type LLMAdapter,
  type Message,
  MemoGrafterAgent,
  type TopicNode,
} from "../../../src/index.js";

const useQueue = Boolean(process.env.REDIS_URL);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createAgent = () => new MemoGrafterAgent({
  db: { connectionString: requiredEnv("DATABASE_URL") },
  llm: new SmokeLLMAdapter(),
  embedder: new SmokeEmbedAdapter(),
  ...(useQueue
    ? {
      queue: {
        redisUrl: requiredEnv("REDIS_URL"),
      },
    }
    : {}),
  drift: {
    mode: "intent",
    threshold: 0.3,
    minSegmentMessages: 3,
  },
  graph: {
    topK: 5,
    hopDepth: 2,
  },
  inject: {
    bufferSize: 2,
    tokenBudget: 1800,
    recentWindowSize: 6,
    recallLimit: 6,
    recallMinSimilarity: 0.45,
  },
});

class SmokeLLMAdapter implements LLMAdapter {
  async complete(messages: Message[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";

    if (last.includes("Conversation segment:")) {
      return JSON.stringify({
        label: "Japan Trip Preferences",
        user_intent: "The user is planning a Japan trip and wants a reflective travel angle.",
        outcome: "The conversation captured preferences for quiet towns, bookstores, local cafes, and a 2500 dollar budget.",
        open: null,
        memories: [
          {
            memory_type: "fact",
            subject: "user",
            predicate: "is planning",
            value: "A Japan trip.",
            quality: { explicitness: 0.98, sourceReliability: 0.98, stability: 0.98, salience: 0.98 },
          },
          {
            memory_type: "fact",
            subject: "user",
            predicate: "prefers",
            value: "Quiet towns, bookstores, and local cafes.",
            quality: { explicitness: 0.98, sourceReliability: 0.98, stability: 0.98, salience: 0.98 },
          },
          {
            memory_type: "fact",
            subject: "user",
            predicate: "has budget",
            value: "Around 2500 dollars for the Japan trip.",
            quality: { explicitness: 0.98, sourceReliability: 0.98, stability: 0.98, salience: 0.98 },
          },
        ],
      });
    }

    const systemText = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");

    if (systemText.toLowerCase().includes("japan")) {
      return "Begin with a quiet Japan morning: a traveler stepping from a small-town station toward bookstores, local cafes, and a thoughtful 2500 dollar budget.";
    }

    return `Response to: ${last}`;
  }
}

class SmokeEmbedAdapter implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(1536).fill(0);
    const normalized = text.toLowerCase();

    if (
      normalized.includes("japan")
      || normalized.includes("quiet")
      || normalized.includes("bookstore")
      || normalized.includes("cafe")
      || normalized.includes("2500")
      || normalized.includes("budget")
    ) {
      vector[0] = 1;
    } else {
      vector[1] = 1;
    }

    return vector;
  }
}

const travelBot = createAgent();
const writingBot = createAgent();

await travelBot.initialize();
await writingBot.initialize();

try {
  console.log("\n=== Seed travel memory ===");
  await say(travelBot, "travel", "I am planning a Japan trip.");
  await say(travelBot, "travel", "I like quiet towns, bookstores, and local cafes.");
  await say(travelBot, "travel", "My budget is around 2500 dollars.");

  const sourceNodes = await waitForNodes(travelBot, 1, "travelBot");
  printNodes("travelBot nodes", sourceNodes);

  const sourceRecall = await travelBot.recall("Japan trip quiet towns bookstores cafes budget 2500 dollars", {
    limit: 10,
    minSimilarity: 0.2,
  });
  console.log("\nSource facts before graft:", sourceRecall.facts.map((fact) => ({
    subject: fact.subject,
    predicate: fact.predicate,
    value: fact.value,
    similarity: Number(fact.similarity.toFixed(3)),
  })));

  if (sourceRecall.facts.length === 0) {
    throw new Error([
      "Smoke failed before graft: travelBot has topic nodes but no searchable memory facts.",
      "This means ingestion produced mg_topic_nodes without mg_memory_nodes, so there is nothing for grafting to copy.",
      "Try rerunning, or inspect the segment extraction response for an empty memories array.",
    ].join(" "));
  }

  console.log("\n=== Absorb travel memory into writing bot ===");
  const copiedNodes = await writingBot.absorbFromAgent(travelBot, {
    topicIds: sourceNodes.map((node) => node.id),
  });
  printNodes("copied nodes", copiedNodes);

  if (copiedNodes.length === 0) {
    throw new Error("Smoke failed: no source topic nodes were copied into writingBot.");
  }

  const recall = await writingBot.recall("Suggest a reflective blog intro for my Japan trip.", {
    limit: 6,
    minSimilarity: 0.2,
  });
  console.log("\nRecalled facts after graft:", recall.facts.map((fact) => ({
    subject: fact.subject,
    predicate: fact.predicate,
    value: fact.value,
    similarity: Number(fact.similarity.toFixed(3)),
  })));

  if (recall.facts.length === 0) {
    throw new Error("Smoke failed: writingBot.recall() found no grafted facts.");
  }

  console.log("\n=== Invoke writing bot with grafted memory ===");
  const answer = await writingBot.invoke("Suggest a reflective blog intro for my Japan trip.");
  console.log("\nAnswer:\n", answer);

  const lowerAnswer = answer.toLowerCase();
  const mentionsGraftedContext = ["japan", "quiet", "bookstore", "cafe", "2500", "budget"]
    .some((term) => lowerAnswer.includes(term));

  if (!mentionsGraftedContext) {
    throw new Error("Smoke failed: invoke() answer did not mention obvious grafted context.");
  }

  console.log("\nSmoke passed: grafted memory was searchable and surfaced through invoke().");
} finally {
  await travelBot.close();
  await writingBot.close();
}

async function say(agent: MemoGrafterAgent, label: string, message: string): Promise<void> {
  console.log(`\n${label} user: ${message}`);
  const response = await agent.invoke(message);
  console.log(`${label} assistant: ${response}`);
}

async function waitForNodes(agent: MemoGrafterAgent, minimum: number, label: string): Promise<TopicNode[]> {
  const attempts = useQueue ? 20 : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nodes = await agent.getActiveNodes();
    if (nodes.length >= minimum) return nodes;

    if (useQueue) {
      console.log(`${label}: waiting for background ingest (${nodes.length}/${minimum} nodes)...`);
      await sleep(1000);
    }
  }

  const nodes = await agent.getActiveNodes();
  if (nodes.length < minimum) {
    throw new Error(`${label}: expected at least ${minimum} node(s), found ${nodes.length}.`);
  }
  return nodes;
}

function printNodes(title: string, nodes: TopicNode[]): void {
  console.log(`\n${title}:`);
  console.table(nodes.map((node) => ({
    id: node.id,
    label: node.label,
    range: node.messageRange.join("-"),
    order: node.topicOrder,
    summary: node.summary.slice(0, 120),
  })));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Add it to .env and run with tsx --env-file=.env.`);
  }
  return value;
}
