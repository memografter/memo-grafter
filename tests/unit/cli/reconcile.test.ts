import { describe, expect, it, vi } from "vitest";
import { runReconcile } from "../../../cli/commands/reconcile.js";

describe("memo-grafter reconcile", () => {
  it("inspects without mutating by default", async () => {
    const transitionIngestionRun = vi.fn();
    const close = vi.fn(async () => undefined);
    const issue = { code: "expired-worker-lease", severity: "error" as const, sessionId: "s1", runId: "r1", message: "expired", repairable: true };
    const report = await runReconcile({ db: "postgres://example" }, { createStore: vi.fn(async () => ({ inspectIngestionConsistency: vi.fn(async () => [issue]), getIngestionRun: vi.fn(), transitionIngestionRun, close })) });
    expect(report).toMatchObject({ exitCode: 1, issues: [issue] });
    expect(transitionIngestionRun).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("repairs only explicitly selected actions", async () => {
    const transitionIngestionRun = vi.fn(async () => ({ id: "r1" }));
    const issue = { code: "expired-worker-lease", severity: "error" as const, sessionId: "s1", runId: "r1", message: "expired", repairable: true };
    await runReconcile({ db: "postgres://example", repair: true, actions: ["recover-expired-lease"] }, { createStore: vi.fn(async () => ({ inspectIngestionConsistency: vi.fn(async () => [issue]), getIngestionRun: vi.fn(async () => ({ id: "r1", status: "running", leaseExpiresAt: new Date(0) })), transitionIngestionRun, close: vi.fn(async () => undefined) })) });
    expect(transitionIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ from: ["running"], to: "retry_pending" }));
  });
});
