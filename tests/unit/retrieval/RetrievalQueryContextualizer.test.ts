import { describe, expect, it, vi } from "vitest";
import { RetrievalQueryContextualizer, selectRecentMessages } from "../../../src/retrieval/RetrievalQueryContextualizer.js";

describe("RetrievalQueryContextualizer", () => {
  it("rewrites context-dependent queries without answering them", async () => {
    const complete = vi.fn(async () => "Additional healthy North Indian food options");
    const result = await new RetrievalQueryContextualizer({ complete }).run("What else healthy food can I eat?", {
      recentMessages: [
        { role: "user", content: "Suggest healthy North Indian food." },
        { role: "assistant", content: "Try dal, roti, and vegetable sabzi." },
      ],
    });

    expect(result.metadata).toEqual({
      original: "What else healthy food can I eat?",
      retrieval: "Additional healthy North Indian food options",
      contextualized: true,
      contextMessageCount: 2,
      status: "applied",
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("passes standalone queries through without an LLM call", async () => {
    const complete = vi.fn(async () => "unused");
    const result = await new RetrievalQueryContextualizer({ complete }).run("Healthy North Indian breakfast options", {
      recentMessages: [{ role: "user", content: "Earlier context" }],
    });
    expect(result.metadata.status).toBe("not-needed");
    expect(result.metadata.retrieval).toBe("Healthy North Indian breakfast options");
    expect(complete).not.toHaveBeenCalled();
  });

  it("falls back to the original query on invalid output", async () => {
    const result = await new RetrievalQueryContextualizer({ complete: async () => "```bad```" }).run("What about that?", {
      recentMessages: [{ role: "user", content: "Discuss project Atlas." }],
    });
    expect(result.metadata).toMatchObject({ retrieval: "What about that?", status: "fallback", contextualized: false });
    expect(result.warning).toBeInstanceOf(Error);
  });

  it("selects bounded chronological context without an orphan assistant", () => {
    expect(selectRecentMessages([
      { role: "assistant", content: "orphan" },
      { role: "user", content: "topic" },
      { role: "assistant", content: "answer" },
    ], 2, 100)).toEqual([
      { role: "user", content: "topic" },
      { role: "assistant", content: "answer" },
    ]);
  });
});
