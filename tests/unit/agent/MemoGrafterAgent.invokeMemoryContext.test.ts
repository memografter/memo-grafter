import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoGrafterAgent } from "../../../src/agents/MemoGrafterAgent.js";
import type {
  EmbedAdapter,
  LLMAdapter,
  MemoGrafterConfig,
  MemoryNode,
  Message,
  PinnedContextResult,
  RetrievalResult,
  RetrieverConfig,
} from "../../../src/core/types.js";

type AgentInternals = {
  pendingIngest: Promise<void>;
  core: {
    llm: LLMAdapter;
    store: {
      getSessionNodeCount(sessionId: string): Promise<number>;
    };
    enqueueIncrementalIngest(messages: Message[], sessionId: string, startIndex: number): Promise<void>;
    combinePinnedContext(sessionId: string, result: RetrievalResult, pinned?: PinnedContextResult): Promise<RetrievalResult>;
    getPinnedContext(sessionId: string): Promise<PinnedContextResult>;
  };
  recall(query: string, options?: RetrieverConfig): Promise<RetrievalResult>;
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
    return [0.1, 0.2, 0.3];
  }
}

function createAgent(overrides: Partial<MemoGrafterConfig> = {}): MemoGrafterAgent {
  const agent = new MemoGrafterAgent({
    db: { connectionString: "postgres://user:pass@localhost:5432/memografter_test" },
    llm: new CapturingLLMAdapter(),
    embedder: new FakeEmbedAdapter(),
    ...overrides,
  });
  internals(agent).core.getPinnedContext = vi.fn(async () => ({
    systemPrompt: "", nodes: [], memories: [], tokenCount: 0, tokenBudget: 4000, truncated: false,
  }));
  return agent;
}

function internals(agent: MemoGrafterAgent): AgentInternals {
  return agent as unknown as AgentInternals;
}

function memory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "memory-1",
    segmentId: "segment-1",
    topicNodeId: "topic-1",
    agentId: null,
    sessionId: "session-1",
    memoryType: "fact",
    sourceType: "conversation",
    subject: "traveler",
    predicate: "prefers",
    value: "quiet towns in Japan",
    confidence: 1,
    embedding: [0.1, 0.2, 0.3],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    agentColor: null,
    fleetId: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

function retrievalResult(systemPrompt: string): RetrievalResult {
  return {
    facts: [{ ...memory(), similarity: 0.9 }],
    nodes: [],
    systemPrompt,
    tokenCount: Math.ceil(systemPrompt.length / 4),
  };
}

describe("MemoGrafterAgent.invoke memory context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips recall when the session has no topic nodes", async () => {
    const llm = new CapturingLLMAdapter();
    const agent = createAgent({ llm });
    const privateAgent = internals(agent);
    privateAgent.core.enqueueIncrementalIngest = vi.fn<AgentInternals["core"]["enqueueIncrementalIngest"]>().mockResolvedValue(undefined);
    privateAgent.core.store.getSessionNodeCount = vi.fn<AgentInternals["core"]["store"]["getSessionNodeCount"]>()
      .mockResolvedValue(0);
    privateAgent.recall = vi.fn<AgentInternals["recall"]>().mockResolvedValue(retrievalResult("should not inject"));

    await agent.invoke("Suggest a reflective blog intro for my Japan trip.");

    expect(privateAgent.core.store.getSessionNodeCount).toHaveBeenCalledTimes(1);
    expect(privateAgent.recall).not.toHaveBeenCalled();
    expect(llm.calls[0]?.messages).toEqual([
      { role: "user", content: "Suggest a reflective blog intro for my Japan trip." },
    ]);
  });

  it("enqueues only each completed user-assistant pair with its absolute start index", async () => {
    const llm = new CapturingLLMAdapter();
    const agent = createAgent({ llm });
    const privateAgent = internals(agent);
    privateAgent.core.store.getSessionNodeCount = vi.fn<AgentInternals["core"]["store"]["getSessionNodeCount"]>()
      .mockResolvedValue(0);
    privateAgent.core.enqueueIncrementalIngest = vi.fn<AgentInternals["core"]["enqueueIncrementalIngest"]>()
      .mockResolvedValue(undefined);

    await agent.invoke("First turn.");
    await agent.invoke("Second turn.");
    await privateAgent.pendingIngest;

    expect(privateAgent.core.enqueueIncrementalIngest).toHaveBeenNthCalledWith(
      1,
      [
        { role: "user", content: "First turn." },
        { role: "assistant", content: "Response to: First turn." },
      ],
      agent.getSessionId(),
      0,
      { tags: [] },
    );
    expect(privateAgent.core.enqueueIncrementalIngest).toHaveBeenNthCalledWith(
      2,
      [
        { role: "user", content: "Second turn." },
        { role: "assistant", content: "Response to: Second turn." },
      ],
      agent.getSessionId(),
      2,
      { tags: [] },
    );
  });

  it("re-enqueues only the unsent backlog after an enqueue failure", async () => {
    const llm = new CapturingLLMAdapter();
    const agent = createAgent({ llm });
    const privateAgent = internals(agent);
    privateAgent.core.store.getSessionNodeCount = vi.fn<AgentInternals["core"]["store"]["getSessionNodeCount"]>()
      .mockResolvedValue(0);
    privateAgent.core.enqueueIncrementalIngest = vi.fn<AgentInternals["core"]["enqueueIncrementalIngest"]>()
      .mockRejectedValueOnce(new Error("Redis unavailable"))
      .mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await agent.invoke("First turn.");
    await privateAgent.pendingIngest;
    await agent.invoke("Second turn.");
    await privateAgent.pendingIngest;

    expect(privateAgent.core.enqueueIncrementalIngest).toHaveBeenNthCalledWith(
      2,
      [
        { role: "user", content: "First turn." },
        { role: "assistant", content: "Response to: First turn." },
        { role: "user", content: "Second turn." },
        { role: "assistant", content: "Response to: Second turn." },
      ],
      agent.getSessionId(),
      0,
      { tags: [] },
    );
    expect(warn).toHaveBeenCalledWith("MemoGrafter background ingest warning:", expect.any(Error));
  });

  it("injects recalled memories before raw history and the current user message", async () => {
    const llm = new CapturingLLMAdapter();
    const agent = createAgent({
      llm,
      inject: {
        recentWindowSize: 1,
        recallLimit: 3,
        recallMinSimilarity: 0.7,
      },
    });
    const privateAgent = internals(agent);
    privateAgent.core.enqueueIncrementalIngest = vi.fn<AgentInternals["core"]["enqueueIncrementalIngest"]>().mockResolvedValue(undefined);
    privateAgent.core.store.getSessionNodeCount = vi.fn<AgentInternals["core"]["store"]["getSessionNodeCount"]>()
      .mockResolvedValue(2);
    privateAgent.recall = vi.fn<AgentInternals["recall"]>().mockResolvedValue(retrievalResult("Relevant memory"));
    privateAgent.core.combinePinnedContext = vi.fn<AgentInternals["core"]["combinePinnedContext"]>()
      .mockImplementation(async (_sessionId, result) => result);

    await agent.invoke("Earlier turn.");
    llm.calls.length = 0;
    await agent.invoke("Suggest a reflective blog intro for my Japan trip.");

    expect(privateAgent.recall).toHaveBeenLastCalledWith(
      "Suggest a reflective blog intro for my Japan trip.",
      { limit: 3, minSimilarity: 0.7 },
    );
    expect(llm.calls[0]?.messages).toEqual([
      { role: "system", content: "Relevant memory" },
      { role: "assistant", content: "Response to: Earlier turn." },
      { role: "user", content: "Suggest a reflective blog intro for my Japan trip." },
    ]);
  });

  it("continues with raw history when recall fails", async () => {
    const llm = new CapturingLLMAdapter();
    const agent = createAgent({ llm, inject: { recentWindowSize: 2 } });
    const privateAgent = internals(agent);
    privateAgent.core.enqueueIncrementalIngest = vi.fn<AgentInternals["core"]["enqueueIncrementalIngest"]>().mockResolvedValue(undefined);
    privateAgent.core.store.getSessionNodeCount = vi.fn<AgentInternals["core"]["store"]["getSessionNodeCount"]>()
      .mockResolvedValue(1);
    privateAgent.recall = vi.fn<AgentInternals["recall"]>().mockRejectedValue(new Error("embed failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await agent.invoke("Hello.");

    expect(warn).toHaveBeenCalledWith("MemoGrafter recall warning:", expect.any(Error));
    expect(llm.calls[0]?.messages).toEqual([{ role: "user", content: "Hello." }]);
  });
});
