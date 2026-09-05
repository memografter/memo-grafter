import { computePersistenceScore, normalizeMemoryQuality } from "../utils/memoryQuality.js";
import type { MemoryNode } from "../core/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DecayScoreOptions {
  now: Date;
  halfLifeDays: number;
}

export function computeMemoryDecayScore(
  memory: Pick<MemoryNode, "quality" | "createdAt">,
  options: DecayScoreOptions,
): number {
  if (!Number.isFinite(options.halfLifeDays) || options.halfLifeDays <= 0) throw new Error("halfLifeDays must be finite and positive.");
  const quality = normalizeMemoryQuality(memory.quality);
  const ageMs = Math.max(0, options.now.getTime() - new Date(memory.createdAt).getTime());
  const ageDays = ageMs / DAY_MS;
  const lambda = Math.log(2) / (options.halfLifeDays * (0.5 + quality.stability));
  const recencyFactor = Math.exp(-lambda * ageDays);

  return computePersistenceScore(quality) * recencyFactor;
}
