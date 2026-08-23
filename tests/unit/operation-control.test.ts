import { describe, expect, it, vi } from "vitest";
import { createOperationControl } from "../../src/utils/operationControl.js";

describe("operation control", () => {
  it("classifies explicit caller cancellation as non-retryable", () => {
    const caller = new AbortController();
    const control = createOperationControl({ signal: caller.signal }, "context");
    caller.abort();
    expect(() => control.throwIfAborted()).toThrowError(expect.objectContaining({ code: "OPERATION_ABORTED", retryable: false }));
    control.dispose();
  });

  it("classifies configured timeout as retryable", () => {
    vi.useFakeTimers();
    const control = createOperationControl({ timeoutMs: 10 }, "context");
    vi.advanceTimersByTime(10);
    expect(() => control.throwIfAborted()).toThrowError(expect.objectContaining({ code: "OPERATION_TIMEOUT", retryable: true }));
    control.dispose();
    vi.useRealTimers();
  });
});
