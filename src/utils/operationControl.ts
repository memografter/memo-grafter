import type { MemoGrafterOperationOptions } from "../core/types.js";
import { MemoGrafterError, type MemoGrafterOperation, type MemoGrafterStage } from "../diagnostics.js";

const timeoutReason = Symbol("memo-grafter-timeout");

export interface OperationControl {
  signal: AbortSignal;
  throwIfAborted(stage?: MemoGrafterStage): void;
  dispose(): void;
}

export function createOperationControl(
  options: MemoGrafterOperationOptions | undefined,
  operation: MemoGrafterOperation,
  defaultStage?: MemoGrafterStage,
): OperationControl {
  const controller = new AbortController();
  const callerSignal = options?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new MemoGrafterError("timeoutMs must be a non-negative finite number.", {
        code: "INPUT_INVALID", operation, retryable: false, context: { field: "timeoutMs" },
      });
    }
    timer = setTimeout(() => controller.abort(timeoutReason), options.timeoutMs);
  }

  return {
    signal: controller.signal,
    throwIfAborted(stage = defaultStage) {
      if (!controller.signal.aborted) return;
      const timedOut = controller.signal.reason === timeoutReason;
      throw new MemoGrafterError(timedOut ? "MemoGrafter operation timed out." : "MemoGrafter operation was aborted.", {
        code: timedOut ? "OPERATION_TIMEOUT" : "OPERATION_ABORTED",
        operation,
        ...(stage ? { stage } : {}),
        retryable: timedOut,
      });
    },
    dispose() {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}
