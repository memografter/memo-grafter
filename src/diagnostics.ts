export type MemoGrafterOperation =
  | "create" | "readiness" | "analyze" | "context" | "invoke" | "ingest" | "storage";

export type MemoGrafterStage =
  | "configuration" | "provider-loading" | "provider-request" | "topic-extraction"
  | "embedding" | "message-persistence" | "graph-processing" | "cursor-update" | "storage-initialization";

export type MemoGrafterErrorCode =
  | "CONFIGURATION_INVALID" | "INPUT_INVALID" | "RUNTIME_UNSUPPORTED" | "ADAPTER_INVALID"
  | "PROVIDER_SDK_MISSING" | "PROVIDER_CONFIGURATION_MISSING" | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_RESPONSE_INVALID" | "EXTRACTION_RESPONSE_INVALID" | "EMBEDDING_RESPONSE_INVALID"
  | "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED" | "INGESTION_FAILED" | "CONTEXT_FAILED";

export type MemoGrafterWarningCode =
  | "BEST_EFFORT_OPERATION_FAILED" | "CACHE_UNAVAILABLE" | "EXTRACTION_ITEM_SKIPPED"
  | "EXTRACTION_FALLBACK_USED" | "BACKGROUND_INGEST_FAILED";

export interface IngestionFailureContext {
  sessionId: string;
  messageRange?: [number, number];
  messagesPersisted?: boolean;
  graphProcessed?: boolean;
  cursorAdvanced?: boolean;
  retrySafe?: boolean;
  jobId?: string;
}

export type MemoGrafterErrorContext = IngestionFailureContext | Readonly<Record<string, unknown>>;

export interface MemoGrafterWarning {
  code: MemoGrafterWarningCode;
  operation: MemoGrafterOperation;
  stage?: MemoGrafterStage;
  context?: MemoGrafterErrorContext;
  cause?: unknown;
}

export interface MemoGrafterLogger {
  warn?(warning: MemoGrafterWarning): void;
}

export interface MemoGrafterDiagnostics {
  onWarning?: (warning: MemoGrafterWarning) => void;
  logger?: MemoGrafterLogger;
}

export interface ReadinessCheck {
  id: string;
  status: "passed" | "warning" | "failed";
  code?: MemoGrafterErrorCode;
  message: string;
  help?: string;
}

export interface ReadinessResult { ready: boolean; checks: ReadinessCheck[] }
export type AdapterReadiness = ReadinessResult;

const safeContextKeys = new Set([
  "sessionId", "messageRange", "messagesPersisted", "graphProcessed", "cursorAdvanced", "retrySafe", "jobId",
  "field", "expectedDimensions", "actualDimensions", "adapter", "provider", "checkId",
]);

export class MemoGrafterError extends Error {
  readonly code: MemoGrafterErrorCode;
  readonly operation: MemoGrafterOperation;
  readonly stage?: MemoGrafterStage;
  readonly retryable: boolean;
  readonly context?: MemoGrafterErrorContext;

  constructor(message: string, options: {
    code: MemoGrafterErrorCode;
    operation: MemoGrafterOperation;
    stage?: MemoGrafterStage;
    retryable?: boolean;
    context?: MemoGrafterErrorContext;
    cause?: unknown;
  }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MemoGrafterError";
    this.code = options.code;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
    if (options.stage !== undefined) this.stage = options.stage;
    if (options.context !== undefined) this.context = { ...options.context };
  }

  toJSON(): Record<string, unknown> {
    const context = sanitizeContext(this.context);
    return {
      name: this.name, code: this.code, operation: this.operation,
      ...(this.stage ? { stage: this.stage } : {}), retryable: this.retryable,
      ...(context ? { context } : {}),
    };
  }
}

export function isMemoGrafterError(error: unknown): error is MemoGrafterError {
  return error instanceof MemoGrafterError;
}

export function enrichMemoGrafterError(
  error: MemoGrafterError,
  additions: { operation?: MemoGrafterOperation; stage?: MemoGrafterStage; context?: MemoGrafterErrorContext },
): MemoGrafterError {
  return new MemoGrafterError(error.message, {
    code: error.code,
    operation: additions.operation ?? error.operation,
    ...((additions.stage ?? error.stage) !== undefined ? { stage: additions.stage ?? error.stage } : {}),
    retryable: error.retryable,
    context: { ...(error.context ?? {}), ...(additions.context ?? {}) },
    cause: error.cause,
  });
}

export function emitWarning(diagnostics: MemoGrafterDiagnostics | undefined, warning: MemoGrafterWarning): void {
  try { diagnostics?.onWarning?.(warning); } catch { /* diagnostics cannot affect behavior */ }
  try { diagnostics?.logger?.warn?.(warning); } catch { /* diagnostics cannot affect behavior */ }
}

function sanitizeContext(context: MemoGrafterErrorContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!safeContextKeys.has(key)) continue;
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" || value === null) safe[key] = value;
    else if (key === "messageRange" && Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) safe[key] = [...value];
  }
  return Object.keys(safe).length ? safe : undefined;
}
