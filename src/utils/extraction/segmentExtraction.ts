import type {
  ExtractedMemory,
  MemoryType,
  SegmentExtractionResult,
} from "../../core/types.js";
import { MemoGrafterError, emitWarning, type MemoGrafterDiagnostics } from "../../diagnostics.js";

export function parseSegmentExtraction(raw: string, diagnostics?: MemoGrafterDiagnostics): SegmentExtractionResult {
  try {
    const parsedValue: unknown = JSON.parse(raw.trim());
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) throw new Error("Expected an object.");
    const parsed = parsedValue as Record<string, unknown>;
    if (!stringValue(parsed.label) || !stringValue(parsed.user_intent) || !stringValue(parsed.outcome)) {
      throw new Error("Required extraction fields are missing.");
    }
    return {
      label: stringValue(parsed.label),
      userIntent: stringValue(parsed.user_intent),
      outcome: stringValue(parsed.outcome),
      open: nullableStringValue(parsed.open),
      memories: parseExtractedMemories(parsed.memories),
    };
  } catch (error) {
    if (raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
      throw new MemoGrafterError("The extraction response did not match the required schema.", { code: "EXTRACTION_RESPONSE_INVALID", operation: "analyze", stage: "topic-extraction", retryable: true, cause: error });
    }
    emitWarning(diagnostics, { code: "EXTRACTION_FALLBACK_USED", operation: "analyze", stage: "topic-extraction", cause: error });
    console.warn("SegmentProcessor extraction JSON parse failed; falling back to legacy parsing.", error);
  }

  const label = raw.match(/^LABEL:\s*(.+)$/im)?.[1]?.trim() ?? "Unknown";
  const userIntent = raw.match(/^USER_INTENT:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const outcome = raw.match(/^OUTCOME:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const openText = raw.match(/^OPEN:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const open = openText && openText.toLowerCase() !== "none" ? openText : null;

  return {
    label,
    userIntent,
    outcome,
    open,
    memories: [],
  };
}

export function buildSegmentSummary(extracted: SegmentExtractionResult): string {
  const parts = [
    extracted.userIntent && `User wanted: ${extracted.userIntent}`,
    extracted.outcome && `Outcome: ${extracted.outcome}`,
    extracted.open && `Still open: ${extracted.open}`,
  ].filter(Boolean);

  return parts.join(" ");
}

export function formatMemoryEmbeddingText(memory: ExtractedMemory): string {
  return `${memory.memoryType}: ${memory.subject} ${memory.predicate}: ${memory.value}`;
}

function parseExtractedMemories(value: unknown): ExtractedMemory[] {
  if (!Array.isArray(value)) return [];

  const validTypes = new Set<MemoryType>(["fact", "insight", "question", "task", "reference"]);
  const memories: ExtractedMemory[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      console.warn("SegmentProcessor skipped invalid memory item:", item);
      continue;
    }

    const record = item as Record<string, unknown>;
    const memoryType = stringValue(record.memory_type) as MemoryType;
    const subject = stringValue(record.subject);
    const predicate = stringValue(record.predicate);
    const memoryValue = stringValue(record.value);

    if (!validTypes.has(memoryType) || !subject || !predicate || !memoryValue) {
      console.warn("SegmentProcessor skipped incomplete memory item:", item);
      continue;
    }

    memories.push({
      memoryType,
      subject,
      predicate,
      value: memoryValue,
      confidence: numberValue(record.confidence, 1),
    });
  }

  return memories;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  const text = stringValue(value);
  if (!text || text.toLowerCase() === "none") return null;
  return text;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
