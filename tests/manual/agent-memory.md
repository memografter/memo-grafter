# Agent execution memory: manual validation

This validates phase two through the public `PostgresGraphStore.agentRuns()` API using
synthetic events, deterministic model responses, and real PostgreSQL/pgvector. It makes
no provider calls and executes no agent tools. It tests the processing and persistence
contract; it does **not** establish extraction accuracy for a production model.

## Setup and run

1. Install dependencies with `npm ci`.
2. Start a disposable PostgreSQL database with pgvector, for example
   `docker compose up -d postgres` from the repository root.
3. Set `DATABASE_URL` in the root `.env` to that database. The database role must be able
   to create schemas and install `vector` and `pgcrypto` if they are not already installed.
4. Run `npm run manual:agent-memory`.

The runner creates and migrates a unique `mg_agent_manual_<random>` schema. Use a test
database: extension installation is database-wide. It drops only its exact schema in
`finally`, including after assertion failures. It never deletes preexisting application rows.
Use `npm run manual:agent-memory -- --keep-data` to preserve the schema for inspection.
The schema name is printed without database credentials.

## Expected results

The command exits with status zero and prints ten `PASS` lines followed by
`10 manual checks passed; 0 skipped`:

| Check | Expected behavior |
| --- | --- |
| Working state | Revision checks, redaction, retry safety, terminal immutability; no durable memory created |
| Successful tool result | One episode and a fact with explicit conditions, call/result IDs, and artifact reference |
| Retry/reconnect | Same episode IDs; no additional model calls or reinforcement |
| Concurrent processing | One committed episode and memory even when two processors run together |
| Rejected candidates | Claims, failed facts, missing conditions, and negative grounding verdicts create no durable memory |
| Failure lessons | A failed action can produce a conditional insight with `observed-failure` evidence |
| Large output | Bounded preview with truncation marker; omitted content cannot support a fact |
| Milestones | Pending call/result stays in one episode; safe milestones create incremental episodes |
| Authorization/lifecycle | Project peers can read but cannot process or forget; other tenants cannot read; suppression and forgetting hide memory |
| Atomic rollback | Forced evidence-write failure leaves no episode/graph rows; retry succeeds after the constraint is removed |

A printed episode outcome such as `host-reported-succeeded` describes a host claim, not
independent proof of success. The controlled verifier accepts or rejects fixture candidates
deliberately. For real-model evaluation, repeat equivalent cases with the host's adapters and
review every returned fact, condition, and cited output for actual support.

## Inspect retained data

Connect with your SQL client and substitute the exact printed schema name:

```sql
SET search_path TO mg_agent_manual_REPLACE_WITH_PRINTED_SUFFIX, public;
SELECT run_id, revision, state FROM mg_agent_working_state;
SELECT run_id, start_sequence, end_sequence, rejected_candidates
FROM mg_agent_episode_links ORDER BY run_id, start_sequence;
SELECT l.run_id, e.summary, e.outcome, l.memory_id, l.kind, l.basis,
       l.conditions, l.event_ids, l.artifact_uris, m.forgotten
FROM mg_agent_memory_links l
JOIN mg_episodes e ON e.id = l.episode_id
JOIN mg_memory_nodes m ON m.id = l.memory_id
ORDER BY l.run_id;
SELECT run_id, sequence, event FROM mg_agent_events ORDER BY run_id, sequence;
```

Verify the `shared` memory is retained with `forgotten = true`, rejected cases have episodes
but no memory links, and raw `fixture-secret`, `fixture-token`, and `PRIVATE_CUSTOMER`
values do not appear in stored events. The `large` result should contain a bounded preview
and digest rather than its original 4000-character output.

After inspection, remove only the exact printed schema:

```sql
DROP SCHEMA mg_agent_manual_REPLACE_WITH_PRINTED_SUFFIX CASCADE;
```

## Automated checks

`npm run test:run` includes unit coverage without requiring a database. To enable the
additional real-PostgreSQL integration suite in PowerShell:

```powershell
$env:MEMOGRAFTER_AGENT_MEMORY_TESTS = '1'
node --env-file=.env node_modules/vitest/vitest.mjs run tests/unit/agent/AgentMemoryStore.integration.test.ts
Remove-Item Env:MEMOGRAFTER_AGENT_MEMORY_TESTS
```

That suite also covers canonical reinforcement, conflict, supersession, migration replay,
and evidence-link rollback. Its temporary schema is removed automatically. Run concurrency
validation on real PostgreSQL; embedded socket emulators are not a substitute.
For an embedded emulator only, pass `--skip-concurrency`; expect nine checks passed and
one explicitly skipped. A skipped check means concurrency validation is still outstanding.
