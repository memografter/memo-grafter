import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { buildFactRetrievalPrompt, formatFactBlock } from "../../../src/prompts/factRetrievalPrompt.js";
import { RetrieverPipeline } from "../../../src/retrieval/RetrieverPipeline.js";
import type { GraphStore } from "../../../src/store/index.js";
import type { EmbedAdapter, Episode, MemoryNode, TopicNode } from "../../../src/core/types.js";
import { countApproxTokens } from "../../../src/utils/text/tokenCount.js";

type ScoredMemoryNode = MemoryNode & { similarity: number };

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

function makeScoredMemoryNode(
  overrides: Partial<ScoredMemoryNode> &
    Pick<MemoryNode, "memoryType" | "subject" | "predicate" | "value" | "quality">,
): ScoredMemoryNode {
  return {
    ...makeMemoryNode(overrides),
    similarity: overrides.similarity ?? 0.9,
  };
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

function makeEmbedder(vector = [0.1, 0.2, 0.3]): EmbedAdapter {
  return {
    embed: async () => vector,
  };
}

function makeStore(
  overrides: Partial<{
    searchMemories: GraphStore["searchMemories"];
    searchMemoryCandidates: NonNullable<GraphStore["searchMemoryCandidates"]>;
    searchTopicCandidates: NonNullable<GraphStore["searchTopicCandidates"]>;
    searchEpisodeCandidates: NonNullable<GraphStore["searchEpisodeCandidates"]>;
    getActiveMemoriesByTopicIds: NonNullable<GraphStore["getActiveMemoriesByTopicIds"]>;
    getMemoriesByTopic: GraphStore["getMemoriesByTopic"];
    getTopicNode: GraphStore["getTopicNode"];
  }> = {},
): GraphStore {
  return {
    searchMemories: async () => [],
    getTopicNode: async () => null,
    ...overrides,
  } as unknown as GraphStore;
}

describe("RetrieverPipeline", () => {
  it("hydrates cluster metadata after selection without changing scores, prompts, or budgets", async () => {
    const topic = { ...makeTopicNode({ label: "Japan Trip", summary: "Planning Japan travel.", topicOrder: 1 }), embedding: [1, 0], similarity: 0.96 };
    const search = vi.fn(async () => [structuredClone(topic)]);
    const store = makeStore({ searchTopicCandidates: search, getMemoriesByTopic: async () => [] });
    const cached = new Map<string, string>();
    const cache = { get: async (key: string) => cached.get(key) ?? null,
      setex: async (key: string, _ttl: number, value: string) => { cached.set(key, value); return "OK"; } } as unknown as Redis;
    const pipeline = new RetrieverPipeline(store, makeEmbedder([1, 0]), { cache: {} }, cache);
    const baseline = await pipeline.run("Japan", "session-1");
    const metadata = { clusters: [{ id: "travel", sessionId: "session-1", label: "Travel", normalizedLabel: "travel",
      description: "Travel planning", revision: 1, createdAt: new Date(), updatedAt: new Date() }],
      topicClusters: [{ topicId: topic.id, clusterId: "travel" }] };
    store.getTopicClusterMetadata = vi.fn(async () => metadata);
    const classified = await pipeline.run("Japan", "session-1");
    expect(classified.systemPrompt).toBe(baseline.systemPrompt);
    expect(classified.tokenCount).toBe(baseline.tokenCount);
    expect(classified.selection).toEqual(baseline.selection);
    expect(classified.topicMatches).toEqual(baseline.topicMatches);
    expect(classified.facts).toEqual(baseline.facts);
    expect(classified.nodes.map(node => node.id)).toEqual(baseline.nodes.map(node => node.id));
    expect(classified.clusterMetadata).toEqual(metadata);
    expect(store.getTopicClusterMetadata).toHaveBeenCalledExactlyOnceWith([{ id: topic.id, sessionId: "session-1" }]);
    metadata.clusters[0]!.label = "Journeys";
    const renamed = await pipeline.run("Japan", "session-1");
    expect(renamed.clusterMetadata?.clusters[0]?.label).toBe("Journeys");
    expect(renamed.systemPrompt).toBe(baseline.systemPrompt);
    metadata.clusters = [];
    metadata.topicClusters = [];
    expect((await pipeline.run("Japan", "session-1")).clusterMetadata?.clusters).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("still returns recall results when optional cluster hydration fails", async () => {
    const topic = { ...makeTopicNode({ label: "Japan Trip", summary: "Japan travel.", topicOrder: 1 }), similarity: 0.95 };
    const store = makeStore({ searchTopicCandidates: async () => [topic], getMemoriesByTopic: async () => [] });
    store.getTopicClusterMetadata = async () => { throw new Error("metadata unavailable"); };
    const result = await new RetrieverPipeline(store, makeEmbedder(), {}).run("Japan", "session-1");
    expect(result.nodes).toHaveLength(1);
    expect(result.degraded).toBe(true);
    expect(result.warnings?.[0]?.context).toEqual({ reason: "cluster-metadata" });
  });

  it("returns episode history separately from durable facts", async () => {
    const episode: Episode & { similarity: number } = {
      id: "00000000-0000-4000-8000-000000000001", sessionId: "session-1", segmentId: "segment-1",
      topicId: "topic-1", summary: "The user compared two deployment options and chose the first.",
      intent: "Choose a deployment option.", outcome: "The first option was selected.", openQuestion: null,
      embedding: [0.1, 0.2, 0.3], messageRange: [4, 5], episodeOrder: 2, sourceType: "conversation",
      assignmentMethod: "embedding", assignmentSimilarity: 0.94, assignmentVersion: 1,
      createdAt: new Date("2026-01-02T00:00:00.000Z"), similarity: 0.95,
    };
    const store = makeStore({
      searchEpisodeCandidates: async () => [episode],
    });
    store.getTopicClusterMetadata = vi.fn(async () => ({ clusters: [], topicClusters: [] }));
    const result = await new RetrieverPipeline(store, makeEmbedder(), {}).run("what did we choose", "session-1");

    expect(result.facts).toEqual([]);
    expect(result.episodes?.map((item) => item.id)).toEqual([episode.id]);
    expect(result.systemPrompt).toContain("historical context, not durable facts");
    expect(result.selection).toMatchObject({ episodeCandidateCount: 1, selectedEpisodeCount: 1 });
    expect(store.getTopicClusterMetadata).toHaveBeenCalledExactlyOnceWith([{ id: episode.topicId, sessionId: episode.sessionId }]);
  });

  it("searches memory and topic embeddings in parallel with the same query embedding", async () => {
    let releaseMemory!: () => void;
    const memoryPending = new Promise<void>((resolve) => { releaseMemory = resolve; });
    const memorySearch = vi.fn(async () => { await memoryPending; return []; });
    const topicSearch = vi.fn(async () => { releaseMemory(); return []; });
    const store = makeStore({ searchMemoryCandidates: memorySearch, searchTopicCandidates: topicSearch });

    await new RetrieverPipeline(store, makeEmbedder([0.4, 0.5]), {}).run("query", "session-1");

    expect(memorySearch).toHaveBeenCalledWith([0.4, 0.5], "session-1", 40, { tags: [], tagMode: "all", scope: "session" });
    expect(topicSearch).toHaveBeenCalledWith([0.4, 0.5], "session-1", 40, { tags: [], tagMode: "all", scope: "session" });
  });

  it("allows a topic-only match to contribute its summary and active child memories", async () => {
    const topic = { ...makeTopicNode({ id: "topic-food", label: "Healthy North Indian Food", summary: "Healthy protein-rich North Indian meals." }), similarity: 0.96 };
    const active = makeMemoryNode({ id: "active-food", topicNodeId: topic.id, memoryType: "preference", subject: "user", predicate: "prefers", value: "low-oil protein-rich meals", quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 }, embedding: [0.1, 0.2, 0.3] });
    const forgotten = makeMemoryNode({ id: "forgotten-food", topicNodeId: topic.id, memoryType: "fact", subject: "user", predicate: "ate", value: "forgotten meal", quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 }, forgotten: true, embedding: [0.1, 0.2, 0.3] });
    const pipeline = new RetrieverPipeline(makeStore({
      searchMemoryCandidates: async () => [],
      searchTopicCandidates: async () => [topic],
      getActiveMemoriesByTopicIds: async () => [active, forgotten],
    }), makeEmbedder(), {});

    const result = await pipeline.run("healthy food", "session-1");

    expect(result.nodes.map((node) => node.id)).toEqual([topic.id]);
    expect(result.facts.map((fact) => fact.id)).toEqual([active.id]);
    expect(result.systemPrompt).toContain(topic.summary);
    expect(result.systemPrompt).not.toContain(forgotten.value);
    expect(result.topicMatches).toEqual([{ topicId: topic.id, matchedBy: ["topic"], score: 0.96 }]);
    expect(result.selection).toMatchObject({ memoryCandidateCount: 0, topicCandidateCount: 1, topicOnlyMatchCount: 1 });
  });

  it("deduplicates a topic reached through both memory and topic search", async () => {
    const topic = { ...makeTopicNode({ id: "topic-both", label: "Both", summary: "Matched twice." }), similarity: 0.95 };
    const fact = makeScoredMemoryNode({ id: "fact-both", topicNodeId: topic.id, memoryType: "fact", subject: "project", predicate: "uses", value: "topic-aware retrieval", quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 }, similarity: 0.9 });
    const result = await new RetrieverPipeline(makeStore({
      searchMemoryCandidates: async () => [fact],
      searchTopicCandidates: async () => [topic],
      getActiveMemoriesByTopicIds: async () => [fact],
    }), makeEmbedder(), {}).run("retrieval", "session-1");

    expect(result.nodes.map((node) => node.id)).toEqual([topic.id]);
    expect(result.facts.map((candidate) => candidate.id)).toEqual([fact.id]);
    expect(result.topicMatches).toEqual([{ topicId: topic.id, matchedBy: ["memory", "topic"], score: 0.95 }]);
  });

  it("embeds a contextualized query and does not mutate the graph", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const store = makeStore({ searchMemories: vi.fn(async () => []) });
    const pipeline = new RetrieverPipeline(store, { embed }, {
      contextualization: {
        recentMessages: [
          { role: "user", content: "I want healthy North Indian meals." },
          { role: "assistant", content: "Consider dal and vegetable sabzi." },
        ],
      },
    }, null, undefined, { complete: async () => "Additional healthy North Indian meal options" });

    const result = await pipeline.run("What else can I eat?", "session-1");

    expect(embed).toHaveBeenCalledWith("Additional healthy North Indian meal options");
    expect(result.query).toMatchObject({ status: "applied", contextualized: true });
    expect(store.searchMemories).toHaveBeenCalledOnce();
    expect(Object.keys(store).filter((key) => /save|insert|append|edge/i.test(key))).toEqual([]);
  });
  it("returns structured degraded metadata when the optional cache is unavailable", async () => {
    const fact = makeScoredMemoryNode({ memoryType: "fact", subject: "cache", predicate: "is", value: "optional", quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 } });
    const store = makeStore({ searchMemories: vi.fn(async () => [fact]), getTopicNode: async () => makeTopicNode({}) });
    const cache = { get: vi.fn(async () => { throw new Error("redis down"); }), setex: vi.fn(async () => "OK") } as unknown as Redis;
    const pipeline = new RetrieverPipeline(store, makeEmbedder(), { cache: { ttlSeconds: 90 } }, cache);
    const result = await pipeline.run("query", "session-1");
    expect(result.degraded).toBe(true);
    expect(result.warnings?.[0]).toMatchObject({ code: "CACHE_UNAVAILABLE", operation: "context" });
    expect(store.searchMemories).toHaveBeenCalledOnce();
  });
  it("returns early on empty search results", async () => {
    const pipeline = new RetrieverPipeline(makeStore(), makeEmbedder(), {});

    const result = await pipeline.run("query", "session-1");

    expect(result.facts).toEqual([]);
    expect(result.nodes).toEqual([]);
    expect(result.systemPrompt).toBe(buildFactRetrievalPrompt([]));
  });

  it("forwards normalized tag filters to memory search", async () => {
    const calls: unknown[] = [];
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async (_embedding, _sessionId, _limit, _minSimilarity, options) => {
          calls.push(options);
          return [];
        },
      }),
      makeEmbedder(),
      {
        tags: [" Project:Memo-Grafter ", "planning", "PLANNING"],
        tagMode: "all",
      },
    );

    await pipeline.run("query", "session-1");

    expect(calls).toEqual([{
      tags: ["planning", "project:memo-grafter"],
      tagMode: "all",
      scope: "session-and-tags",
    }]);
  });

  it("supports tagged recall across sessions", async () => {
    const fact = makeScoredMemoryNode({
      id: "cross-session-fact",
      sessionId: "session-2",
      topicNodeId: "topic-2",
      memoryType: "fact",
      subject: "project",
      predicate: "uses",
      value: "tagged memory",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
    });
    const topic = makeTopicNode({
      id: "topic-2",
      sessionId: "session-2",
      label: "Tagged Topic",
      summary: "Tagged topic summary.",
      topicOrder: 1,
    });
    const topicCalls: Array<[string, string | undefined]> = [];
    const searchOptions: unknown[] = [];
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async (_embedding, _sessionId, _limit, _minSimilarity, options) => {
          searchOptions.push(options);
          return [fact];
        },
        getTopicNode: async (topicNodeId, sessionId) => {
          topicCalls.push([topicNodeId, sessionId]);
          return topic;
        },
      }),
      makeEmbedder(),
      {
        tags: ["project:memo-grafter"],
        scope: "tagged",
      },
    );

    const result = await pipeline.run("query", "session-1");

    expect(searchOptions).toEqual([{
      tags: ["project:memo-grafter"],
      tagMode: "all",
      scope: "tagged",
    }]);
    expect(topicCalls).toEqual([["topic-2", "session-2"]]);
    expect(result.facts.map((candidate) => candidate.id)).toEqual(["cross-session-fact"]);
  });

  it("filters decayed stale nodes", async () => {
    const stale = makeScoredMemoryNode({
      id: "decayed",
      memoryType: "fact",
      subject: "old",
      predicate: "uses",
      value: "stale value",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      decayed: true,
      similarity: 0.95,
    });
    const active = makeScoredMemoryNode({
      id: "active",
      memoryType: "fact",
      subject: "current",
      predicate: "uses",
      value: "active value",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      decayed: false,
      similarity: 0.9,
    });
    const topic = makeTopicNode({
      id: active.topicNodeId,
      label: "Active Topic",
      summary: "Active topic summary.",
      topicOrder: 1,
    });
    const topicCalls: Array<[string, string | undefined]> = [];
    const store = makeStore({
      searchMemories: async () => [stale, active],
      getTopicNode: async (topicNodeId, sessionId) => {
        topicCalls.push([topicNodeId, sessionId]);
        return topic;
      },
    });
    const pipeline = new RetrieverPipeline(store, makeEmbedder(), {});

    const result = await pipeline.run("query", "session-1");

    expect(result.facts.map((fact) => fact.id)).toEqual(["active"]);
    expect(topicCalls).toEqual([[active.topicNodeId, "session-1"]]);
  });

  it("filters superseded stale nodes", async () => {
    const superseded = makeScoredMemoryNode({
      id: "superseded",
      memoryType: "fact",
      subject: "old",
      predicate: "uses",
      value: "superseded value",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      supersededBy: "11111111-1111-1111-1111-111111111111",
      similarity: 0.95,
    });
    const active = makeScoredMemoryNode({
      id: "active",
      memoryType: "fact",
      subject: "current",
      predicate: "uses",
      value: "active value",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      supersededBy: null,
      similarity: 0.9,
    });
    const topic = makeTopicNode({
      id: active.topicNodeId,
      label: "Active Topic",
      summary: "Active topic summary.",
      topicOrder: 1,
    });
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => [superseded, active],
        getTopicNode: async () => topic,
      }),
      makeEmbedder(),
      {},
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts.map((fact) => fact.id)).toEqual(["active"]);
  });

  it("filters forgotten memories returned by custom stores", async () => {
    const forgotten = makeScoredMemoryNode({
      id: "forgotten",
      memoryType: "fact",
      subject: "user",
      predicate: "preference",
      value: "old value",
      quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
      forgotten: true,
    });
    const active = makeScoredMemoryNode({
      id: "active",
      memoryType: "fact",
      subject: "user",
      predicate: "preference",
      value: "current value",
      quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
    });
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => [forgotten, active],
        getTopicNode: async () => makeTopicNode({ label: "Prefs", summary: "Prefs.", topicOrder: 1 }),
      }),
      makeEmbedder(),
      {},
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts.map((fact) => fact.id)).toEqual(["active"]);
    expect(result.systemPrompt).not.toContain("old value");
  });

  it("drops blocks whose parent topic is suppressed", async () => {
    const fact = makeScoredMemoryNode({
      id: "fact-1",
      memoryType: "fact",
      subject: "user",
      predicate: "preference",
      value: "hidden topic fact",
      quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
    });
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => [fact],
        getTopicNode: async () => makeTopicNode({
          label: "Hidden",
          summary: "Hidden.",
          topicOrder: 1,
          suppressed: true,
        }),
      }),
      makeEmbedder(),
      {},
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts).toEqual([]);
    expect(result.nodes).toEqual([]);
    expect(result.systemPrompt).not.toContain("hidden topic fact");
  });

  it("returns early when all nodes are stale", async () => {
    const decayed = makeScoredMemoryNode({
      id: "decayed",
      memoryType: "fact",
      subject: "old",
      predicate: "uses",
      value: "stale value",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      decayed: true,
      similarity: 0.95,
    });
    const superseded = makeScoredMemoryNode({
      id: "superseded",
      memoryType: "fact",
      subject: "older",
      predicate: "uses",
      value: "superseded value",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      supersededBy: "11111111-1111-1111-1111-111111111111",
      similarity: 0.9,
    });
    const pipeline = new RetrieverPipeline(
      makeStore({ searchMemories: async () => [decayed, superseded] }),
      makeEmbedder(),
      {},
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts).toEqual([]);
    expect(result.nodes).toEqual([]);
    expect(result.tokenCount).toBe(0);
  });

  it("skips orphan nodes silently", async () => {
    const orphan = makeScoredMemoryNode({
      id: "orphan",
      memoryType: "fact",
      subject: "orphan",
      predicate: "has",
      value: "no topic",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      similarity: 0.95,
    });
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => [orphan],
        getTopicNode: async () => null,
      }),
      makeEmbedder(),
      {},
    );

    await expect(pipeline.run("query", "session-1")).resolves.toMatchObject({
      facts: [],
      nodes: [],
    });
  });

  it("ranks blocks by query similarity regardless of quality", async () => {
    const topicA = makeTopicNode({
      id: "topic-a",
      label: "Topic A",
      summary: "Topic A summary.",
      topicOrder: 1,
    });
    const topicB = makeTopicNode({
      id: "topic-b",
      label: "Topic B",
      summary: "Topic B summary.",
      topicOrder: 2,
    });
    const facts = [
      makeScoredMemoryNode({
        id: "a-high",
        topicNodeId: "topic-a",
        memoryType: "fact",
        subject: "a",
        predicate: "has",
        value: "high",
        quality: { explicitness: 0.1, sourceReliability: 0.1, stability: 0.1, salience: 0.1 },
        similarity: 0.95,
      }),
      makeScoredMemoryNode({
        id: "b-only",
        topicNodeId: "topic-b",
        memoryType: "fact",
        subject: "b",
        predicate: "has",
        value: "only",
        quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
        similarity: 0.88,
      }),
      makeScoredMemoryNode({
        id: "a-low",
        topicNodeId: "topic-a",
        memoryType: "fact",
        subject: "a",
        predicate: "has",
        value: "low",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        similarity: 0.7,
      }),
    ];
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => facts,
        getTopicNode: async (topicNodeId) => topicNodeId === "topic-a" ? topicA : topicB,
      }),
      makeEmbedder(),
      {},
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.nodes[0]?.id).toBe("topic-a");
  });

  it("uses evidence quality as a tie breaker for equal similarities", async () => {
    const topicA = makeTopicNode({
      id: "topic-a",
      label: "Topic A",
      summary: "Topic A summary.",
      topicOrder: 1,
    });
    const topicB = makeTopicNode({
      id: "topic-b",
      label: "Topic B",
      summary: "Topic B summary.",
      topicOrder: 2,
    });
    const lowConfidence = makeScoredMemoryNode({
      id: "low-confidence",
      topicNodeId: "topic-a",
      memoryType: "fact",
      subject: "a",
      predicate: "has",
      value: "same similarity",
      quality: { explicitness: 0.2, sourceReliability: 0.2, stability: 0.2, salience: 0.2 },
      similarity: 0.9,
    });
    const highConfidence = makeScoredMemoryNode({
      id: "high-confidence",
      topicNodeId: "topic-b",
      memoryType: "fact",
      subject: "b",
      predicate: "has",
      value: "same similarity",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      similarity: 0.9,
    });
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => [lowConfidence, highConfidence],
        getTopicNode: async (topicNodeId) => topicNodeId === "topic-a" ? topicA : topicB,
      }),
      makeEmbedder(),
      { selection: { scoreGapThreshold: 1 } },
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts.map((fact) => fact.id)).toEqual(["high-confidence", "low-confidence"]);
    expect(result.facts[0]).not.toHaveProperty("retrievalScore");
  });

  it("retrieves a broad unthresholded candidate pool before ranking", async () => {
    const calls: Array<{ limit: number; minSimilarity: number }> = [];
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async (_embedding, _sessionId, limit, minSimilarity) => {
          calls.push({ limit, minSimilarity });
          return [];
        },
      }),
      makeEmbedder(),
      {},
    );

    await pipeline.run("query", "session-1");

    expect(calls).toEqual([{ limit: 40, minSimilarity: -1 }]);
  });

  it("can select a useful fact below the former similarity floor", async () => {
    const topic = makeTopicNode({ id: "topic-a", label: "Topic A", summary: "summary" });
    const fact = makeScoredMemoryNode({
      id: "below-old-floor",
      topicNodeId: topic.id,
      similarity: 0.42,
      quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
    });
    const pipeline = new RetrieverPipeline(
      makeStore({ searchMemories: async () => [fact], getTopicNode: async () => topic }),
      makeEmbedder(),
      { minSimilarity: 0.95 },
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts.map((candidate) => candidate.id)).toEqual(["below-old-floor"]);
    expect(result.selection?.candidateCount).toBe(1);
  });

  it("stops adaptive selection at a significant ranked score gap", async () => {
    const topics = new Map([
      ["topic-a", makeTopicNode({ id: "topic-a", label: "A", summary: "A" })],
      ["topic-b", makeTopicNode({ id: "topic-b", label: "B", summary: "B" })],
    ]);
    const facts = [
      makeScoredMemoryNode({ id: "strong", topicNodeId: "topic-a", similarity: 0.95, quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 } }),
      makeScoredMemoryNode({ id: "weak", topicNodeId: "topic-b", similarity: 0.4, quality: { explicitness: 0.2, sourceReliability: 0.2, stability: 0.2, salience: 0.2 } }),
    ];
    const pipeline = new RetrieverPipeline(
      makeStore({ searchMemories: async () => facts, getTopicNode: async (id) => topics.get(id) ?? null }),
      makeEmbedder(),
      {},
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts.map((candidate) => candidate.id)).toEqual(["strong"]);
    expect(result.selection?.reason).toBe("relative-score");
  });

  it("keeps high quality from overriding higher similarity", async () => {
    const topicA = makeTopicNode({
      id: "topic-a",
      label: "Topic A",
      summary: "Topic A summary.",
      topicOrder: 1,
    });
    const topicB = makeTopicNode({
      id: "topic-b",
      label: "Topic B",
      summary: "Topic B summary.",
      topicOrder: 2,
    });
    const highSimilarity = makeScoredMemoryNode({
      id: "high-similarity",
      topicNodeId: "topic-a",
      memoryType: "fact",
      subject: "a",
      predicate: "has",
      value: "high similarity",
      quality: { explicitness: 0.1, sourceReliability: 0.1, stability: 0.1, salience: 0.1 },
      similarity: 0.95,
    });
    const highConfidence = makeScoredMemoryNode({
      id: "high-confidence",
      topicNodeId: "topic-b",
      memoryType: "fact",
      subject: "b",
      predicate: "has",
      value: "high confidence",
      quality: { explicitness: 1, sourceReliability: 1, stability: 1, salience: 1 },
      similarity: 0.88,
    });
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => [highConfidence, highSimilarity],
        getTopicNode: async (topicNodeId) => topicNodeId === "topic-a" ? topicA : topicB,
      }),
      makeEmbedder(),
      {
      },
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.nodes[0]?.id).toBe("topic-a");
  });

  it("drops whole blocks when the token budget is exhausted", async () => {
    const topicA = makeTopicNode({
      id: "topic-a",
      label: "Topic A",
      summary: "Topic A summary.",
      topicOrder: 1,
    });
    const topicB = makeTopicNode({
      id: "topic-b",
      label: "Topic B",
      summary: "Topic B summary.",
      topicOrder: 2,
    });
    const factA = makeScoredMemoryNode({
      id: "a",
      topicNodeId: "topic-a",
      memoryType: "fact",
      subject: "a",
      predicate: "has",
      value: "higher ranked value",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      similarity: 0.95,
    });
    const factB = makeScoredMemoryNode({
      id: "b",
      topicNodeId: "topic-b",
      memoryType: "fact",
      subject: "b",
      predicate: "has",
      value: "lower ranked value",
      quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
      similarity: 0.88,
    });
    const budget = countApproxTokens(formatFactBlock([factA], topicA));
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => [factA, factB],
        getTopicNode: async (topicNodeId) => topicNodeId === "topic-a" ? topicA : topicB,
      }),
      makeEmbedder(),
      { tokenBudget: budget },
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts.map((fact) => fact.id)).toEqual(["a"]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.id).toBe("topic-a");
  });

  it("returns a flat facts array in ranked block order", async () => {
    const topicA = makeTopicNode({
      id: "topic-a",
      label: "Topic A",
      summary: "Topic A summary.",
      topicOrder: 1,
    });
    const topicB = makeTopicNode({
      id: "topic-b",
      label: "Topic B",
      summary: "Topic B summary.",
      topicOrder: 2,
    });
    const facts = [
      makeScoredMemoryNode({
        id: "a-1",
        topicNodeId: "topic-a",
        memoryType: "fact",
        subject: "a1",
        predicate: "has",
        value: "first",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        similarity: 0.95,
      }),
      makeScoredMemoryNode({
        id: "b-1",
        topicNodeId: "topic-b",
        memoryType: "fact",
        subject: "b1",
        predicate: "has",
        value: "first",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        similarity: 0.9,
      }),
      makeScoredMemoryNode({
        id: "a-2",
        topicNodeId: "topic-a",
        memoryType: "fact",
        subject: "a2",
        predicate: "has",
        value: "second",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        similarity: 0.7,
      }),
      makeScoredMemoryNode({
        id: "b-2",
        topicNodeId: "topic-b",
        memoryType: "fact",
        subject: "b2",
        predicate: "has",
        value: "second",
        quality: { explicitness: 0.9, sourceReliability: 0.9, stability: 0.9, salience: 0.9 },
        similarity: 0.6,
      }),
    ];
    const pipeline = new RetrieverPipeline(
      makeStore({
        searchMemories: async () => facts,
        getTopicNode: async (topicNodeId) => topicNodeId === "topic-a" ? topicA : topicB,
      }),
      makeEmbedder(),
      { tokenBudget: 1200 },
    );

    const result = await pipeline.run("query", "session-1");

    expect(result.facts).toHaveLength(4);
    expect(result.facts.map((fact) => fact.id)).toEqual(["a-1", "a-2", "b-1", "b-2"]);
  });
});
