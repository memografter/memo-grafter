# Agent event capture (phase one)

MemoGrafter records agent work independently of conversation turns. It does not execute tools.
The event API provides storage without model calls. Optional extraction and working-state APIs
are described in the [agent memory guide](../agent-memory/README.md); agent context retrieval
is planned separately.

Run `npx memo-grafter migrate` once before using the new APIs. The additive migration creates
`mg_agent_identities`, `mg_agent_runs`, and `mg_agent_events`. Existing conversation records
and APIs retain their meaning. Runtime initialization requires the upgraded schema; it does
not perform migrations. Migration ledger version 8 introduced standalone migration 012;
version 11 adds agent memory in migration 015.

## Provider-independent usage

```ts
import { PostgresGraphStore } from "memo-grafter/store";

const store = new PostgresGraphStore(process.env.DATABASE_URL!);
await store.initialize();

// Construct this in trusted server code from the application's authenticated identity.
const runs = store.agentRuns({
  tenantId: "workspace-1",
  agentId: "test-agent",
  projectIds: ["project-1"],
});

try {
  const run = await runs.startRun({
    runId: "job-123-attempt-1", // Persist and reuse this ID when retrying startRun.
    taskId: "job-123",         // A task may have multiple distinct runs.
    objective: "Check the project's tests",
    scope: { kind: "project", projectId: "project-1" }, // Omit for agent-private.
    // sessionId: "conversation-456", // Optional association, not an access grant.
  });

  // Persist each complete event envelope before sending it. Retry the same envelope,
  // including its original timestamp, event ID, and sequence.
  const call = {
    eventId: "call-event-1",
    sequence: 1,
    occurredAt: "2026-09-19T10:00:00.000Z",
    data: {
      type: "tool.call" as const,
      toolCallId: "tool-attempt-1",
      toolName: "run_tests",
      input: { command: "npm test" },
    },
  };
  await runs.recordEvent(run.runId, call);

  // The application's runtime executes the tool and reports its actual result.
  await runs.recordEvent(run.runId, {
    eventId: "result-event-1",
    sequence: 2,
    occurredAt: "2026-09-19T10:01:00.000Z",
    data: {
      type: "tool.result",
      toolCallId: "tool-attempt-1",
      outcome: "success",
      output: { exitCode: 0 },
    },
    source: { uri: "file:///project/test-results.txt", externalId: "trace-123" },
  });

  await runs.completeRun(run.runId, {
    eventId: "completion-event",
    sequence: 3,
    occurredAt: "2026-09-19T10:01:01.000Z",
    outcome: "succeeded",
    summary: "The test command exited successfully.",
  });

  console.log(await runs.getRun(run.runId));
  console.log(await runs.listEvents(run.runId, { afterSequence: -1, limit: 100 }));
} finally {
  await store.close();
}
```

If you already have a `MemoGrafter` instance, use `memo.agentRuns(access)` for the same API.
The storage-only entry point requires neither a model provider nor an embedding provider.

## Ownership and access

- `tenantId` is an application-owned isolation boundary. Agent IDs are persistent within it;
  starting another run reuses the identity. Fleet worker IDs may be reused as agent IDs, but
  existing fleet records are not automatically migrated or granted access.
- `agentId` identifies the current caller. Private runs can be read/written only by that agent.
- `projectIds` is a grant list supplied by the trusted host, not by an LLM or browser request.
  A project-scoped run requires a matching grant for reads and writes, including its owner.
- Other agents with a project grant may read shared runs, but only the originating agent can
  append events or change run status. Sharing is fixed at creation.
- Create a fresh scoped API when authenticated identity or grants change. The API snapshots
  grants at construction; it does not implement user authentication or live grant revocation.
- These checks govern the agent-run APIs. Existing conversation/fleet APIs, direct database
  access, and local Studio remain trusted application/developer interfaces; this is not
  database row-level security. An optional session association grants no conversation access.

## Event and recovery contract

`startRun` atomically records identity, run, and a `task.started` event at sequence 0 with the
reserved ID `$start`. Caller events use positive integer sequence numbers. Run IDs are unique
within a tenant; event IDs and sequences are unique within a run.

Use `recordEvent` for `task.milestone` (`label`, `summary`), `tool.call`, `tool.result`, `observation` (`text`), and `artifact` (`uri`,
optional `description`). Each event requires a timestamp with timezone. Source references are
optional. Tool-call IDs correlate exactly one call with at most one result; a new tool attempt
requires a new tool-call ID. A result may arrive before its call but must have a later sequence.

Delivery may be out of order. Reads sort by sequence, not receipt time. Page with the last
returned sequence as `afterSequence`; the default limit is 100 and maximum is 1000. During an
active run, late arrivals may fall before a previously read cursor, so reread from the last
known contiguous sequence or rescan when the run completes.

Identical event retries return the original record, including after interruption/completion.
Reusing a run ID with different start parameters, or an event ID/sequence with different
content, throws `AgentRunError` with code `CONFLICT`. JSON object key order does not affect
equality. Timestamps are normalized to UTC; all other event content must match.

`interruptRun(runId)` marks an interrupted run explicitly. `resumeRun(runId)` returns it to
running without clearing evidence. A process crash alone does not automatically mark a run
interrupted; the host detects it and decides whether to interrupt or continue the same run.
MemoGrafter does not replay tools or determine whether an external side effect occurred.

`completeRun` atomically appends `task.completed`, `task.failed`, or `task.cancelled` and seals
the run. Completion requires contiguous sequences from zero, and every tool result must
reference an earlier call. Successful runs must have results for all calls; failed/cancelled
runs may retain pending calls. Resume an interrupted run before completing it. Terminal runs
cannot be reopened; start a new run for another attempt. Recorded success is a host report,
not independent verification by MemoGrafter.

Common credential fields are redacted before persistence; configure a deterministic `redactText`
hook for application-specific sensitive data. Tool inputs/outputs larger than 16,000 characters
are stored as bounded previews and digests; configure `maxToolPayloadChars` to adjust this.
Retries compare the sanitized event. Raw originals are not retained. See the agent memory guide
for limits and the treatment of truncated evidence.

Payloads must be plain JSON (no dates, maps, cycles, or non-finite numbers) and at most 256 KiB
per event, with nesting limited to 64 levels. IDs are limited to 256 UTF-8 bytes; descriptive
strings are limited to 16,384 characters. Null characters are not supported. Redact secrets before submission and
reference large artifacts rather than embedding their contents. References are stored only;
MemoGrafter does not fetch them. Phase one stores no internal reasoning or hidden model state
unless your application explicitly places that content in an event.

Errors use `AgentRunError.code`: `INVALID_INPUT`, `NOT_FOUND` (also inaccessible runs),
`ACCESS_DENIED`, `CONFLICT`, `INVALID_STATE`, or `INCOMPLETE_HISTORY`. Database failures retain
their underlying errors; after an uncertain write, retry with the original IDs and payload.

## Database integration tests

For a narrated manual end-to-end check against your migrated database, run
`npm run manual:agent-runs`. See the [manual test guide](../../tests/manual/agent-runs.md)
for expected output, scenarios, and the optional `--keep-data` inspection mode.

Set `MEMOGRAFTER_AGENT_TEST_DB` to a disposable PostgreSQL database URL and run
`npm run test:run -- tests/unit/agent/AgentRunStore.integration.test.ts`.
The tests create and remove a unique schema, exercise concurrent writers and isolation,
and require no provider credentials or pgvector extension. Without that variable, these
integration tests are skipped; validation and existing regression tests still run.
