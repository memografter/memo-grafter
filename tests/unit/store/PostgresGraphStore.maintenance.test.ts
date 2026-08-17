import { describe, expect, it } from "vitest";
import { PostgresGraphStore } from "../../../src/store/index.js";
import type { MemoryEdge } from "../../../src/core/types.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

type FakeSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  array(values: string[]): string[];
};

function createStoreWithSql(results: unknown[][]): {
  store: PostgresGraphStore;
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return results.shift() ?? [];
  }) as FakeSql;
  sql.array = (values) => values;

  const store = new PostgresGraphStore("postgres://user:pass@localhost:5432/memografter_test");
  (store as unknown as { sql: FakeSql }).sql = sql;

  return { store, calls };
}

function makeMemoryRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    segment_id: "segment-1",
    topic_node_id: "topic-1",
    agent_id: null,
    session_id: "session-1",
    memory_type: "fact",
    source_type: "conversation",
    subject: "user",
    predicate: "location",
    value: "Delhi",
    confidence: 1,
    embedding: [0.1, 0.2],
    tags: [],
    source: null,
    source_url: null,
    source_title: null,
    superseded_by: null,
    decayed: false,
    forgotten: false,
    forgotten_at: null,
    has_conflict: false,
    agent_color: null,
    fleet_id: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeMemoryEdgeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "edge-1",
    source_id: "22222222-2222-2222-2222-222222222222",
    target_id: "11111111-1111-1111-1111-111111111111",
    edge_type: "updates",
    weight: 1,
    created_at: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("PostgresGraphStore maintenance methods", () => {
  it("does not execute SQL when marking an empty conflict set", async () => {
    const { store, calls } = createStoreWithSql([]);

    await expect(store.markMemoryNodesConflicting([])).resolves.toBe(0);

    expect(calls).toHaveLength(0);
  });

  it("returns the number of memories marked conflicting", async () => {
    const { store, calls } = createStoreWithSql([[{ id: "memory-a" }, { id: "memory-b" }]]);

    await expect(store.markMemoryNodesConflicting(["memory-a", "memory-b"])).resolves.toBe(2);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("SET has_conflict = TRUE");
    expect(calls[0]?.values).toContainEqual(["memory-a", "memory-b"]);
  });

  it("reports whether a memory was superseded", async () => {
    const changed = createStoreWithSql([[{ id: "old-memory" }]]);
    const unchanged = createStoreWithSql([[]]);

    await expect(changed.store.markMemoryNodeSuperseded("old-memory", "new-memory")).resolves.toBe(true);
    await expect(unchanged.store.markMemoryNodeSuperseded("old-memory", "new-memory")).resolves.toBe(false);

    expect(changed.calls[0]?.text).toContain("SET superseded_by");
    expect(changed.calls[0]?.text).toContain("AND superseded_by IS NULL");
  });

  it("reports whether a memory was marked decayed", async () => {
    const changed = createStoreWithSql([[{ id: "stale-memory" }]]);
    const unchanged = createStoreWithSql([[]]);

    await expect(changed.store.markMemoryNodeDecayed("stale-memory")).resolves.toBe(true);
    await expect(unchanged.store.markMemoryNodeDecayed("stale-memory")).resolves.toBe(false);

    expect(changed.calls[0]?.text).toContain("SET decayed = TRUE");
    expect(changed.calls[0]?.text).toContain("AND decayed = FALSE");
    expect(changed.calls[0]?.text).toContain("AND superseded_by IS NULL");
  });

  it("reports whether memory confidence was updated", async () => {
    const changed = createStoreWithSql([[{ id: "memory-1" }]]);
    const unchanged = createStoreWithSql([[]]);

    await expect(changed.store.updateMemoryNodeConfidence("memory-1", 0.45)).resolves.toBe(true);
    await expect(unchanged.store.updateMemoryNodeConfidence("memory-1", 0.45)).resolves.toBe(false);

    expect(changed.calls[0]?.text).toContain("SET confidence =");
    expect(changed.calls[0]?.values).toContain(0.45);
  });

  it("soft-forgets a memory without deleting it", async () => {
    const changed = createStoreWithSql([[{ id: "memory-1" }]]);
    const unchanged = createStoreWithSql([[]]);

    await expect(changed.store.forgetMemory("memory-1")).resolves.toBe(true);
    await expect(unchanged.store.forgetMemory("memory-1")).resolves.toBe(false);

    expect(changed.calls[0]?.text).toContain("SET");
    expect(changed.calls[0]?.text).toContain("forgotten = TRUE");
    expect(changed.calls[0]?.text).toContain("forgotten_at = COALESCE");
    expect(changed.calls[0]?.text).not.toContain("DELETE");
  });

  it("soft-forgets memories in bulk and returns the changed count", async () => {
    const { store, calls } = createStoreWithSql([[{ id: "memory-a" }, { id: "memory-b" }]]);

    await expect(store.forgetMemories(["memory-a", "memory-b"])).resolves.toBe(2);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("forgotten = TRUE");
    expect(calls[0]?.values).toContainEqual(["memory-a", "memory-b"]);
  });

  it("does not execute SQL for empty bulk forget requests", async () => {
    const { store, calls } = createStoreWithSql([]);

    await expect(store.forgetMemories([])).resolves.toBe(0);

    expect(calls).toHaveLength(0);
  });

  it("suppresses and restores topics as soft lifecycle state", async () => {
    const suppressed = createStoreWithSql([[{ id: "topic-1" }]]);
    const restored = createStoreWithSql([[{ id: "topic-1" }]]);

    await expect(suppressed.store.suppressTopic("topic-1")).resolves.toBe(true);
    await expect(restored.store.restoreTopic("topic-1")).resolves.toBe(true);

    expect(suppressed.calls[0]?.text).toContain("suppressed = TRUE");
    expect(suppressed.calls[0]?.text).toContain("suppressed_at = COALESCE");
    expect(suppressed.calls[0]?.text).not.toContain("DELETE");
    expect(restored.calls[0]?.text).toContain("suppressed = FALSE");
    expect(restored.calls[0]?.text).toContain("suppressed_at = NULL");
  });

  it("pins and unpins topics idempotently within a session", async () => {
    const pinned = createStoreWithSql([[{ id: "topic-1" }]]);
    const unpinned = createStoreWithSql([[{ id: "topic-1" }]]);
    await expect(pinned.store.pinTopic("session-1", "topic-1")).resolves.toBe(true);
    await expect(unpinned.store.unpinTopic("session-1", "topic-1")).resolves.toBe(true);
    expect(pinned.calls[0]?.text).toContain("pinned = TRUE");
    expect(pinned.calls[0]?.text).toContain("suppressed = FALSE");
    expect(pinned.calls[0]?.values).toEqual(["topic-1", "session-1"]);
    expect(unpinned.calls[0]?.text).toContain("pinned = FALSE");
    expect(unpinned.calls[0]?.text).toContain("pinned_at = NULL");
  });

  it("excludes forgotten memories and suppressed topics from memory search", async () => {
    const { store, calls } = createStoreWithSql([[]]);

    await expect(store.searchMemories([0.1, 0.2], "session-1", 5, 0.5)).resolves.toEqual([]);

    const sqlText = calls.map((call) => call.text).join("\n");
    expect(sqlText).toContain("JOIN mg_topic_nodes topic");
    expect(sqlText).toContain("memory.forgotten = false");
    expect(sqlText).toContain("topic.suppressed = false");
  });

  it("excludes forgotten memories and suppressed topics from maintenance scans", async () => {
    const { store, calls } = createStoreWithSql([[]]);

    await expect(store.listMemoryNodesForMaintenance()).resolves.toEqual([]);

    expect(calls[0]?.text).toContain("JOIN mg_topic_nodes topic");
    expect(calls[0]?.text).toContain("memory.forgotten = FALSE");
    expect(calls[0]?.text).toContain("topic.suppressed = FALSE");
  });

  it("does not insert a duplicate memory edge", async () => {
    const { store, calls } = createStoreWithSql([[{ id: "edge-1" }]]);

    await expect(store.upsertMemoryEdge({
      sourceId: "memory-a",
      targetId: "memory-b",
      edgeType: "conflicts",
    })).resolves.toBe(false);

    expect(calls).toHaveLength(1);
  });

  it("inserts a memory edge when none exists", async () => {
    const { store, calls } = createStoreWithSql([[], []]);

    await expect(store.upsertMemoryEdge({
      sourceId: "memory-a",
      targetId: "memory-b",
      edgeType: "related",
      weight: 0.7,
    })).resolves.toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).toContain("INSERT INTO mg_memory_edges");
    expect(calls[1]?.values).toEqual(["memory-a", "memory-b", "related", 0.7]);
  });

  it("uses directional lookup for update edges", async () => {
    const { store, calls } = createStoreWithSql([[], []]);

    await store.upsertMemoryEdge({
      sourceId: "new-memory",
      targetId: "old-memory",
      edgeType: "updates",
    });

    expect(calls[0]?.text).not.toContain(" OR ");
    expect(calls[1]?.values).toEqual(["new-memory", "old-memory", "updates", 1]);
  });

  it("uses symmetric lookup for non-update maintenance edges", async () => {
    const { store, calls } = createStoreWithSql([[], []]);
    const edge: Pick<MemoryEdge, "sourceId" | "targetId" | "edgeType"> = {
      sourceId: "memory-a",
      targetId: "memory-b",
      edgeType: "conflicts",
    };

    await store.upsertMemoryEdge(edge);

    expect(calls[0]?.text).toContain(" OR ");
    expect(calls[0]?.values).toEqual(["conflicts", "memory-a", "memory-b", "memory-b", "memory-a"]);
  });

  it("builds chronological memory history from supersession and maintenance edges", async () => {
    const older = makeMemoryRow({
      id: "11111111-1111-1111-1111-111111111111",
      value: "Delhi",
      superseded_by: "22222222-2222-2222-2222-222222222222",
      has_conflict: true,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    });
    const newer = makeMemoryRow({
      id: "22222222-2222-2222-2222-222222222222",
      value: "Bangalore",
      created_at: new Date("2026-01-02T00:00:00.000Z"),
    });
    const updateEdge = makeMemoryEdgeRow();
    const conflictEdge = makeMemoryEdgeRow({
      id: "edge-2",
      source_id: "11111111-1111-1111-1111-111111111111",
      target_id: "22222222-2222-2222-2222-222222222222",
      edge_type: "conflicts",
    });
    const { store, calls } = createStoreWithSql([
      [newer],
      [older, newer],
      [updateEdge, conflictEdge],
      [updateEdge, conflictEdge],
    ]);

    const history = await store.getMemoryHistoryById("22222222-2222-2222-2222-222222222222");

    expect(history.anchorMemoryId).toBe("22222222-2222-2222-2222-222222222222");
    expect(history.currentMemory?.id).toBe("22222222-2222-2222-2222-222222222222");
    expect(history.entries.map((entry) => [entry.memory.id, entry.status])).toEqual([
      ["11111111-1111-1111-1111-111111111111", "superseded"],
      ["22222222-2222-2222-2222-222222222222", "conflicting"],
    ]);
    expect(history.entries[1]?.supersedes).toContain("11111111-1111-1111-1111-111111111111");
    expect(history.entries[0]?.conflictsWith).toContain("22222222-2222-2222-2222-222222222222");
    expect(calls.map((call) => call.text).join("\n")).toContain("regexp_replace");
  });

  it("looks up complete memory history by normalized subject and predicate", async () => {
    const forgotten = makeMemoryRow({
      id: "33333333-3333-3333-3333-333333333333",
      value: "Pune",
      forgotten: true,
      forgotten_at: new Date("2026-01-03T00:00:00.000Z"),
      created_at: new Date("2026-01-03T00:00:00.000Z"),
    });
    const { store, calls } = createStoreWithSql([
      [forgotten],
      [],
    ]);

    const history = await store.getMemoryHistoryByFact(" User ", " Location ", { sessionId: "session-1" });

    expect(history.subject).toBe(" User ");
    expect(history.predicate).toBe(" Location ");
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.status).toBe("forgotten");
    expect(history.currentMemory).toBeNull();
    expect(calls[0]?.values).toEqual(["user", "location", "session-1"]);
  });

  it("returns a structural memory diff with update and conflict relationships", async () => {
    const from = makeMemoryRow({
      id: "11111111-1111-1111-1111-111111111111",
      value: "Delhi",
      superseded_by: "22222222-2222-2222-2222-222222222222",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    });
    const to = makeMemoryRow({
      id: "22222222-2222-2222-2222-222222222222",
      value: "Bangalore",
      created_at: new Date("2026-01-02T00:00:00.000Z"),
    });
    const updateEdge = makeMemoryEdgeRow();
    const conflictEdge = makeMemoryEdgeRow({
      id: "edge-2",
      edge_type: "conflicts",
    });
    const { store } = createStoreWithSql([
      [from],
      [to],
      [updateEdge, conflictEdge],
    ]);

    const diff = await store.getMemoryDiff(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    expect(diff.changedFields.map((field) => field.field)).toContain("value");
    expect(diff.relationship.supersededBy).toBe(true);
    expect(diff.relationship.conflicts).toBe(true);
    expect(diff.relationship.updateEdges).toHaveLength(1);
    expect(diff.relationship.conflictEdges).toHaveLength(1);
  });
});
