import { afterEach, describe, expect, it, vi } from "vitest";
import { TopicClusterAssigner, normalizeClusterLabel } from "../../../src/ingestion/clustering/TopicClusterAssigner.js";
import type { TopicCluster, TopicClusteringConfig, TopicNode } from "../../../src/core/types.js";
import type { ClusterDecision, GraphStore } from "../../../src/store/GraphStore.js";

const date = new Date("2026-01-01");
const domain = { label: "Travel", description: "Trips, international travel, visas and transport planning.", confidence: 0.97 };
function topic(id = "japan", changes: Partial<TopicNode> = {}): TopicNode {
  return { id, sessionId: "s", segmentId: id, label: "Japan Trip", summary: "Planning a holiday in Japan.",
    embedding: [1, 0], messageRange: [0, 1], topicOrder: 1, driftScore: 0, revision: 1,
    agentColor: null, fleetId: null, agentId: null, createdAt: date, ...changes };
}
function cluster(id = "travel", changes: Partial<TopicCluster> = {}): TopicCluster {
  return { id, sessionId: "s", label: domain.label, normalizedLabel: "travel", description: domain.description,
    embedding: [1, 0], revision: 1, createdAt: date, updatedAt: date, ...changes };
}
function harness(nodes = [topic()], initial: TopicCluster[] = [], config: TopicClusteringConfig = {}) {
  const clusters = [...initial];
  const persisted = new Map(nodes.map(node => [node.id, structuredClone(node)]));
  const llm = { complete: vi.fn(async () => JSON.stringify(domain)) };
  const embedder = { dimensions: 2, embed: vi.fn(async () => [1, 0]) };
  const catalog = vi.fn(async () => ({ clusters: structuredClone(clusters), revision: String(clusters.length) }));
  const commit = vi.fn(async (decision: ClusterDecision): Promise<"saved" | "stale"> => {
    const row = persisted.get(decision.topicId)!;
    if (row.clusterId || row.revision !== decision.expectedTopicRevision || decision.expectedCatalogRevision !== String(clusters.length)) return "stale";
    if (decision.cluster && !clusters.some(item => item.id === decision.cluster!.id)) clusters.push(decision.cluster);
    row.clusterId = decision.cluster?.id ?? null;
    row.clusterAssignment = decision.assignment;
    return "saved";
  });
  const store = { getTopicNode: vi.fn(async (id: string) => structuredClone(persisted.get(id) ?? null)),
    getTopicClusterCatalog: catalog, commitTopicClusterDecision: commit,
    listUnclusteredTopics: vi.fn(async (_session: string, after: string | undefined, limit: number) =>
      [...persisted.values()].filter(row => !row.clusterId && row.id > (after ?? "")).sort((a,b) => a.id.localeCompare(b.id)).slice(0, limit)),
  } as unknown as GraphStore;
  const assigner = new TopicClusterAssigner(store, llm, embedder, { enabled: true, ...config });
  return { assigner, nodes, persisted, clusters, llm, embedder, store, catalog, commit };
}
afterEach(() => vi.useRealTimers());

describe("TopicClusterAssigner", () => {
  it("does no work when disabled and reports unsupported custom stores when enabled", async () => {
    const h = harness([topic()], [], { enabled: false });
    expect(await h.assigner.classify(h.nodes)).toEqual([]);
    expect(h.store.getTopicNode).not.toHaveBeenCalled();
    const unsupported = new TopicClusterAssigner({} as GraphStore, h.llm, h.embedder, { enabled: true });
    expect(await unsupported.classify(h.nodes)).toHaveLength(1);
  });

  it("creates one domain without changing topic semantics, then skips already assigned topics", async () => {
    const h = harness();
    const before = structuredClone(h.nodes[0]);
    expect(await h.assigner.classify(h.nodes)).toEqual([]);
    expect(h.clusters).toHaveLength(1);
    expect(h.nodes[0]).toMatchObject({ ...before, clusterId: h.clusters[0]!.id,
      clusterAssignment: { method: "created", topicRevision: 1 } });
    await h.assigner.classify(h.nodes);
    expect(h.llm.complete).toHaveBeenCalledTimes(1);
    expect(h.embedder.embed).toHaveBeenCalledTimes(1);
  });

  it("reuses semantically equivalent domains and caches an unchanged catalog across topics", async () => {
    const h = harness([topic("visa"), topic("flights")], [cluster("travel", { aliases: ["trips"] })]);
    h.llm.complete.mockResolvedValueOnce(JSON.stringify({ ...domain, label: "Trips" }))
      .mockResolvedValueOnce(JSON.stringify({ action: "reuse", clusterId: "travel", confidence: 0.98 }))
      .mockResolvedValueOnce(JSON.stringify(domain))
      .mockResolvedValueOnce(JSON.stringify({ action: "reuse", clusterId: "travel", confidence: 0.98 }));
    await h.assigner.classify(h.nodes);
    expect(h.clusters).toHaveLength(1);
    expect(h.nodes.every(node => node.clusterId === "travel")).toBe(true);
    expect(h.catalog).toHaveBeenCalledTimes(1);
  });

  it("does not conflate shared vocabulary when the verifier rejects domain membership", async () => {
    const h = harness([topic("simulator", { label: "Flight Simulator Development" })], [cluster()]);
    h.llm.complete.mockResolvedValueOnce(JSON.stringify({ ...domain, label: "Software Development", description: "Building and testing software applications." }))
      .mockResolvedValueOnce(JSON.stringify({ action: "create", confidence: 0.98 }));
    await h.assigner.classify(h.nodes);
    expect(h.nodes[0]!.clusterId).not.toBe("travel");
    expect(h.clusters).toHaveLength(2);
  });

  it("abstains instead of duplicating an exact normalized label with conflicting semantics", async () => {
    const h = harness([topic()], [cluster()]);
    h.llm.complete.mockResolvedValueOnce(JSON.stringify({ ...domain, label: " TRAVEL! " }))
      .mockResolvedValueOnce(JSON.stringify({ action: "create", confidence: 0.99 }));
    await h.assigner.classify(h.nodes);
    expect(h.clusters).toHaveLength(1);
    expect(h.nodes[0]!.clusterAssignment?.method).toBe("unassigned");
    expect(normalizeClusterLabel(" Ｔｒａｖｅｌ / Planning ")).toBe("travel planning");
  });

  it("does not retry an ambiguous unchanged topic, and cools down changed topics", async () => {
    const h = harness();
    h.llm.complete.mockResolvedValue(JSON.stringify({ unassigned: true }));
    await h.assigner.classify(h.nodes);
    h.persisted.get("japan")!.revision = 2;
    await h.assigner.classify(h.nodes);
    expect(h.llm.complete).toHaveBeenCalledTimes(1);
    h.persisted.get("japan")!.clusterAssignment!.retryAfter = new Date(0).toISOString();
    await h.assigner.classify(h.nodes);
    expect(h.llm.complete).toHaveBeenCalledTimes(2);
    h.persisted.get("japan")!.clusterAssignment!.retryAfter = new Date(0).toISOString();
    await h.assigner.classify(h.nodes);
    expect(h.llm.complete).toHaveBeenCalledTimes(2);
  });

  it("rechecks a changed catalog before creating, reusing the concurrent winner", async () => {
    const h = harness();
    h.commit.mockImplementationOnce(async () => { h.clusters.push(cluster()); return "stale"; });
    h.llm.complete.mockResolvedValueOnce(JSON.stringify(domain)).mockResolvedValueOnce(JSON.stringify(domain))
      .mockResolvedValueOnce(JSON.stringify({ action: "reuse", clusterId: "travel", confidence: 0.99 }));
    await h.assigner.classify(h.nodes);
    expect(h.clusters).toHaveLength(1);
    expect(h.nodes[0]!.clusterId).toBe("travel");
    expect(h.commit).toHaveBeenCalledTimes(2);
  });

  it("bounds candidate lists, rejects hallucinated IDs, and never offers another session's clusters", async () => {
    const h = harness([topic()], [cluster("foreign", { sessionId: "other" }), cluster("travel"), cluster("extra")], { candidateLimit: 1 });
    h.llm.complete.mockResolvedValueOnce(JSON.stringify(domain))
      .mockResolvedValueOnce(JSON.stringify({ action: "reuse", clusterId: "foreign", confidence: 0.99 }));
    expect(await h.assigner.classify(h.nodes)).toHaveLength(1);
    const prompt = (h.llm.complete.mock.calls[1] as unknown as [Array<{ content: string }>])[0][0]!.content;
    expect(JSON.parse(prompt).candidates).toHaveLength(1);
    expect(prompt).not.toContain('"foreign"');
    expect(h.nodes[0]!.clusterId).toBeUndefined();
    expect(h.persisted.get("japan")!.clusterAssignment?.method).toBe("failed");
  });

  it("times out non-cooperative adapters without late writes, and persists a retry cooldown", async () => {
    vi.useFakeTimers();
    const h = harness([topic()], [], { timeoutMs: 20 });
    let release!: (value: string) => void;
    h.llm.complete.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = h.assigner.classify(h.nodes);
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toHaveLength(1);
    expect(h.persisted.get("japan")!.clusterAssignment?.method).toBe("failed");
    release(JSON.stringify(domain));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.clusters).toHaveLength(0);
    expect(h.embedder.embed).not.toHaveBeenCalled();
    await h.assigner.classify(h.nodes);
    expect(h.llm.complete).toHaveBeenCalledTimes(1);
  });

  it("deduplicates within a run and backfills in resumable bounded pages", async () => {
    const h = harness([topic("a"), topic("b"), topic("c")], [], { maxTopicsPerRun: 1 });
    await h.assigner.classify([h.nodes[0]!, h.nodes[0]!, h.nodes[1]!]);
    expect(h.llm.complete).toHaveBeenCalledTimes(1);
    h.llm.complete.mockResolvedValueOnce(JSON.stringify(domain))
      .mockResolvedValueOnce(JSON.stringify({ action: "reuse", clusterId: h.clusters[0]!.id, confidence: 0.98 }));
    const page = await h.assigner.backfill("s");
    expect(page).toMatchObject({ scanned: 1, nextCursor: "b", warnings: [] });
    expect(h.persisted.get("c")!.clusterId).toBeUndefined();
  });

  it("reclassifies topics after their cluster is deleted", async () => {
    const h = harness();
    await h.assigner.classify(h.nodes);
    h.clusters.length = 0;
    h.persisted.get("japan")!.clusterId = null;
    await h.assigner.classify(h.nodes);
    expect(h.llm.complete).toHaveBeenCalledTimes(2);
    expect(h.clusters).toHaveLength(1);
  });

  it("rejects malformed responses and incompatible embedding dimensions without assignment", async () => {
    const h = harness([topic()], [cluster("old", { embedding: [1, 0, 0] })]);
    expect(await h.assigner.classify(h.nodes)).toHaveLength(1);
    expect(h.nodes[0]!.clusterId).toBeUndefined();
    expect(h.clusters).toHaveLength(1);
  });
});
