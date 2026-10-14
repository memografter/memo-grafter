/** npm run manual:agent-memory -- [--keep-data] [--skip-concurrency]. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { AgentRunError, PostgresGraphStore, type AgentMemoryCandidate, type AgentMemoryOptions } from "../../src/store/index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: npm run manual:agent-memory -- [--keep-data] [--skip-concurrency]\nRequires DATABASE_URL pointing to a disposable PostgreSQL database with pgvector.\nCreates/migrates a unique schema and drops it afterward unless --keep-data is supplied. No model keys needed.\n--skip-concurrency is for embedded database emulators; skipped checks are reported explicitly.");
    return;
  }
  assert.ok(args.every(arg => ["--keep-data", "--skip-concurrency"].includes(arg)), "Unknown argument. Use --help.");
  assert.ok(process.env.DATABASE_URL, "Set DATABASE_URL in .env.");
  const schema = `mg_agent_manual_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 5, onnotice: () => undefined });
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("search_path", `${schema},public`);
  const scopedUrl = url.toString();
  const sql = postgres(scopedUrl, { max: 1, connect_timeout: 5, onnotice: () => undefined });
  const store = new PostgresGraphStore(scopedUrl);
  const access = { tenantId: "manual-tenant", agentId: "owner", projectIds: ["project"] };
  const occurredAt = new Date().toISOString();
  let created = false, passed = 0, modelCalls = 0;
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    console.log(`PASS ${++passed}: ${name}`);
  };
  const rejects = (action: () => Promise<unknown>, code: string) =>
    assert.rejects(action, error => error instanceof AgentRunError && error.code === code);
  const candidate = (changes: Partial<AgentMemoryCandidate> = {}): AgentMemoryCandidate => ({
    kind: "fact", subject: "fixture project", predicate: "test command", value: "npm test",
    basis: "observed-success", conditions: ["fixture v1"], evidenceEventIds: ["call", "result"],
    quality: { explicitness: 0.9, sourceReliability: 0.8, stability: 0.9, salience: 0.8 }, ...changes,
  });
  const adapters = (memories: AgentMemoryCandidate[] = [candidate()], supported = true): AgentMemoryOptions => ({
    // Intentionally controlled responses test admission/persistence, not model accuracy.
    llm: { complete: async (_messages, system) => {
      modelCalls++;
      return JSON.stringify(system?.startsWith("Independently")
        ? { supported: memories.map(() => supported) }
        : { summary: "Synthetic tool attempt and observed outcome; host completion is a claim.", memories });
    } },
    embedder: { dimensions: 1536, embed: async () => [1, ...Array<number>(1535).fill(0)] },
    maxToolPayloadChars: 512,
    redactText: text => text.replaceAll("PRIVATE_CUSTOMER", "[REDACTED]"),
  });
  type API = ReturnType<PostgresGraphStore["agentRuns"]>;
  const fixture = async (api: API, runId: string, outcome: "success" | "failure" = "success", shared = false, large = false) => {
    await api.startRun({ runId, taskId: runId, objective: "Inspect fixture v1", ...(shared ? { scope: { kind: "project" as const, projectId: "project" } } : {}) });
    await api.recordEvent(runId, { eventId: "call", sequence: 1, occurredAt,
      data: { type: "tool.call", toolCallId: "c", toolName: "read_config", input: { file: "package.json", apiKey: "fixture-secret" } } });
    await api.recordEvent(runId, { eventId: "result", sequence: 2, occurredAt,
      data: { type: "tool.result", toolCallId: "c", outcome,
        output: large ? "x".repeat(4000) : { testCommand: "npm test", environment: "fixture v1", status: outcome, log: "PRIVATE_CUSTOMER", token: "fixture-token" } },
      source: { uri: "fixture://config/report" } });
    await api.completeRun(runId, { eventId: "done", sequence: 3, occurredAt,
      outcome: outcome === "success" ? "succeeded" : "failed", summary: "Host reports task finished" });
  };
  console.log(`Agent memory manual validation\nDisposable schema: ${schema}`);
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    created = true;
    const [namespace] = await sql<{ name: string }[]>`SELECT current_schema() AS name`;
    assert.equal(namespace?.name, schema, "Database driver must honor the isolated schema before migrations run");
    await store.migrate();
    await store.initialize();
    const api = store.agentRuns(access, adapters());

    await check("working state is revisioned, redacted and separate from durable memory", async () => {
      await api.startRun({ runId: "state", taskId: "state", objective: "Inspect" });
      const input = { expectedRevision: 0, state: { objective: "Inspect", currentStep: "PRIVATE_CUSTOMER", pendingActions: ["Read config"], blockers: [] } };
      const saved = await api.updateWorkingState("state", input);
      assert.equal(saved.revision, 1);
      assert.equal(saved.state.currentStep, "[REDACTED]");
      assert.deepEqual(await api.updateWorkingState("state", input), saved);
      await rejects(() => api.updateWorkingState("state", { ...input, state: { ...input.state, currentStep: "Changed" } }), "CONFLICT");
      assert.equal((await api.listMemories({ runId: "state" })).length, 0);
      await api.completeRun("state", { eventId: "done", sequence: 1, occurredAt, outcome: "succeeded", summary: "Done" });
      assert.deepEqual(await api.updateWorkingState("state", input), saved);
      await rejects(() => api.updateWorkingState("state", { ...input, expectedRevision: 1 }), "INVALID_STATE");
    });

    await check("completion produces a conditional fact with event and artifact evidence", async () => {
      await fixture(api, "success");
      const [episode] = await api.processRun("success");
      assert.equal(episode?.reportedOutcome, "host-reported-succeeded");
      const [saved] = await api.listMemories({ runId: "success" });
      assert.equal(saved?.memory.sourceType, "agent");
      assert.deepEqual(saved?.evidence[0]?.eventIds, ["call", "result"]);
      assert.deepEqual(saved?.evidence[0]?.conditions, ["fixture v1"]);
      assert.deepEqual(saved?.evidence[0]?.artifactUris, ["fixture://config/report"]);
      assert.ok(!/fixture-secret|fixture-token|PRIVATE_CUSTOMER/.test(JSON.stringify(await api.listEvents("success"))));
      console.table([{ episode: episode!.id, memory: saved!.memory.id, basis: saved!.evidence[0]!.basis }]);
    });

    await check("retries and reconnects reuse episodes without further model calls", async () => {
      const first = await api.listEpisodes("success"), calls = modelCalls;
      const reopened = new PostgresGraphStore(scopedUrl);
      try { assert.deepEqual(await reopened.agentRuns(access, adapters()).processRun("success"), first); }
      finally { await reopened.close(); }
      assert.equal(modelCalls, calls);
      assert.equal((await api.listMemories({ runId: "success" }))[0]?.memory.reinforcementCount, 1);
    });

    if (args.includes("--skip-concurrency")) console.log("SKIP: concurrent processing (requires real PostgreSQL)");
    else await check("concurrent processors commit one episode and one reinforcement", async () => {
      const concurrent = store.agentRuns({ ...access, agentId: "concurrent" }, adapters());
      await fixture(concurrent, "concurrent");
      const [a, b] = await Promise.all([concurrent.processRun("concurrent"), concurrent.processRun("concurrent")]);
      assert.deepEqual(a, b);
      assert.equal(a.length, 1);
      assert.equal((await concurrent.listMemories())[0]?.memory.reinforcementCount, 1);
    });

    await check("claims, failed facts, missing conditions and ungrounded proposals are rejected", async () => {
      const cases = [
        { name: "claim", memory: candidate({ evidenceEventIds: ["call", "done"] }), outcome: "success" as const },
        { name: "failed-fact", memory: candidate(), outcome: "failure" as const },
        { name: "unconditional", memory: candidate({ conditions: [] }), outcome: "success" as const },
        { name: "ungrounded", memory: candidate({ value: "All tests passed" }), outcome: "success" as const },
      ];
      for (const item of cases) {
        const rejected = store.agentRuns(access, adapters([item.memory], item.name !== "ungrounded"));
        await fixture(rejected, item.name, item.outcome);
        assert.equal((await rejected.processRun(item.name))[0]?.rejectedCandidates, 1);
        assert.equal((await rejected.listMemories({ runId: item.name })).length, 0);
      }
    });

    await check("failed actions can produce conditional failure lessons", async () => {
      const failed = store.agentRuns(access, adapters([candidate({ kind: "lesson", basis: "observed-failure", value: "Configuration read failed" })]));
      await fixture(failed, "failure-lesson", "failure");
      await failed.processRun("failure-lesson");
      const [memory] = await failed.listMemories({ runId: "failure-lesson" });
      assert.equal(memory?.memory.memoryType, "insight");
      assert.equal(memory?.evidence[0]?.basis, "observed-failure");
    });

    await check("large tool output is bounded and cannot support a durable fact", async () => {
      await fixture(api, "large", "success", false, true);
      const event = (await api.listEvents("large")).find(e => e.eventId === "result")!;
      assert.ok(JSON.stringify(event).includes('"truncated":true'));
      assert.ok(JSON.stringify(event).length < 1500);
      assert.equal((await api.processRun("large"))[0]?.rejectedCandidates, 1);
      assert.equal((await api.listMemories({ runId: "large" })).length, 0);
    });

    await check("milestones keep pending calls with their outcomes", async () => {
      const milestone = store.agentRuns(access, adapters([]));
      await milestone.startRun({ runId: "milestone", taskId: "m", objective: "Inspect" });
      await milestone.recordEvent("milestone", { eventId: "call", sequence: 1, occurredAt, data: { type: "tool.call", toolCallId: "c", toolName: "read", input: {} } });
      await milestone.recordEvent("milestone", { eventId: "pending", sequence: 2, occurredAt, data: { type: "task.milestone", label: "Attempt", summary: "Pending" } });
      await rejects(() => milestone.processRun("milestone", { throughSequence: 2 }), "INCOMPLETE_HISTORY");
      await milestone.recordEvent("milestone", { eventId: "result", sequence: 3, occurredAt, data: { type: "tool.result", toolCallId: "c", outcome: "success", output: {} } });
      await milestone.recordEvent("milestone", { eventId: "safe", sequence: 4, occurredAt, data: { type: "task.milestone", label: "Observed", summary: "Result available" } });
      await milestone.processRun("milestone", { throughSequence: 4 });
      await milestone.completeRun("milestone", { eventId: "done", sequence: 5, occurredAt, outcome: "succeeded", summary: "Done" });
      assert.deepEqual((await milestone.processRun("milestone")).map(e => [e.startSequence, e.endSequence]), [[0, 4], [5, 5]]);
    });

    await check("project grants allow reads; tenant boundaries and owner-only writes hold", async () => {
      await fixture(api, "shared", "success", true);
      const [episode] = await api.processRun("shared");
      const peer = store.agentRuns({ ...access, agentId: "peer" });
      const [memory] = await peer.listMemories({ runId: "shared" });
      assert.ok(memory);
      await rejects(() => peer.processRun("shared"), "ACCESS_DENIED");
      await rejects(() => peer.forgetAgentMemory(memory.memory.id), "ACCESS_DENIED");
      await rejects(() => peer.listEpisodes("success"), "NOT_FOUND");
      assert.equal((await store.agentRuns({ ...access, tenantId: "other" }).listMemories()).length, 0);
      assert.equal((await store.agentRuns({ tenantId: access.tenantId, agentId: "ungranted" }).listMemories()).length, 0);
      await api.suppressEpisode(episode!.id);
      assert.equal((await peer.listMemories({ runId: "shared" })).length, 0);
      await api.restoreEpisode(episode!.id);
      assert.equal((await peer.listMemories({ runId: "shared" })).length, 1);
      await api.forgetAgentMemory(memory.memory.id);
      await api.processRun("shared");
      assert.equal((await peer.listMemories({ runId: "shared" })).length, 0);
      assert.equal((await api.listMemories({ runId: "shared", includeInactive: true }))[0]?.memory.forgotten, true);
    });

    await check("evidence-write failure rolls back graph rows and remains retryable", async () => {
      const rollback = store.agentRuns({ ...access, agentId: "rollback" }, adapters());
      await fixture(rollback, "rollback");
      await sql.unsafe("ALTER TABLE mg_agent_memory_links ADD CONSTRAINT manual_reject CHECK (kind <> 'fact') NOT VALID");
      try {
        await assert.rejects(() => rollback.processRun("rollback"));
        assert.equal((await rollback.listEpisodes("rollback")).length, 0);
        assert.equal((await sql`SELECT id FROM mg_topic_nodes WHERE agent_id='rollback'`).length, 0);
      } finally { await sql.unsafe("ALTER TABLE mg_agent_memory_links DROP CONSTRAINT manual_reject"); }
      assert.equal((await rollback.processRun("rollback")).length, 1);
    });
    console.log(`${passed} manual checks passed; ${args.includes("--skip-concurrency") ? 1 : 0} skipped. No external model or tool calls were made.`);
  } finally {
    await store.close();
    await sql.end({ timeout: 5 });
    try {
      if (created && !args.includes("--keep-data")) {
        await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        console.log(`Removed test schema ${schema}.`);
      } else if (created) console.log(`Kept schema ${schema}; remove it after inspection.`);
    } finally { await admin.end({ timeout: 5 }); }
  }
}

main().catch(error => {
  console.error(error instanceof AgentRunError || error instanceof assert.AssertionError
    ? `FAIL: ${error.message}` : "FAIL: Database/setup operation failed. Check PostgreSQL, pgvector, DATABASE_URL and schema permissions.");
  process.exitCode = 1;
});
