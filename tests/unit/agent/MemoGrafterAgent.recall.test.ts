import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoGrafterAgent } from "../../../src/agents/MemoGrafterAgent.js";
import { RetrieverPipeline } from "../../../src/retrieval/RetrieverPipeline.js";
import type { GraphStore } from "../../../src/store/index.js";
import type {
  EmbedAdapter,
  LLMAdapter,
  MemoryNode,
  MemoGrafterConfig,
  Message,
  RetrievalResult,
  RetrieverConfig,
  TopicNode,
} from "../../../src/core/types.js";

type ScoredMemoryNode = MemoryNode & { similarity: number };
type SearchMemoriesCall = {
  embedding: number[];
  sessionId: string;
  limit: number;
  minSimilarity: number;
  options?: RetrieverConfig;
};
type PipelineThis = {
  config: RetrieverConfig;
  cacheRedis: unknown;
};

class FakeLLMAdapter implements LLMAdapter {
  async complete(messages: Message[]): Promise<string> {
    return `Response to: ${messages.at(-1)?.content ?? ""}`;
  }
}

class FakeEmbedAdapter implements EmbedAdapter {
  constructor(private readonly vector = [0.1, 0.2, 0.3]) {}

  async embed(): Promise<number[]> {
    return this.vector;
  }
}

function makeMemoryNode(
  overrides: Partial<MemoryNode> &
    Pick<MemoryNode, "memoryType" | "subject" | "predicate" | "value" | "quality">,
): MemoryNode {
  const base: MemoryNode = {
    id: "memory-1",
    segmentId: "segment-1",
    topicNodeId: "topic-1",
    agentId: null,
    sessionId: "session-1",
    memoryType: "fact",
    sourceType: "conversation",
    subject: "subject",
    predicate: "predicate",
    value: "value",
    quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
    embedding: [0.1, 0.2],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    agentColor: null,
    fleetId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  return { ...base, ...overrides };
}

function makeScoredMemoryNode(
  overrides: Partial<ScoredMemoryNode> &
    Pick<MemoryNode, "memoryType" | "subject" | "predicate" | "value" | "quality">,
): ScoredMemoryNode {
  return {
    ...makeMemoryNode(overrides),
    similarity: overrides.similarity ?? 0.9,
  };
}

function makeTopicNode(
  overrides: Partial<TopicNode> & Pick<TopicNode, "label" | "summary" | "topicOrder">,
): TopicNode {
  const base: TopicNode = {
    id: "topic-1",
    sessionId: "session-1",
    segmentId: "segment-1",
    label: "Topic",
    summary: "Topic summary.",
    embedding: [0.1, 0.2],
    messageRange: [0, 1],
    topicOrder: 1,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  return { ...base, ...overrides };
}

function createAgent(overrides: Partial<MemoGrafterConfig> = {}): MemoGrafterAgent {
  return new MemoGrafterAgent({
    db: { connectionString: "postgres://user:pass@localhost:5432/memografter_test" },
    llm: new FakeLLMAdapter(),
    embedder: new FakeEmbedAdapter(),
    ...overrides,
  });
}

function patchStore(
  agent: MemoGrafterAgent,
  store: Partial<{
    searchMemories: GraphStore["searchMemories"];
    getTopicNode: GraphStore["getTopicNode"];
    getNodesBySession: GraphStore["getNodesBySession"];
    getSegmentsBySession: GraphStore["getSegmentsBySession"];
    setSessionTags: GraphStore["setSessionTags"];
  }>,
): void {
  const core = (agent as unknown as { core: { store: GraphStore } }).core;
  Object.assign(core.store, store);
  core.store.searchTopicCandidates = async () => [];
  if (store.searchMemories) {
    const searchMemories = store.searchMemories;
    core.store.searchMemoryCandidates = (embedding, sessionId, limit, options) =>
      searchMemories(embedding, sessionId, limit, -1, options);
  }
}

let originalRun: typeof RetrieverPipeline.prototype.run;

beforeEach(() => {
  originalRun = RetrieverPipeline.prototype.run;
});

afterEach(() => {
  RetrieverPipeline.prototype.run = originalRun;
});

describe("MemoGrafterAgent.recall", () => {
  it("returns pipeline result directly", async () => {
    const agent = createAgent();
    const result: RetrievalResult = {
      facts: [
        makeScoredMemoryNode({
          memoryType: "fact",
          subject: "deployment",
          predicate: "uses",
          value: "blue-green rollout",
          quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        }),
      ],
      nodes: [
        makeTopicNode({
          label: "Deployment",
          summary: "Deployment summary.",
          topicOrder: 1,
        }),
      ],
      systemPrompt: "retrieved memory",
      tokenCount: 12,
    };
    RetrieverPipeline.prototype.run = async () => result;

    await expect(agent.recall("deployment")).resolves.toBe(result);
    expect(Object.keys(await agent.recall("deployment"))).toEqual(Object.keys(result));
  });

  it("forwards options to RetrieverPipeline", async () => {
    const agent = createAgent();
    const calls: SearchMemoriesCall[] = [];
    patchStore(agent, {
      searchMemories: async (embedding, sessionId, limit, minSimilarity, options) => {
        calls.push({ embedding, sessionId, limit, minSimilarity, options });
        return [];
      },
    });

    await agent.recall("deployment", {
      limit: 5,
      minSimilarity: 0.7,
      tokenBudget: 800,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      embedding: [0.1, 0.2, 0.3],
      sessionId: agent.getSessionId(),
      limit: 40,
      minSimilarity: -1,
      options: {
        scope: "session",
        tagMode: "all",
        tags: [],
      },
    });
  });

  it("forwards tag filters through recall", async () => {
    const agent = createAgent();
    const calls: SearchMemoriesCall[] = [];
    patchStore(agent, {
      searchMemories: async (embedding, sessionId, limit, minSimilarity, options) => {
        calls.push({ embedding, sessionId, limit, minSimilarity, options });
        return [];
      },
    });

    await agent.recall("deployment", {
      tags: [" Project:Memo-Grafter ", "planning"],
      tagMode: "any",
      scope: "tagged",
    });

    expect(calls[0]?.options).toEqual({
      tags: ["planning", "project:memo-grafter"],
      tagMode: "any",
      scope: "tagged",
    });
  });

  it("threads agent cache config into RetrieverPipeline", async () => {
    const agent = createAgent();
    const fakeRedis = { get: async () => null };
    (agent as unknown as { cacheConfig: MemoGrafterConfig["cache"] }).cacheConfig = {
      connectionString: "redis://localhost:6379",
      ttlSeconds: 70,
    };
    (agent as unknown as { core: { recallCache: unknown } }).core.recallCache = fakeRedis;
    let observedConfig: RetrieverConfig | undefined;
    let observedCacheRedis: unknown;
    RetrieverPipeline.prototype.run = async function run(this: PipelineThis): Promise<RetrievalResult> {
      observedConfig = this.config;
      observedCacheRedis = this.cacheRedis;
      return {
        facts: [],
        nodes: [],
        systemPrompt: "empty",
        tokenCount: 0,
      };
    };

    await agent.recall("deployment", { limit: 4 });

    expect(observedConfig).toEqual({
      limit: 4,
      cache: { ttlSeconds: 70 },
    });
    expect(observedCacheRedis).toBe(fakeRedis);
  });

  it("lets per-call cache options override agent cache defaults", async () => {
    const agent = createAgent();
    (agent as unknown as { cacheConfig: MemoGrafterConfig["cache"] }).cacheConfig = {
      connectionString: "redis://localhost:6379",
      ttlSeconds: 70,
    };
    let observedConfig: RetrieverConfig | undefined;
    RetrieverPipeline.prototype.run = async function run(this: PipelineThis): Promise<RetrievalResult> {
      observedConfig = this.config;
      return {
        facts: [],
        nodes: [],
        systemPrompt: "empty",
        tokenCount: 0,
      };
    };

    await agent.recall("deployment", {
      cache: { ttlSeconds: 110 },
    });

    expect(observedConfig).toEqual({
      cache: { ttlSeconds: 110 },
    });
  });

  it("applies default options when none are provided", async () => {
    const agent = createAgent();
    const calls: SearchMemoriesCall[] = [];
    patchStore(agent, {
      searchMemories: async (embedding, sessionId, limit, minSimilarity, options) => {
        calls.push({ embedding, sessionId, limit, minSimilarity, options });
        return [];
      },
    });

    await agent.recall("deployment");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      limit: 40,
      minSimilarity: -1,
    });
  });

  it("stores normalized session tags and applies them to active node reads", async () => {
    const agent = createAgent();
    const setCalls: Array<{ sessionId: string; tags: string[] }> = [];
    const nodeCalls: Array<{ sessionId: string; options: unknown }> = [];
    patchStore(agent, {
      setSessionTags: async (sessionId, tags) => {
        setCalls.push({ sessionId, tags });
      },
      getNodesBySession: async (sessionId, options) => {
        nodeCalls.push({ sessionId, options });
        return [];
      },
      getSegmentsBySession: async () => [],
    });

    await agent.setSessionTags([" Project:Memo-Grafter ", "planning", "PLANNING"]);
    await agent.getActiveNodes({ tags: ["planning"], tagMode: "all" });

    expect(agent.getSessionTags()).toEqual(["planning", "project:memo-grafter"]);
    expect(setCalls).toEqual([{
      sessionId: agent.getSessionId(),
      tags: ["planning", "project:memo-grafter"],
    }]);
    expect(nodeCalls).toEqual([{
      sessionId: agent.getSessionId(),
      options: { tags: ["planning"], tagMode: "all" },
    }]);
  });

  it("returns an empty result when the pipeline returns no facts", async () => {
    const agent = createAgent();
    const result: RetrievalResult = {
      facts: [],
      nodes: [],
      systemPrompt: "empty retrieval",
      tokenCount: 0,
    };
    RetrieverPipeline.prototype.run = async () => result;

    await expect(agent.recall("nothing")).resolves.toMatchObject({
      facts: [],
      nodes: [],
      tokenCount: 0,
    });
  });

  it("propagates pipeline errors without changing the message", async () => {
    const agent = createAgent();
    RetrieverPipeline.prototype.run = async () => {
      throw new Error("embed failed");
    };

    await expect(agent.recall("deployment")).rejects.toThrow("embed failed");
  });
});
