import { describe, expect, it } from "vitest";
import { assessQualityAdmission, computePersistenceScore, normalizeMemoryQuality, normalizeMemoryQualityWithDefaults, reinforceMemoryQuality } from "../../../src/utils/memoryQuality.js";
import { parseSegmentExtraction } from "../../../src/utils/extraction/segmentExtraction.js";
import { computeMemoryDecayScore } from "../../../src/maintenance/decayScoring.js";
import { DecayScoringPass } from "../../../src/maintenance/DecayScoringPass.js";
import type { CrawlerMaintenanceStore } from "../../../src/maintenance/types.js";
import type { MemoryNode } from "../../../src/core/types.js";

describe("memory quality", () => {
  it.each([undefined, null, [], "1", true, 1])("defaults malformed objects conservatively: %s", value => {
    expect(normalizeMemoryQuality(value)).toEqual({ explicitness: 0.5, sourceReliability: 0.5, stability: 0.5, salience: 0.5 });
  });

  it("clamps finite scores and defaults individual malformed dimensions without coercion", () => {
    expect(normalizeMemoryQualityWithDefaults({ explicitness: 2, sourceReliability: -1, stability: "0.9", salience: NaN }))
      .toEqual({ quality: { explicitness: 1, sourceReliability: 0, stability: 0.5, salience: 0.5 }, defaulted: ["stability", "salience"] });
    expect(normalizeMemoryQuality({ explicitness: Infinity, sourceReliability: -Infinity, stability: false, salience: null }))
      .toEqual(normalizeMemoryQuality(undefined));
    const a = normalizeMemoryQuality(undefined); a.salience = 0;
    expect(normalizeMemoryQuality(undefined).salience).toBe(0.5);
  });

  it("ignores legacy confidence and diagnoses defaulted extraction fields", () => {
    const warnings: unknown[] = [];
    const extraction = parseSegmentExtraction(JSON.stringify({ label: "Food", user_intent: "Save preference", outcome: "Saved", memories: [
      { memory_type: "fact", subject: "user", predicate: "prefers", value: "vegetarian meals", confidence: 1,
        provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" } },
    ] }), { onWarning: warning => warnings.push(warning) });
    expect(extraction.memories[0]?.quality).toEqual(normalizeMemoryQuality(undefined));
    expect(extraction.memories[0]).not.toHaveProperty("confidence");
    expect(warnings).toHaveLength(1);
  });

  it("observes weak evidence by default and enforces only evidence thresholds", () => {
    const weak = { explicitness: 0.1, sourceReliability: 0.9, stability: 1, salience: 1 };
    expect(assessQualityAdmission(weak)).toEqual({ accepted: true, reason: "low-explicitness" });
    expect(assessQualityAdmission(weak, [], { mode: "enforce" }).accepted).toBe(false);
    expect(assessQualityAdmission(weak, ["explicitness"], { mode: "enforce" }).accepted).toBe(true);
    expect(assessQualityAdmission(undefined, [], { mode: "enforce", minExplicitness: 0.9, minSourceReliability: 0.9 }).accepted).toBe(true);
    expect(assessQualityAdmission({ ...weak, explicitness: 0.95, stability: 0, salience: 0.95 }, [], { mode: "enforce" }).accepted).toBe(true);
  });

  it("keeps evidence dimensions paired and does not inflate stability or salience on repetition", () => {
    const existing = { explicitness: 0.95, sourceReliability: 0.5, stability: 0.2, salience: 0.4 };
    const incoming = { explicitness: 0.8, sourceReliability: 0.9, stability: 1, salience: 1 };
    const reinforced = reinforceMemoryQuality(existing, incoming);
    expect(reinforced).toEqual({ explicitness: 0.8, sourceReliability: 0.9, stability: 0.2, salience: 0.4 });
    expect(reinforceMemoryQuality(reinforced, incoming)).toEqual(reinforced);
    expect(reinforceMemoryQuality(reinforced, existing)).toEqual(reinforced);
  });

  it("retains stable memories longer without mutating quality", () => {
    const quality = { explicitness: 0.9, sourceReliability: 0.8, stability: 0.1, salience: 0.9 };
    const snapshot = { ...quality };
    const createdAt = new Date("2026-01-01"), now = new Date("2026-04-01");
    const temporary = computeMemoryDecayScore({ quality, createdAt }, { now, halfLifeDays: 90 });
    const stable = computeMemoryDecayScore({ quality: { ...quality, stability: 0.9 }, createdAt }, { now, halfLifeDays: 90 });
    expect(stable).toBeGreaterThan(temporary);
    expect(quality).toEqual(snapshot);
    expect(computePersistenceScore(undefined)).toBe(0.5);
  });

  it("observes retirement by default and enforces only after the migration grace period", async () => {
    const now = new Date("2026-04-01");
    const memory = { id: "legacy", createdAt: new Date("2025-01-01"), quality: normalizeMemoryQuality(undefined) } as MemoryNode;
    let retired = 0;
    const store = { listMemoryNodesForMaintenance: async () => [memory], markMemoryNodeDecayed: async () => { retired++; return true; } } as unknown as CrawlerMaintenanceStore;
    const observed = await new DecayScoringPass({ now: () => now }).run({ store });
    expect(observed.wouldDecay).toBe(1);
    expect(retired).toBe(0);
    memory.qualityUpdatedAt = now;
    await new DecayScoringPass({ mode: "enforce", now: () => now }).run({ store });
    expect(retired).toBe(0);
    await new DecayScoringPass({ mode: "enforce", now: () => new Date("2026-04-09") }).run({ store });
    expect(retired).toBe(1);
    expect(memory.quality).toEqual(normalizeMemoryQuality(undefined));
  });
});
