import { describe, expect, it, vi } from "vitest";
import type { Episode, TopicNode } from "../../../src/core/types.js";
import type { GraphStore } from "../../../src/store/index.js";
import { TopicAssigner } from "../../../src/ingestion/conversation/TopicAssigner.js";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

function topic(id: string, embedding: number[]): TopicNode {
  return {
    id, sessionId: "session", segmentId: `segment-${id}`, label: "Billing database",
    summary: "The billing database design was discussed.", embedding, messageRange: [0, 1],
    topicOrder: 1, driftScore: 0, agentColor: null, fleetId: null, agentId: null,
    episodeCount: 1, embeddingCount: 1, revision: 1, createdAt,
  };
}

function episode(embedding: number[]): Episode {
  return {
    id: "00000000-0000-4000-8000-000000000001", sessionId: "session", segmentId: "segment-new",
    topicId: "proposed", summary: "The user returned to billing database indexing.",
    intent: "Choose indexes.", outcome: "An index was selected.", openQuestion: null, embedding,
    messageRange: [8, 9], episodeOrder: 2, sourceType: "conversation", assignmentMethod: "created",
    assignmentSimilarity: null, assignmentVersion: 1, createdAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

describe("TopicAssigner", () => {
  it("reuses a matching topic and updates its centroid and activity", async () => {
    const existing = topic("existing", [1, 0]);
    const store = { getSimilarNodes: vi.fn(async () => [existing]) } as unknown as GraphStore;
    const result = await new TopicAssigner(store, { reuseThreshold: 0.8 }).assign(
      episode([0.99, 0.01]), topic("proposed", [0.99, 0.01]),
    );

    expect(result.createTopic).toBe(false);
    expect(result.topic.id).toBe("existing");
    expect(result.topic.episodeCount).toBe(2);
    expect(result.topic.embeddingCount).toBe(2);
    expect(result.topic.lastEpisodeId).toBe("00000000-0000-4000-8000-000000000001");
    expect(result.topic.summary).toContain("returned to billing database indexing");
  });

  it("creates a topic when the best candidate is below the threshold", async () => {
    const store = { getSimilarNodes: vi.fn(async () => [topic("unrelated", [0, 1])]) } as unknown as GraphStore;
    const result = await new TopicAssigner(store, { reuseThreshold: 0.8 }).assign(
      episode([1, 0]), topic("proposed", [1, 0]),
    );

    expect(result.createTopic).toBe(true);
    expect(result.topic.id).toBe("proposed");
    expect(result.topic.episodeCount).toBe(1);
  });

  it("can reuse a topic created earlier in the same ingestion run", async () => {
    const store = { getSimilarNodes: vi.fn(async () => []) } as unknown as GraphStore;
    const inBatch = topic("in-batch", [1, 0]);
    const result = await new TopicAssigner(store).assign(episode([1, 0]), topic("proposed", [1, 0]), [inBatch]);

    expect(result.createTopic).toBe(false);
    expect(result.topic.id).toBe("in-batch");
  });
});
