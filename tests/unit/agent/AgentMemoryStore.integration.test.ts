import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresGraphStore } from "../../../src/store/index.js";
import type { AgentMemoryOptions } from "../../../src/agents/runs/memoryTypes.js";
import { agentMemoryMigrationSql } from "../../../src/schema/agentMemoryMigration.js";

// Explicit opt-in. The configured database is used only to host a unique, disposable schema.
describe.skipIf(process.env.MEMOGRAFTER_AGENT_MEMORY_TESTS !== "1")("agent memory on PostgreSQL/pgvector", () => {
  const schema = `mg_agent_memory_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Sql;
  let sql: Sql;
  let store: PostgresGraphStore;
  let scopedUrl: string;
  const access = { tenantId: "tenant-a", agentId: "agent-a", projectIds: ["p"] };
  const occurredAt = "2026-09-24T00:00:00Z";
  const options = (value = "npm test", supported = true): AgentMemoryOptions => ({
    llm: { complete: vi.fn(async (_messages, system) => system?.startsWith("Independently") ? JSON.stringify({ supported: [supported] }) : JSON.stringify({ summary: "Observed project config from read_config.", memories: [{
      kind: "fact", subject: "project", predicate: "test command", value, basis: "observed-success", conditions: ["project v1"], evidenceEventIds: ["call", "result"],
      quality: { explicitness: 0.9, sourceReliability: 0.8, stability: 0.9, salience: 0.8 },
    }] })) }, embedder: { embed: async () => [1, ...Array<number>(1535).fill(0)], dimensions: 1536 },
  });
  const completeFixture = async (api: ReturnType<PostgresGraphStore["agentRuns"]>, runId = randomUUID(), project = false) => {
    await api.startRun({ runId, taskId: "task", objective: "Inspect project", ...(project ? { scope: { kind: "project" as const, projectId: "p" } } : {}) });
    await api.recordEvent(runId, { eventId: "call", sequence: 1, occurredAt, data: { type: "tool.call", toolCallId: "c", toolName: "read_config", input: { apiKey: "sensitive", file: "package.json" } } });
    await api.recordEvent(runId, { eventId: "result", sequence: 2, occurredAt, data: { type: "tool.result", toolCallId: "c", outcome: "success", output: { testCommand: "npm test" } }, source: { uri: "fixture://config" } });
    await api.completeRun(runId, { eventId: "done", sequence: 3, occurredAt, outcome: "succeeded", summary: "Host reports complete" });
    return runId;
  };
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("search_path", `${schema},public`);
    scopedUrl = url.toString();
    sql = postgres(scopedUrl, { max: 1, onnotice: () => undefined });
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema);
    store = new PostgresGraphStore(scopedUrl);
    await store.migrate();
    await store.initialize();
    await sql.unsafe(agentMemoryMigrationSql);
  }, 60000);
  afterAll(async () => {
    await store?.close(); await sql?.end();
    if (admin) { await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("updates working state with revision checks without creating graph memory", async () => {
    const api = store.agentRuns(access);
    const runId = randomUUID();
    await api.startRun({ runId, taskId: "state", objective: "Work" });
    const input = { expectedRevision: 0, state: { objective: "Work", currentStep: "Inspect", pendingActions: ["Run tests"], blockers: [] } };
    const saved = await api.updateWorkingState(runId, input);
    expect(saved.revision).toBe(1);
    expect(await api.updateWorkingState(runId, input)).toEqual(saved);
    await expect(api.updateWorkingState(runId, { ...input, state: { ...input.state, objective: "changed" } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await api.listMemories({ runId })).toHaveLength(0);
    await expect(store.agentRuns({ ...access, agentId: "other" }).updateWorkingState(runId, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await api.completeRun(runId, { eventId: "done", sequence: 1, occurredAt, outcome: "succeeded", summary: "Done" });
    expect(await api.updateWorkingState(runId, input)).toEqual(saved);
    await expect(api.updateWorkingState(runId, { ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("persists episodes, graph memory, evidence and conditions atomically; retries do not reinforce", async () => {
    const config = options(); const api = store.agentRuns(access, config);
    const runId = await completeFixture(api);
    const first = await api.processRun(runId);
    expect(await api.processRun(runId)).toEqual(first); expect(first).toHaveLength(1);
    const memories = await api.listMemories({ runId });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.memory.sourceType).toBe("agent");
    expect(memories[0]?.evidence[0]).toMatchObject({ runId, eventIds: ["call", "result"], conditions: ["project v1"], artifactUris: ["fixture://config"] });
    const calls = vi.mocked(config.llm!.complete).mock.calls.length;
    await api.processRun(runId);
    expect(vi.mocked(config.llm!.complete).mock.calls).toHaveLength(calls);
    expect((await api.listMemories({ runId }))[0]?.memory.reinforcementCount).toBe(memories[0]?.memory.reinforcementCount);
    const reopened = new PostgresGraphStore(scopedUrl);
    try { expect(await reopened.agentRuns(access).listEpisodes(runId)).toEqual(first); }
    finally { await reopened.close(); }
    const events = await api.listEvents(runId);
    expect(JSON.stringify(events)).not.toContain("sensitive");
  });

  // PGlite's socket multiplexer cannot reliably isolate concurrent extended-protocol portals.
  // Keep this check enabled for real PostgreSQL; do not interpret an embedded run as concurrency validation.
  it.skipIf(process.env.MEMOGRAFTER_EMBEDDED_DB === "1")("serializes concurrent processing without duplicating episodes or reinforcement", async () => {
    const api = store.agentRuns({ ...access, agentId: "concurrent" }, options());
    const runId = await completeFixture(api);
    const [first, second] = await Promise.all([api.processRun(runId), api.processRun(runId)]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    const memories = await api.listMemories({ runId });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.memory.reinforcementCount).toBe(1);
  });

  it("retains unsupported claims in episodes but not in durable facts", async () => {
    const api = store.agentRuns(access, options("unverified", false));
    const runId = await completeFixture(api);
    const episodes = await api.processRun(runId);
    expect(episodes[0]?.rejectedCandidates).toBe(1);
    expect(await api.listMemories({ runId })).toHaveLength(0);
  });

  it("rolls back graph rows when an evidence-link write fails, then allows retry", async () => {
    const api = store.agentRuns({ ...access, agentId: "rollback" }, options());
    const runId = await completeFixture(api);
    await sql.unsafe("ALTER TABLE mg_agent_memory_links ADD CONSTRAINT test_reject CHECK (kind <> 'fact') NOT VALID");
    try {
      await expect(api.processRun(runId)).rejects.toThrow();
      expect(await api.listEpisodes(runId)).toHaveLength(0);
      const rows = await sql`SELECT 1 FROM mg_topic_nodes WHERE agent_id='rollback'`;
      expect(rows).toHaveLength(0);
    } finally { await sql.unsafe("ALTER TABLE mg_agent_memory_links DROP CONSTRAINT test_reject"); }
    expect(await api.processRun(runId)).toHaveLength(1);
  });

  it("uses existing canonical reinforcement, conflict and supersession semantics across runs", async () => {
    const identity = { ...access, agentId: "lifecycle" };
    const first = store.agentRuns(identity, options());
    const a = await completeFixture(first); await first.processRun(a);
    const b = await completeFixture(first); await first.processRun(b);
    expect(await first.listMemories()).toHaveLength(1);
    const second = store.agentRuns(identity, options("pnpm test"));
    const c = await completeFixture(second); await second.processRun(c);
    expect(await second.listMemories()).toHaveLength(0);
    expect((await second.listMemories({ includeInactive: true })).every(m => m.memory.hasConflict)).toBe(true);
    const updated = store.agentRuns(identity, options("changed to bun test"));
    const d = await completeFixture(updated); await updated.processRun(d);
    expect(await updated.listMemories()).toHaveLength(1);
    const all = await updated.listMemories({ includeInactive: true });
    expect(all.filter(m => m.memory.supersededBy !== null)).toHaveLength(2);
    const current = (await updated.listMemories())[0]!;
    await updated.forgetAgentMemory(current.memory.id);
    expect(await updated.listMemories()).toHaveLength(0);
    expect((await updated.listMemories({ includeInactive: true })).find(m => m.memory.id === current.memory.id)?.memory.forgotten).toBe(true);
  });

  it("applies project read grants and owner-only lifecycle changes without cross-tenant access", async () => {
    const api = store.agentRuns({ ...access, agentId: "shared-owner" }, options());
    const runId = await completeFixture(api, randomUUID(), true);
    const [episode] = await api.processRun(runId);
    const peer = store.agentRuns({ ...access, agentId: "peer" });
    const [memory] = await peer.listMemories({ runId });
    expect(memory).toBeDefined();
    await expect(peer.forgetAgentMemory(memory!.memory.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(peer.suppressEpisode(episode!.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await store.agentRuns({ ...access, tenantId: "other-tenant" }).listMemories()).toHaveLength(0);
    expect(await store.agentRuns({ tenantId: access.tenantId, agentId: "no-grants" }).listMemories()).toHaveLength(0);
    await api.suppressEpisode(episode!.id);
    expect(await peer.listMemories({ runId })).toHaveLength(0);
    await api.restoreEpisode(episode!.id);
    expect(await peer.listMemories({ runId })).toHaveLength(1);
  });

  it("processes safe milestones incrementally and merges boundaries that split tool calls", async () => {
    const api = store.agentRuns({ ...access, agentId: "milestones" }, options());
    const runId = randomUUID(); await api.startRun({ runId, taskId: "m", objective: "Work" });
    await api.recordEvent(runId, { eventId: "call", sequence: 1, occurredAt, data: { type: "tool.call", toolCallId: "c", toolName: "read", input: {} } });
    await api.recordEvent(runId, { eventId: "unsafe", sequence: 2, occurredAt, data: { type: "task.milestone", label: "Started", summary: "Still working" } });
    await expect(api.processRun(runId, { throughSequence: 2 })).rejects.toMatchObject({ code: "INCOMPLETE_HISTORY" });
    await api.recordEvent(runId, { eventId: "result", sequence: 3, occurredAt, data: { type: "tool.result", toolCallId: "c", outcome: "success", output: { command: "npm test" } } });
    await api.recordEvent(runId, { eventId: "safe", sequence: 4, occurredAt, data: { type: "task.milestone", label: "Read", summary: "Configuration read" } });
    expect((await api.processRun(runId, { throughSequence: 4 })).map(e => [e.startSequence, e.endSequence])).toEqual([[0, 4]]);
    await api.completeRun(runId, { eventId: "done", sequence: 5, occurredAt, outcome: "succeeded", summary: "Done" });
    expect((await api.processRun(runId)).map(e => [e.startSequence, e.endSequence])).toEqual([[0, 4], [5, 5]]);
  });

  it("rejects orphan or reversed tool results at a milestone before making model calls", async () => {
    const config = options();
    const api = store.agentRuns(access, config);
    const runId = randomUUID();
    await api.startRun({ runId, taskId: "orphan", objective: "Work" });
    await api.recordEvent(runId, { eventId: "result", sequence: 1, occurredAt, data: { type: "tool.result", toolCallId: "c", outcome: "success", output: {} } });
    await api.recordEvent(runId, { eventId: "boundary", sequence: 2, occurredAt, data: { type: "task.milestone", label: "Claim", summary: "Done" } });
    await expect(api.processRun(runId, { throughSequence: 2 })).rejects.toMatchObject({ code: "INCOMPLETE_HISTORY" });
    expect(config.llm!.complete).not.toHaveBeenCalled();
    expect(await api.listEpisodes(runId)).toHaveLength(0);
  });

  it("preserves all evidence when two candidates canonicalize to one memory", async () => {
    const config = options();
    const extract = await config.llm!.complete([], "extract");
    const response = JSON.parse(extract);
    response.memories.push({ ...response.memories[0], evidenceEventIds: ["call2", "result2"] });
    config.llm = { complete: async (_messages, system) => system?.startsWith("Independently")
      ? JSON.stringify({ supported: [true, true] }) : JSON.stringify(response) };
    const api = store.agentRuns({ ...access, agentId: "duplicate-evidence" }, config);
    const runId = randomUUID();
    await api.startRun({ runId, taskId: "duplicate", objective: "Inspect twice" });
    for (const [index, suffix] of ["", "2"].entries()) {
      await api.recordEvent(runId, { eventId: `call${suffix}`, sequence: index * 2 + 1, occurredAt,
        data: { type: "tool.call", toolCallId: `c${suffix}`, toolName: "read", input: {} } });
      await api.recordEvent(runId, { eventId: `result${suffix}`, sequence: index * 2 + 2, occurredAt,
        data: { type: "tool.result", toolCallId: `c${suffix}`, outcome: "success", output: { command: "npm test" } }, source: { uri: `fixture://result${suffix}` } });
    }
    await api.completeRun(runId, { eventId: "done", sequence: 5, occurredAt, outcome: "succeeded", summary: "Done" });
    await api.processRun(runId);
    const memories = await api.listMemories({ runId });
    expect(memories).toHaveLength(1);
    expect(memories[0]!.evidence[0]!.eventIds.sort()).toEqual(["call", "call2", "result", "result2"]);
    expect(memories[0]!.evidence[0]!.artifactUris.sort()).toEqual(["fixture://result", "fixture://result2"]);
  });
});
