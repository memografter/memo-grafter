import { computeMemoryDecayScore } from "./decayScoring.js";
import type { CrawlerPass, CrawlerPassContext, CrawlerPassResult } from "./types.js";

export interface DecayScoringPassOptions {
  /** Observe proposed retirements by default; enforce after application-specific evaluation. */
  mode?: "observe" | "enforce";
  halfLifeDays?: number;
  minScore?: number;
  now?: () => Date;
  /** Grace period for new or migrated quality. Default 7 days. */
  minimumRetentionDays?: number;
}

const DEFAULT_HALF_LIFE_DAYS = 90;
const DEFAULT_MIN_SCORE = 0.25;

export class DecayScoringPass implements CrawlerPass {
  readonly name = "decay-scoring";
  private readonly halfLifeDays: number;
  private readonly minScore: number;
  private readonly now: () => Date;
  private readonly minimumRetentionDays: number;
  private readonly mode: "observe" | "enforce";

  constructor(options: DecayScoringPassOptions = {}) {
    this.mode = options.mode ?? "observe";
    this.halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    this.minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    this.now = options.now ?? (() => new Date());
    this.minimumRetentionDays = options.minimumRetentionDays ?? 7;
    if (!Number.isFinite(this.minimumRetentionDays) || this.minimumRetentionDays < 0) throw new Error("minimumRetentionDays must be finite and nonnegative.");

    if (!Number.isFinite(this.halfLifeDays) || this.halfLifeDays <= 0) {
      throw new Error("DecayScoringPass halfLifeDays must be greater than 0.");
    }

    if (!Number.isFinite(this.minScore) || this.minScore < 0) {
      throw new Error("DecayScoringPass minScore must be greater than or equal to 0.");
    }
  }

  async run(context: CrawlerPassContext): Promise<CrawlerPassResult> {
    if (!context.store) {
      throw new Error("DecayScoringPass requires a crawler maintenance store.");
    }

    const memories = await context.store.listMemoryNodesForMaintenance();
    const now = this.now();
    let decayScored = 0;
    let nodesDecayed = 0;
    let wouldDecay = 0;
    let skippedAlreadyDecayed = 0;
    let skippedSuperseded = 0;
    let skippedForgotten = 0;
    let minDecayScore: number | undefined;
    let maxDecayScore: number | undefined;

    for (const memory of memories) {
      if (memory.forgotten) {
        skippedForgotten += 1;
        continue;
      }

      if (memory.supersededBy != null) {
        skippedSuperseded += 1;
        continue;
      }

      if (memory.decayed) {
        skippedAlreadyDecayed += 1;
        continue;
      }

      const score = computeMemoryDecayScore(memory, {
        now,
        halfLifeDays: this.halfLifeDays,
      });
      decayScored += 1;
      minDecayScore = minDecayScore === undefined ? score : Math.min(minDecayScore, score);
      maxDecayScore = maxDecayScore === undefined ? score : Math.max(maxDecayScore, score);


      const retentionStart = Math.max(new Date(memory.createdAt).getTime(), memory.qualityUpdatedAt ? new Date(memory.qualityUpdatedAt).getTime() : 0);
      if (score < this.minScore && now.getTime() - retentionStart >= this.minimumRetentionDays * 86400000) {
        wouldDecay += 1;
        if (this.mode === "enforce") {
          const decayed = await context.store.markMemoryNodeDecayed(memory.id);
          if (decayed) nodesDecayed += 1;
        }
      }
    }

    return {
      inspected: memories.length,
      decayScored,
      nodesDecayed,
      wouldDecay,
      skippedAlreadyDecayed,
      skippedSuperseded,
      skippedForgotten,
      ...(minDecayScore !== undefined ? { minDecayScore } : {}),
      ...(maxDecayScore !== undefined ? { maxDecayScore } : {}),
    };
  }
}
