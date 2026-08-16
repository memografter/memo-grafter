import { describe, expect, it } from "vitest";
import { buildInvocationPlan } from "../../../src/invocation/InvocationPlanner.js";

describe("buildInvocationPlan", () => {
  it("places recalled memory before the MemoGrafterAgent conversation window", async () => {
    const plan = await buildInvocationPlan("session-1", "current query", {
      profile: "memo-grafter-agent", historySource: "process-local",
      history: [{ role: "user", content: "old" }, { role: "assistant", content: "recent" }],
      recentWindowSize: 1, baseSystemPrompt: "base",
      buildMemoryContext: async () => ({ placement: "message", retrieval: { status: "matched", strategy: "recall", topics: [], memories: [] }, memoryContext: { content: "memory", tokenCount: 2 } }),
    });
    expect(plan.request).toEqual({ system: "base", messages: [
      { role: "system", content: "memory" }, { role: "assistant", content: "recent" }, { role: "user", content: "current query" },
    ] });
    expect(plan.plainText).toContain("=== FRAMEWORK SYSTEM ===\nbase");
    expect(plan.plainText).toContain("=== MESSAGE 1 · SYSTEM ===\nmemory");
    expect(plan.plainText).toContain("=== MESSAGE 3 · USER ===\ncurrent query");
  });

  it("labels an empty framework system without flattening message roles", async () => {
    const plan = await buildInvocationPlan("session-1", "hello", {
      profile: "memo-grafter-agent", historySource: "process-local", history: [],
      buildMemoryContext: async () => ({ placement: "message", retrieval: { status: "no-match", strategy: "recall", topics: [], memories: [] }, memoryContext: { content: null, tokenCount: 0 } }),
    });
    expect(plan.plainText).toBe("=== FRAMEWORK SYSTEM ===\n(empty)\n\n=== MESSAGE 1 · USER ===\nhello");
  });

  it("places Fleet context in system without duplicating the current query", async () => {
    const plan = await buildInvocationPlan("worker-1", "question", {
      profile: "fleet-worker", historySource: "database-backed-preview", queryAlreadyInHistory: true,
      history: [{ role: "user", content: "earlier" }, { role: "user", content: "question" }],
      buildMemoryContext: async () => ({ placement: "system", retrieval: { status: "matched", strategy: "fleet-combined", topics: [], memories: [] }, memoryContext: { content: "local and shared memory", tokenCount: 5 } }),
    });
    expect(plan.request).toEqual({ system: "local and shared memory", messages: [{ role: "user", content: "earlier" }, { role: "user", content: "question" }] });
    expect(plan.historySource).toBe("database-backed-preview");
  });
});
