import type { MemoryNode, MemoryNodeInsert } from "../../core/types.js";

export const MEMORY_CANONICALIZATION_VERSION = 1;
const CANONICAL_KEY_SEPARATOR = "\u001f";

export type MemoryClassification = "new" | "reinforcement" | "update" | "conflict";

export interface CanonicalMemory {
  subject: string;
  predicate: string;
  value: string;
  factKey: string;
  valueKey: string;
  explicitUpdate: boolean;
  version: number;
}

const UPDATE_CUE = /\b(?:actually|changed\s+to|correct(?:ion|ed)?|instead|now|replace(?:d|s)?|updated\s+to)\b/gi;
const PUNCTUATION = /[^\p{L}\p{N}\s._:/@+-]/gu;

function normalizePart(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[_-]+/g, " ").replace(PUNCTUATION, " ").replace(/\s+/g, " ").trim()
    .replace(/\bpostgres\b/g, "postgresql")
    .replace(/\bjs\b/g, "javascript")
    .replace(/\bts\b/g, "typescript")
    .replace(/[.!?,;:]+$/g, "");
}

function normalizePredicate(value: string): string {
  return normalizePart(value)
    .replace(/\b(?:is|are)\s+preferred\b/g, "prefers")
    .replace(/\b(?:preference\s+is|prefers?)\b/g, "prefers")
    .replace(/\b(?:uses?|using)\b/g, "uses");
}

function normalizeSubject(value: string): string {
  return normalizePart(value).replace(/^(?:the\s+)?(?:current\s+)?user$/, "user");
}

function normalizeValue(value: string): { value: string; explicitUpdate: boolean } {
  const explicitUpdate = UPDATE_CUE.test(value);
  UPDATE_CUE.lastIndex = 0;
  return { value: normalizePart(value.replace(UPDATE_CUE, " ")), explicitUpdate };
}

export function canonicalizeMemory(memory: Pick<MemoryNodeInsert, "sessionId" | "subject" | "predicate" | "value" | "provenance">): CanonicalMemory {
  const { subject, predicate } = canonicalizeFactParts(memory.subject, memory.predicate);
  const normalizedValue = normalizeValue(memory.value);
  const speaker = memory.provenance?.speaker ?? "legacy-unknown";
  const factKey = [memory.sessionId, speaker, subject, predicate].join(CANONICAL_KEY_SEPARATOR);
  return {
    subject,
    predicate,
    value: normalizedValue.value,
    factKey,
    valueKey: [factKey, normalizedValue.value].join(CANONICAL_KEY_SEPARATOR),
    explicitUpdate: normalizedValue.explicitUpdate,
    version: MEMORY_CANONICALIZATION_VERSION,
  };
}

export function canonicalizeFactParts(subject: string, predicate: string): { subject: string; predicate: string } {
  return { subject: normalizeSubject(subject), predicate: normalizePredicate(predicate) };
}

export function classifyCanonicalMemory(incoming: CanonicalMemory, active: Array<Pick<MemoryNode, "canonicalValueKey">>): MemoryClassification {
  if (active.some((memory) => memory.canonicalValueKey === incoming.valueKey)) return "reinforcement";
  if (active.length === 0) return "new";
  return incoming.explicitUpdate ? "update" : "conflict";
}
