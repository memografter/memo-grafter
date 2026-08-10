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
    (memo as unknown as { store: Partial<GraphStore> }).store = { searchMemories };

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
      4,
      0.5,
      { tags: [], tagMode: "all", scope: "session" },
    );
    expect(result).toMatchObject({ facts: [], nodes: [], tokenCount: 0, tokenBudget: 800 });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("validates context retrieval options", () => {
    const { memo } = createMemo();

    expect(() => memo.context({ sessionId: "session-1", query: "query", limit: 0 })).toThrow("limit");
    expect(() => memo.context({ sessionId: "session-1", query: "query", tokenBudget: -1 })).toThrow("tokenBudget");
    expect(() => memo.context({ sessionId: "session-1", query: "query", minSimilarity: 2 })).toThrow("minSimilarity");
  });
});
