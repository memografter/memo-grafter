import { describe, expect, it } from "vitest";
import { computeMemoryDecayScore } from "../../../src/maintenance/decayScoring.js";

describe("computeMemoryDecayScore", () => {
  const now = new Date("2026-01-31T00:00:00.000Z");

  it("returns full persistence priority when the memory has no age", () => {
    const score = computeMemoryDecayScore(
      { quality: { explicitness: 0.8, sourceReliability: 0.8, stability: 0.8, salience: 0.8 }, createdAt: now },
      { now, halfLifeDays: 30 },
    );

    expect(score).toBeCloseTo(0.8);
  });

  it("returns half persistence priority after one base half-life", () => {
    const score = computeMemoryDecayScore(
      { quality: { explicitness: 0.8, sourceReliability: 0.8, stability: 0.8, salience: 0.8 }, createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { now, halfLifeDays: 30 },
    );

    expect(score).toBeCloseTo(0.8 * Math.pow(0.5, 1 / 1.3));
  });

  it("returns quarter persistence priority after two base half-lives", () => {
    const score = computeMemoryDecayScore(
      { quality: { explicitness: 0.8, sourceReliability: 0.8, stability: 0.8, salience: 0.8 }, createdAt: new Date("2025-12-02T00:00:00.000Z") },
      { now, halfLifeDays: 30 },
    );

    expect(score).toBeCloseTo(0.8 * Math.pow(0.5, 2 / 1.3));
  });

  it("multiplies the recency factor by the memory persistence priority", () => {
    const score = computeMemoryDecayScore(
      { quality: { explicitness: 0.5, sourceReliability: 0.5, stability: 0.5, salience: 0.5 }, createdAt: new Date("2026-01-16T00:00:00.000Z") },
      { now, halfLifeDays: 30 },
    );

    expect(score).toBeCloseTo(0.5 * Math.sqrt(0.5));
  });

  it("treats future memories as age zero", () => {
    const score = computeMemoryDecayScore(
      { quality: { explicitness: 0.7, sourceReliability: 0.7, stability: 0.7, salience: 0.7 }, createdAt: new Date("2026-02-15T00:00:00.000Z") },
      { now, halfLifeDays: 30 },
    );

    expect(score).toBeCloseTo(0.7);
  });
});
