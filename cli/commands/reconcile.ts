import { resolveConnectionString } from "../utils/config.js";
import { logger } from "../utils/logger.js";
interface IngestionRun { id: string; status: string; leaseExpiresAt?: Date }
interface IngestionTransition { runId: string; from: string[]; to: string; error?: { message: string; retryable: boolean } }
interface ReconciliationIssue { code: string; severity: "warning" | "error"; sessionId: string; runId?: string; message: string; repairable: boolean }

interface ReconcileStore {
  inspectIngestionConsistency(sessionId?: string): Promise<ReconciliationIssue[]>;
  getIngestionRun(runId: string): Promise<IngestionRun | null>;
  transitionIngestionRun(transition: IngestionTransition): Promise<IngestionRun>;
  close(): Promise<void>;
}
export interface ReconcileOptions { cwd?: string; db?: string; sessionId?: string; repair?: boolean; actions?: string[]; json?: boolean }
export interface ReconcileDependencies { createStore(connectionString: string): Promise<ReconcileStore> }

const defaults: ReconcileDependencies = { async createStore(connectionString) { const entry = "memo-grafter/store"; const { PostgresGraphStore } = await import(entry); return new PostgresGraphStore(connectionString) as ReconcileStore; } };

export async function runReconcile(options: ReconcileOptions = {}, dependencies: ReconcileDependencies = defaults): Promise<{ exitCode: 0 | 1; issues: ReconciliationIssue[] }> {
  const connectionString = await resolveConnectionString({ cwd: options.cwd ?? process.cwd(), ...(options.db ? { db: options.db } : {}) });
  const store = await dependencies.createStore(connectionString);
  try {
    const issues = await store.inspectIngestionConsistency(options.sessionId);
    if (options.repair) {
      const actions = new Set(options.actions ?? []);
      for (const issue of issues) {
        if (!issue.runId) continue;
        const run = await store.getIngestionRun(issue.runId);
        if (issue.code === "expired-worker-lease" && actions.has("recover-expired-lease") && run?.status === "running" && run.leaseExpiresAt && run.leaseExpiresAt.getTime() < Date.now()) await store.transitionIngestionRun({ runId: issue.runId, from: ["running"], to: "retry_pending", error: { message: "Worker lease expired.", retryable: true } });
        if (issue.code === "retryable-failure" && actions.has("mark-abandoned") && run) await store.transitionIngestionRun({ runId: issue.runId, from: ["failed", "retry_pending"], to: "abandoned", error: { message: "Marked abandoned by reconciliation.", retryable: false } });
      }
    }
    if (options.json) logger.info(JSON.stringify({ mode: options.repair ? "repair" : "inspect", issues }, null, 2));
    else {
      logger.info(`MemoGrafter Reconcile (${options.repair ? "repair" : "inspect"})`);
      if (!issues.length) logger.info("No ingestion consistency issues found.");
      for (const issue of issues) logger.info(`${issue.severity === "error" ? "✗" : "!"} ${issue.code}: ${issue.message}`);
    }
    return { exitCode: issues.some((issue) => issue.severity === "error") ? 1 : 0, issues };
  } finally { await store.close(); }
}
