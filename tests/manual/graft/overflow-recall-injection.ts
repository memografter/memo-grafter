import assert from "node:assert/strict";
import {
  MemoGrafterAgent,
  type EmbedAdapter,
  type LLMAdapter,
  type MemoGrafterConfig,
  type Message,
  type RetrievalResult,
  type RetrieverConfig,
  type TopicNode,
  type TopicSegment,
} from "../../../src/index.js";

type AgentInternals = {
  core: {
    enqueueIncrementalIngest(messages: Message[], sessionId: string, startIndex: number): Promise<void>;
    getTopics(sessionId: string): Promise<{ nodes: TopicNode[]; segments: TopicSegment[] }>;
    store: {
      getSessionNodeCount(sessionId: string): Promise<number>;
    };
  };
  recall(query: string, options?: RetrieverConfig): Promise<RetrievalResult>;
};

class CapturingLLMAdapter implements LLMAdapter {
  calls: Array<{ messages: Message[]; system?: string }> = [];

  async complete(messages: Message[], system?: string): Promise<string> {
    this.calls.push({ messages: [...messages], system });
    return `Smoke response ${this.calls.length}`;
  }
}

class FakeEmbedAdapter implements EmbedAdapter {
  async embed(): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
}

function createAgent(llm: CapturingLLMAdapter): MemoGrafterAgent {
  const config: MemoGrafterConfig = {
    db: { connectionString: "postgres://user:pass@localhost:5432/memografter_test" },
    llm,
    embedder: new FakeEmbedAdapter(),
    inject: {
      tokenBudget: 20,
      recentWindowSize: 2,
      recallLimit: 5,
      recallMinSimilarity: 0.65,
    },
  };

  return new MemoGrafterAgent(config);
}

function retrievalResult(systemPrompt: string): RetrievalResult {
  return {
    facts: [
      {
        id: "overflow-recall-memory",
        segmentId: "overflow-recall-segment",
        topicNodeId: "overflow-recall-topic",
        agentId: null,
        sessionId: "overflow-recall-session",
        memoryType: "fact",
        sourceType: "conversation",
        subject: "user",
        predicate: "prefers",
        value: "compact recall blocks",
        quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
        embedding: [0.1, 0.2, 0.3],
        sourceUrl: null,
        sourceTitle: null,
        supersededBy: null,
        decayed: false,
        hasConflict: false,
        agentColor: null,
        fleetId: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        similarity: 1,
      },
    ],
    nodes: [],
    systemPrompt,
    tokenCount: Math.ceil(systemPrompt.length / 4),
  };
}

const llm = new CapturingLLMAdapter();
const agent = createAgent(llm);
const privateAgent = agent as unknown as AgentInternals;
const recallCalls: Array<{ query: string; options: RetrieverConfig }> = [];

privateAgent.core.enqueueIncrementalIngest = async () => undefined;
privateAgent.core.store.getSessionNodeCount = async () => 1;
privateAgent.core.getTopics = async () => {
  throw new Error("getTopics should not be called during overflow recall injection");
};
privateAgent.recall = async (query, options = {}) => {
  recallCalls.push({ query, options });
  return retrievalResult("PINNED MEMORY: user prefers compact recall blocks");
};

await agent.invoke("Seed the conversation with enough text to overflow. " + "a".repeat(80));
await agent.invoke("Ask a follow-up that should keep only the recent window. " + "b".repeat(80));

const lastCall = llm.calls.at(-1);
assert.ok(lastCall, "LLM should have been called");
assert.equal(lastCall.messages.length, 4);
assert.deepEqual(lastCall.messages[0], {
  role: "system",
  content: "PINNED MEMORY: user prefers compact recall blocks",
});
assert.equal(lastCall.messages[1]?.role, "user");
assert.match(lastCall.messages[1]?.content ?? "", /^Seed the conversation/);
assert.equal(lastCall.messages[2]?.role, "assistant");
assert.equal(lastCall.messages[2]?.content, "Smoke response 1");
assert.equal(lastCall.messages[3]?.role, "user");
assert.match(lastCall.messages[3]?.content ?? "", /^Ask a follow-up/);
assert.equal(recallCalls.length, 2);
assert.deepEqual(recallCalls.at(-1)?.options, { limit: 5, minSimilarity: 0.65 });

console.log("overflow recall injection smoke passed");
console.log("LLM messages on overflow:", lastCall.messages);
