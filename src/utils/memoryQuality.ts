import type { MemoryQuality } from "../core/types.js";

export const QUALITY_DIMENSIONS = ["explicitness", "sourceReliability", "stability", "salience"] as const;
export type QualityDimension = typeof QUALITY_DIMENSIONS[number];
export const DEFAULT_MEMORY_QUALITY: Readonly<MemoryQuality> = Object.freeze({
  explicitness: 0.5, sourceReliability: 0.5, stability: 0.5, salience: 0.5,
});

export function normalizeMemoryQualityWithDefaults(value: unknown): { quality: MemoryQuality; defaulted: QualityDimension[] } {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const quality = { ...DEFAULT_MEMORY_QUALITY };
  const defaulted: QualityDimension[] = [];
  for (const key of QUALITY_DIMENSIONS) {
    const score = record[key];
    if (typeof score === "number" && Number.isFinite(score)) quality[key] = Math.max(0, Math.min(1, score));
    else defaulted.push(key);
  }
  return { quality, defaulted };
}

export function normalizeMemoryQuality(value: unknown): MemoryQuality {
  return normalizeMemoryQualityWithDefaults(value).quality;
}

/** Version 1: retention priority, never query relevance or a probability of truth. */
export function computePersistenceScore(value: unknown): number {
  const q = normalizeMemoryQuality(value);
  return (q.explicitness + q.sourceReliability + 2 * q.stability + 2 * q.salience) / 6;
}

/** Evidence strength is used only for equal-relevance ties and evidence selection. */
export function compareQualityEvidence(left: unknown, right: unknown): number {
  const a = normalizeMemoryQuality(left), b = normalizeMemoryQuality(right);
  return Math.min(a.explicitness, a.sourceReliability) - Math.min(b.explicitness, b.sourceReliability)
    || a.sourceReliability - b.sourceReliability || a.explicitness - b.explicitness;
}

/** Keep the winning evidence pair together; repetition does not establish durability/usefulness. */
export function reinforceMemoryQuality(existing: unknown, incoming: unknown): MemoryQuality {
  const a = normalizeMemoryQuality(existing), b = normalizeMemoryQuality(incoming);
  return compareQualityEvidence(b, a) > 0
    ? { ...a, explicitness: b.explicitness, sourceReliability: b.sourceReliability } : a;
}

export interface QualityAdmissionPolicy {
  /** Observe by default until evaluated on the application's data. */
  mode?: "observe" | "enforce";
  minExplicitness?: number;
  minSourceReliability?: number;
}

export function assessQualityAdmission(value: unknown, defaulted: readonly string[] = [], policy: QualityAdmissionPolicy = {}) {
  const normalized = normalizeMemoryQualityWithDefaults(value);
  const q = normalized.quality;
  const unknown = new Set([...defaulted, ...normalized.defaulted]);
  const threshold = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.3;
  const reason = !unknown.has("explicitness") && q.explicitness < threshold(policy.minExplicitness)
    ? "low-explicitness"
    : !unknown.has("sourceReliability") && q.sourceReliability < threshold(policy.minSourceReliability)
      ? "low-source-reliability" : "accepted";
  return { reason, accepted: policy.mode !== "enforce" || reason === "accepted" };
}
