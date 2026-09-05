import { describe, expect, it } from "vitest";
import { GrafterPipeline } from "../../../src/retrieval/GrafterPipeline.js";
import type { MemoryEdge, MemoryNode, Message, TopicNode } from "../../../src/core/types.js";

function makeTopicNode(overrides: Partial<TopicNode> = {}): TopicNode {
  return {
    id: "topic-1",
    sessionId: "session-1",
    segmentId: "segment-1",
    label: "Residence",
    summary: "The user lives in Delhi.",
    embedding: [0.1, 0.2],
    messageRange: [0, 1],
    topicOrder: 1,
    driftScore: 0,
    agentColor: null,
    fleetId: null,
    agentId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "memory-1",
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

describe("GrafterPipeline maintenance-aware prompts", () => {
  async function runWithMemories(
    topic: TopicNode,
    memories: MemoryNode[],
    memoryEdges: MemoryEdge[],
  ): Promise<string> {
    const store = {
      getNeighbours: async () => [topic],
      getBufferMessages: async (): Promise<Message[]> => [
        { role: "user", content: "I live in Delhi." },
      ],
      getMemoriesBySession: async () => memories,
      getMemoryEdgesBySession: async () => memoryEdges,
    };
    const pipeline = new GrafterPipeline(store as never, {
      hopDepth: 1,
      bufferSize: 0,
      tokenBudget: 4000,
    });

    const result = await pipeline.run("session-1", [topic.id]);
    return result.systemPrompt;
  }

  it("adds contradiction notes and active facts without rewriting the historical summary", async () => {
    const topic = makeTopicNode();
    const oldMemory = makeMemory({
      id: "old-location",
      value: "Delhi",
      supersededBy: "new-location",
      hasConflict: true,
    });
    const newMemory = makeMemory({
      id: "new-location",
      topicNodeId: "topic-2",
      value: "Bangalore",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const memoryEdge: MemoryEdge = {
      id: "edge-1",
      sourceId: "new-location",
      targetId: "old-location",
      edgeType: "updates",
      weight: 1,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const store = {
      getNeighbours: async () => [topic],
      getBufferMessages: async (): Promise<Message[]> => [
        { role: "user", content: "I live in Delhi." },
      ],
      getMemoriesBySession: async () => [oldMemory, newMemory],
      getMemoryEdgesBySession: async () => [memoryEdge],
    };
    const pipeline = new GrafterPipeline(store as never, {
      hopDepth: 1,
      bufferSize: 0,
      tokenBudget: 4000,
    });

    const result = await pipeline.run("session-1", [topic.id]);

    expect(result.systemPrompt).toContain("Summary: The user lives in Delhi.");
    expect(result.systemPrompt).toContain("Memory maintenance notes:");
    expect(result.systemPrompt).toContain(
      'The fact "user location: Delhi" was superseded by "Bangalore".',
    );
    expect(result.systemPrompt).toContain("Prefer active memory facts over contradictory historical summary details.");
    expect(result.systemPrompt).toContain("Active memory facts:");
    expect(result.systemPrompt).toContain("- user location: Bangalore");
  });

  it("notes a superseded memory even when the replacement is not available", async () => {
    const topic = makeTopicNode();
    const oldMemory = makeMemory({
      id: "old-location",
      value: "Delhi",
      supersededBy: "missing-location",
    });

    const systemPrompt = await runWithMemories(topic, [oldMemory], []);

    expect(systemPrompt).toContain(
      'The fact "user location: Delhi" was superseded by a newer memory.',
    );
    expect(systemPrompt).toContain("Prefer active memory facts over contradictory historical summary details.");
    expect(systemPrompt).not.toContain("Active memory facts:");
  });

  it("does not include a decayed replacement as an active memory fact", async () => {
    const topic = makeTopicNode();
    const oldMemory = makeMemory({
      id: "old-location",
      value: "Delhi",
      supersededBy: "new-location",
    });
    const decayedReplacement = makeMemory({
      id: "new-location",
      topicNodeId: "topic-2",
      value: "Bangalore",
      decayed: true,
    });

    const systemPrompt = await runWithMemories(topic, [oldMemory, decayedReplacement], []);

    expect(systemPrompt).toContain(
      'The fact "user location: Delhi" was superseded by "Bangalore".',
    );
    expect(systemPrompt).not.toContain("Active memory facts:");
    expect(systemPrompt).not.toContain("- user location: Bangalore");
  });

  it("adds a maintenance note when an edge touches topic memory even without memory flags", async () => {
    const topic = makeTopicNode();
    const topicMemory = makeMemory({ id: "topic-memory" });
    const otherMemory = makeMemory({ id: "other-memory", topicNodeId: "topic-2", value: "Bangalore" });
    const memoryEdge: MemoryEdge = {
      id: "edge-1",
      sourceId: "topic-memory",
      targetId: "other-memory",
      edgeType: "conflicts",
      weight: 1,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };

    const systemPrompt = await runWithMemories(topic, [topicMemory, otherMemory], [memoryEdge]);

    expect(systemPrompt).toContain("Memory maintenance notes:");
    expect(systemPrompt).toContain("Prefer active memory facts over contradictory historical summary details.");
    expect(systemPrompt).toContain("Active memory facts:");
    expect(systemPrompt).toContain("- user location: Delhi");
  });

  it("ignores maintenance edges unrelated to the selected topic memory", async () => {
    const topic = makeTopicNode();
    const topicMemory = makeMemory({ id: "topic-memory" });
    const memoryEdge: MemoryEdge = {
      id: "edge-1",
      sourceId: "other-memory-a",
      targetId: "other-memory-b",
      edgeType: "conflicts",
      weight: 1,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };

    const systemPrompt = await runWithMemories(topic, [topicMemory], [memoryEdge]);

    expect(systemPrompt).not.toContain("Memory maintenance notes:");
    expect(systemPrompt).not.toContain("Active memory facts:");
  });

  it("does not include forgotten memories in graft maintenance context", async () => {
    const topic = makeTopicNode();
    const forgotten = makeMemory({
      id: "forgotten-memory",
      value: "private old value",
      forgotten: true,
    });
    const active = makeMemory({
      id: "active-memory",
      value: "kept value",
    });

    const systemPrompt = await runWithMemories(topic, [forgotten, active], []);

    expect(systemPrompt).not.toContain("private old value");
    expect(systemPrompt).not.toContain("forgotten-memory");
  });

  it("drops suppressed topics returned by custom stores", async () => {
    const topic = makeTopicNode({
      suppressed: true,
      summary: "Suppressed summary.",
    });
    const store = {
      getNeighbours: async () => [topic],
      getBufferMessages: async (): Promise<Message[]> => [
        { role: "user", content: "Hidden detail." },
      ],
      getMemoriesBySession: async () => [makeMemory({ value: "hidden memory" })],
      getMemoryEdgesBySession: async () => [],
    };
    const pipeline = new GrafterPipeline(store as never, {
      hopDepth: 1,
      bufferSize: 0,
      tokenBudget: 4000,
    });

    const result = await pipeline.run("session-1", [topic.id]);

    expect(result.nodes).toEqual([]);
    expect(result.systemPrompt).toBe("");
  });
});
