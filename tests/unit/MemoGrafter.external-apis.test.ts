import { describe, expect, it, vi } from "vitest";
import { MemoGrafter } from "../../src/core/MemoGrafter.js";
import type { GraphStore, TopicNode } from "../../src/index.js";

function createMemo() {
  const llm = { complete: vi.fn(async () => "unused") };
  const embedder = { embed: vi.fn(async () => [0.1, 0.2]) };
  const memo = new MemoGrafter({
    db: { connectionString: "postgres://example" },
    llm,
    embedder,
  });
  return { memo, llm, embedder };
}

describe("MemoGrafter external application APIs", () => {
  it("analyzes one completed exchange through the append ingestion path", async () => {
    const { memo } = createMemo();
    const nodes = [{ id: "topic-1" }] as TopicNode[];
    const append = vi.fn(async () => nodes);
    (memo as unknown as { ingestPipeline: { append: typeof append } }).ingestPipeline = { append };

    await expect(memo.analyze({
      sessionId: "session-1",
      userMessage: "I am visiting Japan.",
      assistantMessage: "Which cities interest you?",
      tags: ["travel"],
    })).resolves.toBe(nodes);

    expect(append).toHaveBeenCalledWith([
      { role: "user", content: "I am visiting Japan." },
      { role: "assistant", content: "Which cities interest you?" },
    ], "session-1", { tags: ["travel"] });
  });

  it("rejects invalid exchanges before ingestion", () => {
    const { memo } = createMemo();

    expect(() => memo.analyze({
      sessionId: " ",
      userMessage: "hello",
      assistantMessage: "hi",
    })).toThrow("sessionId");
    expect(() => memo.analyze({
      sessionId: "session-1",
      userMessage: "hello",
      assistantMessage: " ",
    })).toThrow("assistantMessage");
  });

  it("retrieves fresh context without an LLM completion or cache", async () => {
    const { memo, llm, embedder } = createMemo();
    const searchMemories = vi.fn(async () => []);
    (memo as unknown as { store: Partial<GraphStore> }).store = {
      searchMemories,
      getPinnedTopics: vi.fn(async () => []),
      getMemoriesBySession: vi.fn(async () => []),
    };

    const result = await memo.context({
      sessionId: "session-1",
      query: "Where should I stay?",
      limit: 4,
      minSimilarity: 0.5,
      tokenBudget: 800,
      cache: { ttlSeconds: 120 },
    });

    expect(embedder.embed).toHaveBeenCalledWith("Where should I stay?");
    expect(searchMemories).toHaveBeenCalledWith(
      [0.1, 0.2],
      "session-1",
      40,
      -1,
      { tags: [], tagMode: "all", scope: "session" },
    );
    expect(result).toMatchObject({ facts: [], nodes: [], tokenCount: 0, tokenBudget: 800 });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("uses explicit recent messages to contextualize an external retrieval query", async () => {
    const { memo, llm, embedder } = createMemo();
    llm.complete = vi.fn(async () => "Additional healthy North Indian food options");
    (memo as unknown as { store: Partial<GraphStore> }).store = {
      searchMemories: vi.fn(async () => []),
      getPinnedTopics: vi.fn(async () => []),
      getMemoriesBySession: vi.fn(async () => []),
    };

    const result = await memo.context({
      sessionId: "session-1",
      query: "What else can I eat?",
      contextualization: {
        recentMessages: [
          { role: "user", content: "I want healthy North Indian food." },
          { role: "assistant", content: "Try dal and vegetable sabzi." },
        ],
      },
    });

    expect(embedder.embed).toHaveBeenCalledWith("Additional healthy North Indian food options");
    expect(result.query).toMatchObject({ status: "applied", contextualized: true, contextMessageCount: 2 });
  });

  it("places multiple pinned topics before recall context in pin order", async () => {
    const { memo } = createMemo();
    const topics = ["Planning", "Deployment"].map((label, index) => ({
      id: `topic-${index + 1}`, sessionId: "session-1", segmentId: `segment-${index + 1}`,
      label, summary: `${label} summary`, embedding: [], messageRange: [index, index],
      topicOrder: index, driftScore: 0, agentColor: null, fleetId: null, agentId: null,
      pinned: true, pinnedAt: new Date(index), createdAt: new Date(index),
    })) as TopicNode[];
    (memo as unknown as { store: Partial<GraphStore> }).store = {
      searchMemories: vi.fn(async () => []),
      getPinnedTopics: vi.fn(async () => topics),
      getMemoriesBySession: vi.fn(async () => []),
    };

    const result = await memo.context({ sessionId: "session-1", query: "unrelated query" });

    expect(result.pinnedNodes?.map((topic) => topic.label)).toEqual(["Planning", "Deployment"]);
    expect(result.systemPrompt.indexOf("## Planning")).toBeLessThan(result.systemPrompt.indexOf("## Deployment"));
    expect(result.facts).toEqual([]);
  });

  it("validates context retrieval options", () => {
    const { memo } = createMemo();

    expect(() => memo.context({ sessionId: "session-1", query: "query", limit: 0 })).toThrow("limit");
    expect(() => memo.context({ sessionId: "session-1", query: "query", tokenBudget: -1 })).toThrow("tokenBudget");
    expect(() => memo.context({ sessionId: "session-1", query: "query", minSimilarity: 2 })).toThrow("minSimilarity");
    expect(() => memo.context({ sessionId: "session-1", query: "query", contextualization: { maxMessages: 0 } })).toThrow("maxMessages");
  });
});
