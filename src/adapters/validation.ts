import { MemoGrafterError, type MemoGrafterOperation } from "../diagnostics.js";

export function validateCompletion(value: unknown, operation: MemoGrafterOperation = "ingest"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoGrafterError("The provider returned an empty or non-string completion.", {
      code: "PROVIDER_RESPONSE_INVALID", operation, stage: "provider-request", retryable: true,
    });
  }
  return value;
}

export function validateEmbedding(value: unknown, expectedDimensions?: number, operation: MemoGrafterOperation = "ingest"): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new MemoGrafterError("The provider returned a missing, empty, or non-finite embedding.", {
      code: "EMBEDDING_RESPONSE_INVALID", operation, stage: "embedding", retryable: true,
    });
  }
  if (expectedDimensions !== undefined && value.length !== expectedDimensions) {
    throw new MemoGrafterError("The provider returned an embedding with incorrect dimensions.", {
      code: "EMBEDDING_RESPONSE_INVALID", operation, stage: "embedding", retryable: false,
      context: { expectedDimensions, actualDimensions: value.length },
    });
  }
  return value as number[];
}
