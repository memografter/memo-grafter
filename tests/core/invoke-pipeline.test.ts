import assert from "node:assert/strict";
import { MemoGrafterAgent, type EmbedAdapter, type LLMAdapter, type Message, type MemoGrafterConfig, type RetrievalResult, type RetrieverConfig, type TopicNode, type TopicSegment } from "../../src/index.js";

console.log("invoke() pipeline - proactive memory recall");

type TestCore = {
  getTopics(sessionId: string): Promise<{ nodes: TopicNode[]; segments: TopicSegment[] }>;
  inject(sessionId: string, topicIds: string[]): Promise<{ systemPrompt: string; nodes: TopicNode[]; tokenCount: number }>;
  enqueueIncrementalIngest(messages: Message[], sessionId: string, startIndex: number): Promise<void>;
  store: {
    getSessionNodeCount(sessionId: string): Promise<number>;
  };
};

class CapturingLLMAdapter implements LLMAdapter {
  calls: Array<{ messages: Message[]; system?: string }> = [];

  async complete(messages: Message[], system?: string): Promise<string> {
    this.calls.push({ messages: [...messages], system });
    return `Response to: ${messages.at(-1)?.content ?? ""}`;
  }
}

class FakeEmbedAdapter implements EmbedAdapter {
  async embed(): Promise<number[]> {
    return new Array<number>(1536).fill(0);
  }
}

function createAgent(overrides: Partial<MemoGrafterConfig> = {}): MemoGrafterAgent {
  const llm = overrides.llm ?? new CapturingLLMAdapter();
  const embedder = overrides.embedder ?? new FakeEmbedAdapter();

  return new MemoGrafterAgent({
    db: { connectionString: "postgres://user:pass@localhost:5432/memografter_test" },
    llm,
    embedder,
    inject: {
      bufferSize: 1,
      tokenBudget: 1200,
    },
    ...overrides,
  });
}

function patchCore(agent: MemoGrafterAgent): TestCore {
  const core = (agent as unknown as { core: TestCore }).core;
  core.enqueueIncrementalIngest = async () => undefined;
  return core;
}

function historyOf(agent: MemoGrafterAgent): Message[] {
  return (agent as unknown as { history: Message[] }).history;
}

function createNode(overrides: Partial<TopicNode> = {}): TopicNode {
  return {
    id: "node-1",
    sessionId: "session-1",
    segmentId: "segment-1",
    label: "Japan Travel",
    summary: "Outcome: The assistant helped plan Japan travel. Still open: choose hotels.",
    embedding: [],
    messageRange: [0, 1],
    topicOrder: 0,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

function createSegment(overrides: Partial<TopicSegment> = {}): TopicSegment {
  return {
    id: "segment-1",
    sessionId: "session-1",
    startIndex: 0,
    endIndex: 1,
    topicOrder: 0,
    driftScore: 0,
    createdAt: new Date(0),
    ...overrides,
  };
}

{
  const agent = createAgent();
  const core = patchCore(agent);
  let getTopicsCallCount = 0;
  let getSessionNodeCountCallCount = 0;
  core.getTopics = async () => {
    getTopicsCallCount += 1;
    return { nodes: [], segments: [] };
  };
  core.store.getSessionNodeCount = async () => {
    getSessionNodeCountCallCount += 1;
    return 0;
  };

  await agent.invoke("Plan a Japan trip.");
  await agent.invoke("Focus on Kyoto food.");
  await agent.invoke("Now discuss the budget.");

  assert.equal(getTopicsCallCount, 0);
  assert.equal(getSessionNodeCountCallCount, 3);
  assert.equal(agent.getHistory().length, 6);
}

{
  const llm = new CapturingLLMAdapter();
  const agent = createAgent({ llm });
  const core = patchCore(agent);
  let getTopicsCallCount = 0;
  core.getTopics = async () => {
    getTopicsCallCount += 1;
    return { nodes: [], segments: [] };
  };
  core.store.getSessionNodeCount = async () => 0;

  await agent.invoke("Short question.");

  assert.deepEqual(llm.calls[0]?.messages, [{ role: "user", content: "Short question." }]);
  assert.equal(getTopicsCallCount, 0);
}

{
  const llm = new CapturingLLMAdapter();
  const agent = createAgent({
    llm,
    inject: {
      bufferSize: 1,
      recentWindowSize: 2,
      recallLimit: 4,
      recallMinSimilarity: 0.7,
    },
  });
  const core = patchCore(agent);
  let getTopicsCallCount = 0;
  core.getTopics = async () => {
    getTopicsCallCount += 1;
    return { nodes: [], segments: [] };
  };
  core.store.getSessionNodeCount = async () => 1;
  const recallCalls: Array<{ query: string; options: RetrieverConfig }> = [];
  (agent as unknown as { recall: (query: string, options?: RetrieverConfig) => Promise<RetrievalResult> }).recall = async (query, options = {}) => {
    recallCalls.push({ query, options });
    return {
      facts: [{
        id: "memory-1",
        segmentId: "segment-1",
        topicNodeId: "node-1",
        agentId: null,
        sessionId: "session-1",
        memoryType: "fact",
        sourceType: "conversation",
        subject: "traveler",
        predicate: "prefers",
        value: "quiet towns",
        quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
        embedding: [],
        sourceUrl: null,
        sourceTitle: null,
        supersededBy: null,
        decayed: false,
        agentColor: null,
        fleetId: null,
        createdAt: new Date(0),
        similarity: 0.9,
      }],
      nodes: [],
      systemPrompt: "retrieved memory",
      tokenCount: 4,
    };
  };
  const history = historyOf(agent);
  history.push({ role: "user", content: "Earlier setup." });
  history.push({ role: "user", content: "a".repeat(80) });
  history.push({ role: "assistant", content: "b".repeat(80) });
  history.push({ role: "user", content: "Recent user question." });

  await agent.invoke("New question.");

  assert.equal(getTopicsCallCount, 0);
  assert.deepEqual(recallCalls, [
    {
      query: "New question.",
      options: { limit: 4, minSimilarity: 0.7 },
    },
  ]);
  assert.deepEqual(llm.calls[0]?.messages, [
    { role: "system", content: "retrieved memory" },
    { role: "assistant", content: "b".repeat(80) },
    { role: "user", content: "Recent user question." },
    { role: "user", content: "New question." },
  ]);
}

{
  const llm = new CapturingLLMAdapter();
  const agent = createAgent({
    llm,
    inject: {
      bufferSize: 1,
      recentWindowSize: 2,
    },
  });
  const core = patchCore(agent);
  core.store.getSessionNodeCount = async () => 1;
  const warn = console.warn;
  console.warn = () => undefined;
  (agent as unknown as { recall: (query: string, options?: RetrieverConfig) => Promise<RetrievalResult> }).recall = async () => {
    throw new Error("recall failed");
  };
  const history = historyOf(agent);
  history.push({ role: "user", content: "a".repeat(80) });
  history.push({ role: "assistant", content: "b".repeat(80) });
  history.push({ role: "user", content: "Recent user question." });

  try {
    await agent.invoke("New question.");

    assert.deepEqual(llm.calls[0]?.messages, [
      { role: "assistant", content: "b".repeat(80) },
      { role: "user", content: "Recent user question." },
      { role: "user", content: "New question." },
    ]);
  } finally {
    console.warn = warn;
  }
}

{
  const agent = createAgent();
  const core = patchCore(agent);
  let getTopicsCallCount = 0;
  let injectCallCount = 0;
  const node = createNode({ id: "node-allowed" });
  core.getTopics = async () => {
    getTopicsCallCount += 1;
    return { nodes: [node], segments: [createSegment()] };
  };
  core.inject = async (_sessionId: string, topicIds: string[]) => {
    injectCallCount += 1;
    assert.deepEqual(topicIds, ["node-allowed"]);
    return { systemPrompt: "memory", nodes: [node], tokenCount: 1 };
  };

  await agent.graft();

  assert.equal(getTopicsCallCount, 1);
  assert.equal(injectCallCount, 1);
}

{
  const llm = new CapturingLLMAdapter();
  const agent = createAgent({
    llm,
    systemPrompt: "You are a test bot.",
  });
  const core = patchCore(agent);
  core.store.getSessionNodeCount = async () => 0;

  await agent.invoke("Hello.");

  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0]?.system, "You are a test bot.");
}
