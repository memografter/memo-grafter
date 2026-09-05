import { describe, expect, it, vi } from "vitest";
import type { DriftSegment } from "../../../src/ingestion/conversation/TopicDriftDetector.js";
import type { Message, TopicNode } from "../../../src/core/types.js";
import {
  resetDriftThresholdWarningForTests,
  resolveDriftThreshold,
} from "../../../src/utils/drift/driftThreshold.js";
import { parseSegmentExtraction } from "../../../src/utils/extraction/segmentExtraction.js";
import { findCurrentRunReentryEdges } from "../../../src/utils/reentry/reentryEdges.js";

function makeNode(id: string, topicOrder: number): TopicNode {
  return {
    id,
    sessionId: "session",
    segmentId: `segment-${id}`,
    label: id,
    summary: id,
    embedding: [1, 0],
    messageRange: [0, 0],
    topicOrder,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date(),
  };
}

describe("extracted utility helpers", () => {
  it("resolves drift sensitivity and warns once for deprecated threshold", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetDriftThresholdWarningForTests();

    expect(resolveDriftThreshold({ driftSensitivity: "low" })).toBe(0.25);
    expect(resolveDriftThreshold({ driftSensitivity: "medium" })).toBe(0.35);
    expect(resolveDriftThreshold({ driftSensitivity: "high" })).toBe(0.5);
    expect(resolveDriftThreshold({ threshold: 0.31 })).toBe(0.31);
    expect(resolveDriftThreshold({ threshold: 0.32 })).toBe(0.32);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it("parses JSON segment extraction responses", () => {
    const result = parseSegmentExtraction(JSON.stringify({
      label: "Database",
      user_intent: "Choose a database.",
      outcome: "PostgreSQL was selected.",
      open: null,
      memories: [
        {
          memory_type: "fact",
          subject: "Database",
          predicate: "selected",
          value: "PostgreSQL",
          quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
          provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" },
        },
      ],
    }));

    expect(result.label).toBe("Database");
    expect(result.userIntent).toBe("Choose a database.");
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.quality.explicitness).toBe(0.9);
    expect(result.memories[0]?.provenance).toEqual({ speaker: "user", messageIndexes: [1], extractionMethod: "explicit" });
  });

  it("rejects memory candidates without evidence provenance and clamps quality", () => {
    const result = parseSegmentExtraction(JSON.stringify({
      label: "Food", user_intent: "Get a suggestion.", outcome: "The assistant suggested yogurt.", open: null,
      memories: [
        { memory_type: "fact", subject: "user", predicate: "likes", value: "yogurt", quality: { explicitness: 5, sourceReliability: 5, stability: 5, salience: 5 } },
        { memory_type: "fact", subject: "user", predicate: "avoids", value: "dairy", quality: { explicitness: 5, sourceReliability: 5, stability: 5, salience: 5 },
          provenance: { speaker: "user", message_indexes: [1], extraction_method: "explicit" } },
      ],
    }));
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.quality.explicitness).toBe(1);
  });

  it("finds current-run reentry edges from explicit cues and lexical overlap", () => {
    const segments: DriftSegment[] = [
      { start: 0, end: 0, topicOrder: 1, driftScore: 0.4 },
      { start: 1, end: 1, topicOrder: 2, driftScore: 0.5 },
      { start: 2, end: 2, topicOrder: 3, driftScore: 0 },
    ];
    const messages: Message[] = [
      { role: "user", content: "PostgreSQL database pooling needs a durable plan" },
      { role: "user", content: "by the way auth login needs OAuth support" },
      { role: "user", content: "Actually going back to the database pooling question" },
    ];
    const embeddings = [
      [1, 0],
      [0, 1],
      [0.2, 0.98],
    ];
    const nodeByTopicOrder = new Map([
      [1, makeNode("database", 1)],
      [2, makeNode("auth", 2)],
      [3, makeNode("database-return", 3)],
    ]);

    const edges = findCurrentRunReentryEdges({
      segments,
      messages,
      embeddings,
      nodeByTopicOrder,
      reentryThreshold: 0.85,
    });

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      srcId: "database-return",
      dstId: "database",
      type: "reentry",
    });
  });
});
