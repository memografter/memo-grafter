import { describe, expect, it, vi } from "vitest";
import { MemoGrafter, MemoGrafterError, OpenAILLMAdapter } from "../../src/index.js";
import type { GraphStore } from "../../src/store/index.js";

const baseConfig = {
  db: { connectionString: "postgres://unused" },
  llm: { complete: vi.fn(async () => "ok") },
  embedder: { embed: vi.fn(async () => [0.1, 0.2]) },
};

describe("public diagnostics", () => {
  it("serializes only allowlisted operational context", () => {
    const error = new MemoGrafterError("SDK missing", {
      code: "PROVIDER_SDK_MISSING", operation: "analyze", stage: "topic-extraction",
      context: { sessionId: "2405", messageRange: [0, 1], messagesPersisted: true, cursorAdvanced: false, apiKey: "secret", prompt: "complete prompt" },
      cause: new Error("OPENAI_API_KEY=secret"),
    });
    expect(error.toJSON()).toEqual({
      name: "MemoGrafterError", code: "PROVIDER_SDK_MISSING", operation: "analyze",
      stage: "topic-extraction", retryable: false,
      context: { sessionId: "2405", messageRange: [0, 1], messagesPersisted: true, cursorAdvanced: false },
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(JSON.stringify(error)).not.toContain("complete prompt");
  });

  it("checks adapters without making a provider request", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const adapter = new OpenAILLMAdapter();
      const complete = vi.spyOn(adapter, "complete");
      const readiness = await adapter.validate();
      expect(readiness.ready).toBe(false);
      expect(readiness.checks).toContainEqual(expect.objectContaining({ code: "PROVIDER_CONFIGURATION_MISSING", status: "failed" }));
      expect(complete).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("preserves a provider code and enriches analyze failures", async () => {
    const memo = new MemoGrafter(baseConfig);
    (memo as unknown as { ingestPipeline: { append(): Promise<never> } }).ingestPipeline = {
      append: vi.fn(async () => { throw new MemoGrafterError("SDK missing", { code: "PROVIDER_SDK_MISSING", operation: "ingest", stage: "provider-loading" }); }),
    };
    const error = await memo.analyze({ sessionId: "s1", userMessage: "u", assistantMessage: "a" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoGrafterError);
    expect(error).toMatchObject({ code: "PROVIDER_SDK_MISSING", operation: "analyze" });
  });

  it("classifies storage initialization and keeps its cause", async () => {
    const memo = new MemoGrafter(baseConfig);
    const cause = new Error("connection refused");
    (memo as unknown as { store: Partial<GraphStore> }).store = { initialize: vi.fn(async () => { throw cause; }) };
    const error = await memo.initialize().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED", operation: "storage", cause });
  });
});
