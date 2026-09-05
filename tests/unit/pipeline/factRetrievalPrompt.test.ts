import { describe, expect, it } from "vitest";
import {
  buildFactRetrievalPrompt,
  formatFactBlock,
} from "../../../src/prompts/factRetrievalPrompt.js";
import type { MemoryNode, TopicNode } from "../../../src/core/types.js";

function makeMemoryNode(
  overrides: Partial<MemoryNode> &
    Pick<MemoryNode, "memoryType" | "subject" | "predicate" | "value" | "quality">,
): MemoryNode {
  const base: MemoryNode = {
    id: "memory-1",
    segmentId: "segment-1",
    topicNodeId: "topic-1",
    agentId: null,
    sessionId: "session-1",
    memoryType: "fact",
    sourceType: "conversation",
    subject: "subject",
    predicate: "predicate",
    value: "value",
    quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
    embedding: [0.1, 0.2],
    sourceUrl: null,
    sourceTitle: null,
    supersededBy: null,
    decayed: false,
    agentColor: null,
    fleetId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  return { ...base, ...overrides };
}

function makeTopicNode(
  overrides: Partial<TopicNode> & Pick<TopicNode, "label" | "summary" | "topicOrder">,
): TopicNode {
  const base: TopicNode = {
    id: "topic-1",
    sessionId: "session-1",
    segmentId: "segment-1",
    label: "Topic",
    summary: "Topic summary.",
    embedding: [0.1, 0.2],
    messageRange: [0, 1],
    topicOrder: 1,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  return { ...base, ...overrides };
}

describe("fact retrieval prompt", () => {
  it("formatFactBlock renders a single fact with the correct line format", () => {
    const topic = makeTopicNode({
      label: "Authentication Flow",
      summary: "User authenticated via OAuth2.",
      topicOrder: 2,
    });
    const fact = makeMemoryNode({
      memoryType: "fact",
      subject: "user",
      predicate: "uses",
      value: "OAuth2 with PKCE",
      quality: { explicitness: 0.92, sourceReliability: 0.92, stability: 0.92, salience: 0.92 },
    });

    const output = formatFactBlock([fact], topic);

    expect(output).toContain("## Authentication Flow (order: 2)");
    expect(output).toContain("[FACT] user → uses: OAuth2 with PKCE (evidence: 0.92, source: 0.92)");
    expect(output).toContain("\n> User authenticated via OAuth2.");
    expect(output).toMatch(/\n> /);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("formatFactBlock renders all five memory types with the correct prefix", () => {
    const topic = makeTopicNode({
      label: "Memory Types",
      summary: "All memory types were discussed.",
      topicOrder: 1,
    });
    const facts = [
      makeMemoryNode({
        memoryType: "fact",
        subject: "fact",
        predicate: "has",
        value: "a value",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      }),
      makeMemoryNode({
        memoryType: "insight",
        subject: "insight",
        predicate: "has",
        value: "a value",
        quality: { explicitness: 0.8, sourceReliability: 0.8, stability: 0.8, salience: 0.8 },
      }),
      makeMemoryNode({
        memoryType: "question",
        subject: "question",
        predicate: "has",
        value: "a value",
        quality: { explicitness: 0.7, sourceReliability: 0.7, stability: 0.7, salience: 0.7 },
      }),
      makeMemoryNode({
        memoryType: "task",
        subject: "task",
        predicate: "has",
        value: "a value",
        quality: { explicitness: 0.6, sourceReliability: 0.6, stability: 0.6, salience: 0.6 },
      }),
      makeMemoryNode({
        memoryType: "reference",
        subject: "reference",
        predicate: "has",
        value: "a value",
        quality: { explicitness: 0.5, sourceReliability: 0.5, stability: 0.5, salience: 0.5 },
      }),
    ];

    const output = formatFactBlock(facts, topic);

    for (const prefix of ["[FACT]", "[INSIGHT]", "[QUESTION]", "[TASK]", "[REFERENCE]"]) {
      expect(output.match(new RegExp(`\\${prefix}`, "g"))).toHaveLength(1);
    }
  });

  it("formatFactBlock formats evidence quality with toFixed(2)", () => {
    const topic = makeTopicNode({
      label: "Confidence",
      summary: "Confidence scores were rendered.",
      topicOrder: 3,
    });
    const facts = [
      makeMemoryNode({
        memoryType: "fact",
        subject: "first",
        predicate: "scores",
        value: "high",
        quality: { explicitness: 0.9166666, sourceReliability: 0.9166666, stability: 0.9166666, salience: 0.9166666 },
      }),
      makeMemoryNode({
        memoryType: "fact",
        subject: "second",
        predicate: "scores",
        value: "low",
        quality: { explicitness: 0.1, sourceReliability: 0.1, stability: 0.1, salience: 0.1 },
      }),
    ];

    const output = formatFactBlock(facts, topic);

    expect(output).toContain("evidence: 0.92");
    expect(output).toContain("evidence: 0.10");
  });

  it("formatFactBlock handles an empty facts array", () => {
    const topic = makeTopicNode({
      label: "Authentication Flow",
      summary: "User authenticated via OAuth2.",
      topicOrder: 2,
    });

    expect(() => formatFactBlock([], topic)).not.toThrow();

    const output = formatFactBlock([], topic);

    expect(output).toBe(
      "## Authentication Flow (order: 2)\n\n" +
        "> User authenticated via OAuth2.\n",
    );
    expect(output).not.toMatch(/\[(FACT|INSIGHT|QUESTION|TASK|REFERENCE)\]/);
  });

  it("buildFactRetrievalPrompt renders the structure with two blocks", () => {
    const output = buildFactRetrievalPrompt(["block one", "block two"]);

    expect(output.startsWith("### Retrieved Memory\n")).toBe(true);
    expect(output).toContain("block one\n---\nblock two");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("buildFactRetrievalPrompt handles an empty blocks array", () => {
    const output = buildFactRetrievalPrompt([]);

    expect(output.startsWith("### Retrieved Memory\n")).toBe(true);
    expect(output).not.toContain("---");
    expect(output.endsWith("\n")).toBe(true);
  });
});
