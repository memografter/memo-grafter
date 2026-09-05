import { describe, expect, it } from "vitest";
import {
  ConflictDetectionPass,
  DecayScoringPass,
  MemoGrafterCrawler,
  VersioningPass,
  type CrawlerMaintenanceStore,
} from "../../../src/index.js";
import type { MemoryEdge, MemoryNode } from "../../../src/core/types.js";

class InMemoryMaintenanceStore implements CrawlerMaintenanceStore {
  readonly memories: MemoryNode[];
  readonly edges: MemoryEdge[] = [];

  constructor(memories: MemoryNode[]) {
    this.memories = memories;
  }

  async listMemoryNodesForMaintenance(): Promise<MemoryNode[]> {
    return this.memories.map((memory) => ({ ...memory }));
  }

  async markMemoryNodesConflicting(memoryNodeIds: string[]): Promise<number> {
    let updated = 0;
    const ids = new Set(memoryNodeIds);

    for (const memory of this.memories) {
      if (ids.has(memory.id) && memory.hasConflict !== true) {
        memory.hasConflict = true;
        updated += 1;
      }
    }

    return updated;
  }

  async markMemoryNodeSuperseded(memoryNodeId: string, supersededBy: string): Promise<boolean> {
    const memory = this.memories.find((candidate) => candidate.id === memoryNodeId);
    if (!memory || memory.supersededBy != null) return false;

    memory.supersededBy = supersededBy;
    return true;
  }

  async markMemoryNodeDecayed(memoryNodeId: string): Promise<boolean> {
    const memory = this.memories.find((candidate) => candidate.id === memoryNodeId);
    if (!memory || memory.decayed || memory.supersededBy != null) return false;

    memory.decayed = true;
    return true;
  }

  async updateMemoryNodeQuality(memoryNodeId: string, quality: MemoryNode["quality"]): Promise<boolean> {
    const memory = this.memories.find((candidate) => candidate.id === memoryNodeId);
    if (!memory) return false;

    memory.quality = quality;
    return true;
  }

  async upsertMemoryEdge(edge: Pick<MemoryEdge, "sourceId" | "targetId" | "edgeType"> & {
    weight?: number;
  }): Promise<boolean> {
    const exists = this.edges.some((candidate) => {
      if (candidate.edgeType !== edge.edgeType) return false;
      if (edge.edgeType === "updates") {
        return candidate.sourceId === edge.sourceId && candidate.targetId === edge.targetId;
      }

      return (candidate.sourceId === edge.sourceId && candidate.targetId === edge.targetId)
        || (candidate.sourceId === edge.targetId && candidate.targetId === edge.sourceId);
    });

    if (exists) return false;

    this.edges.push({
      id: `edge-${this.edges.length + 1}`,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      edgeType: edge.edgeType,
      weight: edge.weight ?? 1,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    return true;
  }
}

function makeMemory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "memory-a",
    segmentId: "segment-1",
    topicNodeId: "topic-1",
    agentId: null,
    sessionId: "session-1",
    memoryType: "fact",
    sourceType: "conversation",
    subject: "user",
    predicate: "location",
    value: "Delhi",
    quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
    embedding: [0.1, 0.2],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    hasConflict: false,
    agentColor: null,
    fleetId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("crawler memory maintenance passes", () => {
  it("keeps plain disagreements as active conflicts without versioning them", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({ id: "memory-a", value: "Delhi" }),
      makeMemory({ id: "memory-b", value: "Bangalore" }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [new ConflictDetectionPass(), new VersioningPass()],
    });

    const report = await crawler.runOnce();

    expect(report.passes[0]?.result).toMatchObject({
      inspected: 2,
      conflictsDetected: 1,
      nodesMarkedConflicting: 2,
      conflictEdgesCreated: 1,
    });
    expect(report.passes[1]?.result).toMatchObject({
      versionsDetected: 0,
      nodesSuperseded: 0,
      updateEdgesCreated: 0,
    });
    expect(store.memories.every((memory) => memory.hasConflict)).toBe(true);
    expect(store.memories.every((memory) => memory.supersededBy === null)).toBe(true);
    expect(store.edges).toMatchObject([
      {
        sourceId: "memory-a",
        targetId: "memory-b",
        edgeType: "conflicts",
      },
    ]);
  });

  it("does not detect conflicts when normalized values are equal", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({ id: "memory-a", value: " Delhi " }),
      makeMemory({ id: "memory-b", value: "delhi" }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [new ConflictDetectionPass()],
    });

    const report = await crawler.runOnce();

    expect(report.passes[0]?.result).toMatchObject({
      conflictsDetected: 0,
      nodesMarkedConflicting: 0,
      conflictEdgesCreated: 0,
    });
    expect(store.edges).toHaveLength(0);
  });

  it("groups broad travel plan memories without conflicting unrelated topics", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({
        id: "rajma",
        subject: "user",
        predicate: "asked_about",
        value: "how to cook rajma chawal",
      }),
      makeMemory({
        id: "goa",
        subject: "user",
        predicate: "asked_about",
        value: "Goa trip plan",
      }),
      makeMemory({
        id: "vietnam",
        subject: "user",
        predicate: "asked_about",
        value: "Vietnam trip plan",
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [new ConflictDetectionPass(), new VersioningPass()],
    });

    const report = await crawler.runOnce();

    expect(report.passes[0]?.result).toMatchObject({
      conflictsDetected: 1,
      nodesMarkedConflicting: 2,
      conflictEdgesCreated: 1,
    });
    expect(report.passes[1]?.result).toMatchObject({
      versionsDetected: 0,
      nodesSuperseded: 0,
      updateEdgesCreated: 0,
    });
    expect(store.edges.filter((edge) => edge.edgeType === "conflicts")).toMatchObject([
      {
        sourceId: "goa",
        targetId: "vietnam",
        edgeType: "conflicts",
      },
    ]);
    expect(store.memories.find((memory) => memory.id === "rajma")?.hasConflict).toBe(false);
    expect(store.memories.find((memory) => memory.id === "rajma")?.supersededBy).toBeNull();
    expect(store.memories.find((memory) => memory.id === "goa")?.hasConflict).toBe(true);
    expect(store.memories.find((memory) => memory.id === "vietnam")?.hasConflict).toBe(true);
    expect(store.memories.find((memory) => memory.id === "goa")?.supersededBy).toBeNull();
    expect(store.memories.find((memory) => memory.id === "vietnam")?.supersededBy).toBeNull();
  });

  it("does not conflict broad travel subtopics for the same destination", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({
        id: "vietnam-food",
        subject: "user",
        predicate: "asked_about",
        value: "food in Vietnam",
      }),
      makeMemory({
        id: "vietnam-places",
        subject: "user",
        predicate: "asked_about",
        value: "places to visit Vietnam",
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [new ConflictDetectionPass(), new VersioningPass()],
    });

    const report = await crawler.runOnce();

    expect(report.passes[0]?.result).toMatchObject({
      conflictsDetected: 0,
      nodesMarkedConflicting: 0,
      conflictEdgesCreated: 0,
    });
    expect(report.passes[1]?.result).toMatchObject({
      versionsDetected: 0,
      nodesSuperseded: 0,
      updateEdgesCreated: 0,
    });
    expect(store.edges).toHaveLength(0);
    expect(store.memories.every((memory) => memory.hasConflict === false)).toBe(true);
    expect(store.memories.every((memory) => memory.supersededBy === null)).toBe(true);
  });

  it("versions explicit replacements without creating unresolved conflicts", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({
        id: "older",
        value: "Delhi",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      makeMemory({
        id: "newer",
        value: "Actually Bangalore now",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [new ConflictDetectionPass(), new VersioningPass()],
    });

    const report = await crawler.runOnce();

    expect(report.passes[0]?.result).toMatchObject({
      conflictsDetected: 0,
      nodesMarkedConflicting: 0,
      conflictEdgesCreated: 0,
    });
    expect(report.passes[1]?.result).toMatchObject({
      versionsDetected: 1,
      nodesSuperseded: 1,
      updateEdgesCreated: 1,
    });
    expect(store.memories.find((memory) => memory.id === "older")?.supersededBy).toBe("newer");
    expect(store.memories.find((memory) => memory.id === "newer")?.supersededBy).toBeNull();
    expect(store.memories.every((memory) => memory.hasConflict === false)).toBe(true);
    expect(store.edges).toMatchObject([
      {
        sourceId: "newer",
        targetId: "older",
        edgeType: "updates",
      },
    ]);
  });

  it("uses deterministic id fallback when timestamps match", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const store = new InMemoryMaintenanceStore([
      makeMemory({ id: "aaa", value: "Delhi", createdAt }),
      makeMemory({ id: "zzz", value: "Now Bangalore", createdAt }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [new VersioningPass()],
    });

    await crawler.runOnce();

    expect(store.memories.find((memory) => memory.id === "aaa")?.supersededBy).toBe("zzz");
    expect(store.memories.find((memory) => memory.id === "zzz")?.supersededBy).toBeNull();
  });

  it("is idempotent across repeated crawler runs", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({ id: "older", value: "Delhi" }),
      makeMemory({
        id: "newer",
        value: "Now Bangalore",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [new ConflictDetectionPass(), new VersioningPass()],
    });

    await crawler.runOnce();
    const secondReport = await crawler.runOnce();

    expect(store.edges).toHaveLength(1);
    expect(store.memories.filter((memory) => memory.hasConflict)).toHaveLength(0);
    expect(secondReport.passes[0]?.result).toMatchObject({
      conflictsDetected: 0,
      nodesMarkedConflicting: 0,
      conflictEdgesCreated: 0,
      skippedSuperseded: 1,
    });
    expect(secondReport.passes[1]?.result).toMatchObject({
      versionsDetected: 0,
      nodesSuperseded: 0,
      updateEdgesCreated: 0,
      skippedSuperseded: 1,
    });
  });

  it("ignores decayed and already superseded memories without deleting anything", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({ id: "active", value: "Delhi" }),
      makeMemory({ id: "decayed", value: "Bangalore", decayed: true }),
      makeMemory({ id: "superseded", value: "Mumbai", supersededBy: "active" }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [new ConflictDetectionPass(), new VersioningPass()],
    });

    const report = await crawler.runOnce();

    expect(store.memories).toHaveLength(3);
    expect(store.edges).toHaveLength(0);
    expect(report.passes[0]?.result).toMatchObject({
      conflictsDetected: 0,
      skippedDecayed: 1,
      skippedSuperseded: 1,
    });
    expect(report.passes[1]?.result).toMatchObject({
      versionsDetected: 0,
      skippedDecayed: 1,
      skippedSuperseded: 1,
    });
  });

  it("skips forgotten memories during conflict, versioning, and decay passes", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({ id: "forgotten-a", value: "Delhi", forgotten: true }),
      makeMemory({ id: "forgotten-b", value: "Actually Bangalore", forgotten: true }),
      makeMemory({ id: "active", value: "Mumbai" }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [
        new ConflictDetectionPass(),
        new VersioningPass(),
        new DecayScoringPass({ mode: "enforce",
          now: () => new Date("2026-12-01T00:00:00.000Z"),
          minScore: 0.9,
        }),
      ],
    });

    const report = await crawler.runOnce();

    expect(report.passes[0]?.result).toMatchObject({
      conflictsDetected: 0,
      skippedForgotten: 2,
    });
    expect(report.passes[1]?.result).toMatchObject({
      versionsDetected: 0,
      skippedForgotten: 2,
    });
    expect(report.passes[2]?.result).toMatchObject({
      decayScored: 1,
      skippedForgotten: 2,
    });
    expect(store.memories.find((memory) => memory.id === "forgotten-a")?.hasConflict).toBe(false);
    expect(store.memories.find((memory) => memory.id === "forgotten-b")?.supersededBy).toBeNull();
  });

  it("keeps recent high-scoring memories active during decay scoring", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({
        id: "recent",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        createdAt: new Date("2026-01-09T00:00:00.000Z"),
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [
        new DecayScoringPass({ mode: "enforce",
          halfLifeDays: 30,
          minScore: 0.25,
          now: () => new Date("2026-01-10T00:00:00.000Z"),
        }),
      ],
    });

    const report = await crawler.runOnce();

    expect(store.memories[0]?.decayed).toBe(false);
    expect(report.passes[0]?.result).toMatchObject({
      inspected: 1,
      decayScored: 1,
      nodesDecayed: 0,
      skippedAlreadyDecayed: 0,
      skippedSuperseded: 0,
    });
    expect(report.passes[0]?.result?.minDecayScore).toBeGreaterThan(0.25);
  });

  it("marks old low-scoring memories as decayed", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({
        id: "stale",
        quality: { explicitness: 0.4, sourceReliability: 0.4, stability: 0.4, salience: 0.4 },
        createdAt: new Date("2025-01-10T00:00:00.000Z"),
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [
        new DecayScoringPass({ mode: "enforce",
          halfLifeDays: 30,
          minScore: 0.25,
          now: () => new Date("2026-01-10T00:00:00.000Z"),
        }),
      ],
    });

    const report = await crawler.runOnce();

    expect(store.memories[0]?.decayed).toBe(true);
    expect(report.passes[0]?.result).toMatchObject({
      inspected: 1,
      decayScored: 1,
      nodesDecayed: 1,
    });
    expect(report.passes[0]?.result?.maxDecayScore).toBeLessThan(0.25);
  });

  it("skips superseded and already decayed memories during decay scoring", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({
        id: "active",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        createdAt: new Date("2026-01-09T00:00:00.000Z"),
      }),
      makeMemory({
        id: "already-decayed",
        decayed: true,
        createdAt: new Date("2025-01-10T00:00:00.000Z"),
      }),
      makeMemory({
        id: "superseded",
        supersededBy: "active",
        createdAt: new Date("2025-01-10T00:00:00.000Z"),
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [
        new DecayScoringPass({ mode: "enforce",
          halfLifeDays: 30,
          minScore: 0.25,
          now: () => new Date("2026-01-10T00:00:00.000Z"),
        }),
      ],
    });

    const report = await crawler.runOnce();

    expect(store.memories).toHaveLength(3);
    expect(store.memories.find((memory) => memory.id === "already-decayed")?.decayed).toBe(true);
    expect(store.memories.find((memory) => memory.id === "superseded")?.decayed).toBe(false);
    expect(report.passes[0]?.result).toMatchObject({
      decayScored: 1,
      nodesDecayed: 0,
      skippedAlreadyDecayed: 1,
      skippedSuperseded: 1,
    });
  });

  it("does not decay the same memory twice across repeated decay runs", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({
        id: "stale",
        quality: { explicitness: 0.4, sourceReliability: 0.4, stability: 0.4, salience: 0.4 },
        createdAt: new Date("2025-01-10T00:00:00.000Z"),
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [
        new DecayScoringPass({ mode: "enforce",
          halfLifeDays: 30,
          minScore: 0.25,
          now: () => new Date("2026-01-10T00:00:00.000Z"),
        }),
      ],
    });

    await crawler.runOnce();
    const secondReport = await crawler.runOnce();

    expect(store.memories[0]?.decayed).toBe(true);
    expect(secondReport.passes[0]?.result).toMatchObject({
      decayScored: 0,
      nodesDecayed: 0,
      skippedAlreadyDecayed: 1,
    });
  });

  it("never overwrites quality with temporal decay", async () => {
    const store = new InMemoryMaintenanceStore([
      makeMemory({
        id: "old-confidence",
        quality: { explicitness: 0.8, sourceReliability: 0.8, stability: 0.8, salience: 0.8 },
        createdAt: new Date("2025-12-11T00:00:00.000Z"),
      }),
    ]);
    const crawler = new MemoGrafterCrawler({
      store,
      passes: [
        new DecayScoringPass({ mode: "enforce",
          halfLifeDays: 30,
          minScore: 0,
          now: () => new Date("2026-01-10T00:00:00.000Z"),
        }),
      ],
    });

    await crawler.runOnce();

    expect(store.memories[0]?.quality.explicitness).toBeCloseTo(0.8);
  });
});
