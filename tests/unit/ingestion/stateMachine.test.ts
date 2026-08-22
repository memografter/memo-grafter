import { describe, expect, it } from "vitest";
import { assertIngestionTransition } from "../../../src/ingestion/stateMachine.js";

describe("ingestion state machine", () => {
  it.each([
    [["accepted"], "queued"], [["accepted"], "running"], [["queued"], "running"],
    [["running"], "completed"], [["running"], "retry_pending"], [["retry_pending"], "running"],
    [["completed"], "completed_with_warnings"], [["failed"], "abandoned"],
  ] as const)("allows %s -> %s", (from, to) => expect(() => assertIngestionTransition(from, to)).not.toThrow());

  it("rejects an illegal transition with a stable code", () => {
    expect(() => assertIngestionTransition(["completed"], "running")).toThrow(expect.objectContaining({ code: "INGESTION_INVARIANT_VIOLATION" }));
  });
});
