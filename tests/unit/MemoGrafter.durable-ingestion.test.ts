import { describe, expect, it, vi } from "vitest";
import { MemoGrafter } from "../../src/core/MemoGrafter.js";
import type { IngestionRun } from "../../src/ingestion/types.js";
import type { TopicNode } from "../../src/core/types.js";
import { MemoGrafterShutdownError } from "../../src/ingestion/types.js";
import { IngestPipeline } from "../../src/ingestion/conversation/IngestPipeline.js";
import type { GraphStore } from "../../src/store/index.js";

function run(status: IngestionRun["status"] = "accepted"): IngestionRun {
  const now = new Date();
  return { id: "run-1", sessionId: "session-1", kind: "append", startIndex: 0, endIndex: 1, status, attemptCount: 0, createdAt: now, updatedAt: now };
}

describe("MemoGrafter durable ingestion API", () => {
  it("returns a detailed processed receipt while legacy analyze still returns nodes", async () => {
    const memo = new MemoGrafter({ db: { connectionString: "postgres://unused" }, llm: { complete: vi.fn() }, embedder: { embed: vi.fn() } });
    const node = { id: "node-1", messageRange: [0, 1] } as TopicNode;
    const acceptIngestionRun = vi.fn(async () => run());
    (memo as unknown as { storageInitialized: boolean }).storageInitialized = true;
    (memo as unknown as { store: object }).store = { acceptIngestionRun, commitPreparedIngestion: vi.fn(), transitionIngestionRun: vi.fn(), getNodesBySession: vi.fn() };
    (memo as unknown as { ingestPipeline: object }).ingestPipeline = { processIngestionRun: vi.fn(async () => ({ nodes: [node], warnings: [], run: run("completed") })) };

    await expect(memo.analyzeDetailed({ sessionId: "session-1", userMessage: "hello", assistantMessage: "hi", idempotencyKey: "turn-1" })).resolves.toMatchObject({ status: "processed", ingestionRunId: "run-1", messagesPersisted: true, graphProcessed: true, nodes: [node] });
    await expect(memo.analyze({ sessionId: "session-1", userMessage: "again", assistantMessage: "ok" })).resolves.toEqual([node]);
    expect(acceptIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "turn-1", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] }));
  });

  it("requires durable store support for analyzeDetailed", () => {
    const memo = new MemoGrafter({ db: { connectionString: "postgres://unused" }, llm: { complete: vi.fn() }, embedder: { embed: vi.fn() } });
    (memo as unknown as { store: object }).store = {};
    (memo as unknown as { storageInitialized: boolean }).storageInitialized = true;
    expect(() => memo.analyzeDetailed({ sessionId: "s", userMessage: "u", assistantMessage: "a" })).toThrow(expect.objectContaining({ code: "CONFIGURATION_INVALID" }));
  });

  it("keeps reconciliation inspect-only unless repairs are selected", async () => {
    const memo = new MemoGrafter({ db: { connectionString: "postgres://unused" }, llm: { complete: vi.fn() }, embedder: { embed: vi.fn() } });
    const transitionIngestionRun = vi.fn();
    (memo as unknown as { store: object }).store = { inspectIngestionConsistency: vi.fn(async () => [{ code: "accepted-not-started", severity: "warning", sessionId: "s", runId: "r", message: "pending", repairable: true }]), listIngestionRuns: vi.fn(), transitionIngestionRun, getIngestionRun: vi.fn(async () => run()) };
    const report = await memo.reconcileSession("s");
    expect(report.mode).toBe("inspect");
    expect(report.issues).toHaveLength(1);
    expect(transitionIngestionRun).not.toHaveBeenCalled();
  });

  it("reports pending runs during drain shutdown", async () => {
    const memo = new MemoGrafter({ db: { connectionString: "postgres://unused" }, llm: { complete: vi.fn() }, embedder: { embed: vi.fn() } });
    (memo as unknown as { store: object }).store = { countActiveIngestionRuns: vi.fn(async () => 1), close: vi.fn(async () => undefined) };
    const error = await memo.close({ drain: true, timeoutMs: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoGrafterShutdownError);
    expect(error).toMatchObject({ pendingRunCount: 1, jobsMayBeActive: true });
  });

  it("does not commit graph state when provider preparation fails", async () => {
    const commitPreparedIngestion = vi.fn();
    const transitionIngestionRun = vi.fn(async ({ to }: { to: IngestionRun["status"] }) => run(to));
    const store = {
      transitionIngestionRun, commitPreparedIngestion,
      getMessagesBySession: vi.fn(async () => [{ role: "user", content: "u" }, { role: "assistant", content: "a" }]),
      getRecentMessagesBefore: vi.fn(async () => []), getNodesBySession: vi.fn(async () => []),
    } as unknown as GraphStore;
    const pipeline = new IngestPipeline(store, { complete: vi.fn() }, { embed: vi.fn(async () => { throw new Error("provider unavailable"); }) }, { windowSize: 2, topK: 2, mode: "intent", minSegmentMessages: 1 });
    const error = await pipeline.processIngestionRun(run()).catch((caught: unknown) => caught);
    expect(commitPreparedIngestion).not.toHaveBeenCalled();
    expect(transitionIngestionRun).toHaveBeenLastCalledWith(expect.objectContaining({ from: ["running"], to: "retry_pending" }));
    expect(error).toMatchObject({ code: "INGESTION_FAILED", context: expect.objectContaining({ messagesPersisted: true, graphProcessed: false, cursorAdvanced: false, retrySafe: true }) });
  });
});
