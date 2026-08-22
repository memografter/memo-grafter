import { MemoGrafterError } from "../diagnostics.js";
import type { IngestionRunStatus } from "./types.js";

const transitions: Readonly<Record<IngestionRunStatus, readonly IngestionRunStatus[]>> = {
  accepted: ["queued", "running", "retry_pending", "cancelled"], queued: ["running", "cancelled", "abandoned"],
  running: ["completed", "completed_with_warnings", "retry_pending", "failed", "abandoned"],
  retry_pending: ["queued", "running", "failed", "abandoned"], completed: ["completed_with_warnings"],
  completed_with_warnings: [], failed: ["retry_pending", "abandoned"], cancelled: [], abandoned: [],
};

export function assertIngestionTransition(from: readonly IngestionRunStatus[], to: IngestionRunStatus): void {
  if (!from.length || from.some((status) => !transitions[status].includes(to))) {
    throw new MemoGrafterError(`Illegal ingestion transition from ${from.join("|") || "unknown"} to ${to}.`, { code: "INGESTION_INVARIANT_VIOLATION", operation: "ingest", retryable: false });
  }
}
