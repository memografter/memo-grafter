import { describe, expect, it, vi } from "vitest";
import { PipelineStudioPreviewService } from "../../../src/studio/StudioPreviewService.js";
import type { EmbedAdapter, LLMAdapter, Message } from "../../../src/core/types.js";
import type { GraphStore } from "../../../src/store/index.js";

describe("PipelineStudioPreviewService completion", () => {
  it("does not call the LLM during preview and completes the immutable stored request", async () => {
    const complete = vi.fn(async (_messages: Message[], _system?: string) => "model answer");
    const llm: LLMAdapter = { complete };
    const embedder: EmbedAdapter = { embed: vi.fn(async () => [0.1]) };
    const store = {
      getMessagesBySession: vi.fn(async () => [{ role: "assistant" as const, content: "persisted answer" }]),
      getSessionNodeCount: vi.fn(async () => 0),
    } as unknown as GraphStore;
    const service = new PipelineStudioPreviewService(store, embedder, { llm, systemPrompt: "base" });

    const preview = await service.run({ sessionId: "session-1", query: "next question" });
    expect(complete).not.toHaveBeenCalled();
    expect(preview.historySource).toBe("database-backed-preview");
    expect(preview.plainText).toContain("=== FRAMEWORK SYSTEM ===\nbase");

    const result = await service.complete(preview.planId, "session-1");
    expect(result.response).toBe("model answer");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(preview.request.messages, preview.request.system);
  });

  it("rejects a plan from another session", async () => {
    const store = {
      getMessagesBySession: vi.fn(async () => []),
      getSessionNodeCount: vi.fn(async () => 0),
    } as unknown as GraphStore;
    const service = new PipelineStudioPreviewService(store, { embed: async () => [0.1] }, { llm: { complete: async () => "answer" } });
    const preview = await service.run({ sessionId: "session-1", query: "hello" });
    await expect(service.complete(preview.planId, "session-2")).rejects.toThrow("not found or has expired");
  });
});
