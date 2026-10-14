# Agent memory: phase two

Agent events can now become task episodes and durable, conditional memories. The three layers
have different lifetimes: working state is mutable and local to a run; episodes retain accounts
of attempts and outcomes; durable facts/lessons can be inspected across authorized runs.

Apply the additive migration with `npx memo-grafter migrate` before upgrading application
instances (schema ledger version 11, standalone migration 015). Existing conversations retain
their behavior. Provider-free event capture remains available from `memo-grafter/store`.

## Usage

```ts
// memo is an initialized MemoGrafter instance with its normal LLM and embedding adapters.
const runs = memo.agentRuns(
  { tenantId: "workspace", agentId: "builder", projectIds: ["project"] },
  { redactText: text => text.replaceAll("internal-secret-value", "[REDACTED]") },
);

await runs.startRun({
  runId: "inspect-1", taskId: "inspect-config", objective: "Inspect project configuration",
  scope: { kind: "project", projectId: "project" },
});

await runs.updateWorkingState("inspect-1", {
  expectedRevision: 0, // Start at zero; later writes use getWorkingState().revision.
  state: { objective: "Inspect project configuration", currentStep: "Read configuration",
    pendingActions: ["Check the test command"], blockers: [] },
});

// The host records the actual tool invocation and result. These are illustrative fixtures.
await runs.recordEvent("inspect-1", {
  eventId: "call", sequence: 1, occurredAt: "2026-09-24T10:00:00Z",
  data: { type: "tool.call", toolCallId: "read-1", toolName: "read_config",
    input: { path: "package.json", revision: "abc123" } },
});
await runs.recordEvent("inspect-1", {
  eventId: "result", sequence: 2, occurredAt: "2026-09-24T10:00:01Z",
  data: { type: "tool.result", toolCallId: "read-1", outcome: "success",
    output: { project: "example", revision: "abc123", testCommand: "npm test" } },
  source: { uri: "artifact://config-at-abc123" },
});
await runs.recordEvent("inspect-1", {
  eventId: "milestone", sequence: 3, occurredAt: "2026-09-24T10:00:02Z",
  data: { type: "task.milestone", label: "Configuration inspected", summary: "Read config successfully" },
});

// Explicit processing keeps extraction costs and failures out of event capture.
await runs.processRun("inspect-1", { throughSequence: 3 });

await runs.completeRun("inspect-1", {
  eventId: "done", sequence: 4, occurredAt: "2026-09-24T10:00:03Z",
  outcome: "succeeded", summary: "Host reports that configuration inspection completed",
});
await runs.processRun("inspect-1"); // Processes only the uncommitted final episode.

console.log(await runs.listEpisodes("inspect-1"));
console.log(await runs.listMemories({ runId: "inspect-1" }));
console.log(await runs.listMemories()); // Authorized memories across runs.
```

For storage-only applications, pass adapters explicitly:

```ts
const runs = store.agentRuns(access, { llm, embedder, redactText, maxToolPayloadChars: 16000 });
```

No adapters are needed for event capture, working-state operations, inspection, or lifecycle
controls. `processRun()` requires both adapters. Embeddings must match the existing graph
schema (1536 dimensions in the bundled schema).

## Evidence and extraction

Each episode uses a dedicated extraction prompt over structured events, without fake chat
turns or conversational drift detection. Milestones and terminal events define boundaries.
A milestone with a pending tool call is merged into a later safe boundary so its call/result
pair stays together. Explicit processing of that unfinished milestone fails until a later
boundary is available. Event prefixes must be contiguous.

The extractor proposes at most 20 memories per episode. A deterministic gate requires known
evidence event IDs, a matching earlier tool call, an observed result of the correct kind,
applicability conditions, and adequate quality. Facts require successful tool evidence;
failure results can support conditional failure lessons. An independent LLM grounding pass
then checks the entire claim and its conditions against the supplied evidence. Unsupported
candidates are rejected; episodes expose `rejectedCandidates` for inspection.

An observation saying “it worked,” a completion event, or an artifact URI alone cannot create
a durable fact. Artifact contents are never fetched. Attempts and host-reported completion
remain in event history; `reportedOutcome` is explicitly labeled as a host report. Episode
summaries are model-generated accounts, not independently verified ground truth. Grounding
is model-based evidence review, not a guarantee that a tool or external source is truthful.

Conditions are required for both facts and lessons. They appear in evidence metadata and
in the graph predicate, so different environments and failure/success outcomes are not
silently merged. Lessons use the existing `insight` memory type. All extracted memories use
`sourceType: "agent"` and the normal quality, canonicalization, conflict, supersession, decay,
and forgetting infrastructure.

Every memory has event IDs, run ID, episode ID, conditions, evidence basis, and any cited
artifact/source URIs. Graph provenance uses empty message indexes because these are agent
events, not conversation turns. Internal graph segment ranges are event offsets in a separate
agent memory namespace; `startSequence`/`endSequence` are the originating run's real positions.

## Reliability and lifecycle

- Working-state updates use optimistic revisions. Identical immediate retries succeed;
  stale revisions fail. Terminal state is immutable. Working state is not automatically
  promoted into long-term memory, and each new run starts without working state.
- LLM extraction and embeddings happen before opening a write transaction. An episode's
  graph rows, canonical memories, and evidence references commit atomically. If extraction
  or persistence fails, retry `processRun()`. Earlier committed episodes remain available.
- Concurrent processing may duplicate model calls but cannot duplicate committed episodes
  or reinforcement evidence. A retry skips already committed boundaries, including after
  forgetting or suppression; it does not rebuild them or resurrect their memories.
- `forgetAgentMemory(memoryId)` uses existing soft-forgetting semantics.
  `suppressEpisode(episodeId)` and `restoreEpisode(episodeId)` control the episode's topic.
  `listMemories()` excludes forgotten, decayed, superseded, conflicting, and suppressed
  memories. Use `{ includeInactive: true }` for audit/history inspection.
- Canonicalization can reinforce equivalent memories across runs, flag conflicting values,
  and supersede earlier values when supported explicit correction wording is present.
  A newly observed fact in a new run may create a new memory after an older one was forgotten,
  consistent with existing lifecycle semantics.

## Access, redaction, and limits

The host supplies authenticated `tenantId`, `agentId`, and project grants. Private and
project scopes remain isolated, and only the owning agent can update working state, process
its runs, forget memories, or suppress episodes. Other authorized project agents can read.
Graph namespaces include tenant, owning agent, and scope, so reinforcement cannot change
another agent's memory. Cross-agent merging is deferred to the collaboration phase.

These guarantees apply to scoped agent APIs. Direct SQL, existing unrestricted graph methods,
and local Studio are trusted developer interfaces, not an authentication boundary. Never
expose them as unrestricted application endpoints. Changing grants requires creating a fresh
scoped API. Caller-provided session associations confer no additional access.

Common credential keys, bearer tokens, credential URLs, and simple secret assignments are
redacted before storage. Configure a deterministic, idempotent `redactText` hook for your
application's sensitive text. It applies to descriptive content, not routing IDs; never put
secrets in IDs. These heuristics are not a comprehensive data-loss-prevention system. Existing
stored events are not rewritten, but are sanitized before model processing.

Tool payloads over `maxToolPayloadChars` (default 16000, configurable 256–64000) become a preview,
digest, and truncation marker before persistence. Memories based on truncated calls/results
are rejected. Use artifact references for large output. The original event still has the
phase-one 256 KiB input ceiling. Processing is bounded to 10000 events per run and 1000 events/
128000 characters per episode; emit smaller tool outputs and meaningful milestones for long work.
Memory listing defaults to 100 rows, maximum 1000, ordered by ID; it is an inspection API,
not relevance-ranked retrieval. Phase three will add task-aware agent context.

## Tests

Run `npm run manual:agent-memory` for an executable validation against PostgreSQL/pgvector.
See [the manual test guide](../../tests/manual/agent-memory.md) for setup, expected results,
inspection queries, and cleanup. It uses deterministic adapters and makes no paid model calls.

`npm run test:run` includes deterministic extraction/redaction regression tests. For database
tests, enable `MEMOGRAFTER_AGENT_MEMORY_TESTS=1` and provide `DATABASE_URL` for PostgreSQL with
pgvector support:

```powershell
$env:MEMOGRAFTER_AGENT_MEMORY_TESTS = '1'
node --env-file=.env node_modules/vitest/vitest.mjs run tests/unit/agent/AgentMemoryStore.integration.test.ts
```

Database tests migrate a uniquely named schema and drop only that schema afterward. They cover
working-state revisions, evidence admission, rollback, concurrent processing, restart/retry,
cross-run lifecycle controls, project access, and milestone boundaries. Model and embedding
responses in these tests are controlled fixtures; no paid provider calls are made.
