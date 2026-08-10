# Live smoke tests

This directory contains the minimum end-to-end checks for MemoGrafter's critical
workflows. Unlike unit tests, these checks use the root `.env` and real
PostgreSQL. The basic chat, external application, graph building, `ingestText`,
queue ingestion, and Fleet tests call OpenAI. The queue and recall-cache tests use Redis when
`REDIS_URL` is configured.

The tests create unique sessions and remove only the records they created.
They do not wipe shared MemoGrafter tables.

## Requirements

1. Install dependencies and build the project.
2. Start PostgreSQL and apply the MemoGrafter migration.
3. Set `DATABASE_URL` in the root `.env`.
4. Set `OPENAI_API_KEY` for the OpenAI-backed tests, including the external application test.
5. Optionally set `REDIS_URL` for queue coverage.

## Commands

Run the full suite:

```bash
npm run live-smoke:smoke
```

Run one area:

```bash
npm run live-smoke:grafter
npm run live-smoke:graph
npm run live-smoke:ingestion
npm run live-smoke:ingest-text
npm run live-smoke:fleet
npm run live-smoke:crawler
npm run live-smoke:maintenance
npm run live-smoke:cache
npm run live-smoke:external
```

Write a timestamped Markdown report:

```bash
npm run live-smoke:smoke -- --write-doc
```

Write to a chosen path:

```bash
npm run live-smoke:smoke -- --write-doc=./artifacts/live-smoke.md
```

Other options:

- `--strict`: fail when an optional check is skipped.
- `--verbose`: print failure details in the terminal.
- `--timeout=<milliseconds>`: change the per-test timeout (default 60000).

Redis queue and recall-cache coverage are skipped when `REDIS_URL` is absent.
Under `--strict`, those skips make the command fail.

## Reports and telemetry

Reports include durations, assertions, answers produced by the basic chatbot,
topic and memory counts, drift scores, queue timing, Fleet metrics, crawler
pass metrics, graft token counts, recall-cache hits and misses, infrastructure
latency, provider/model metadata, and estimated LLM input/output tokens.
They also record the last Git commit and whether the working tree was clean or
dirty when the suite ran.

Database metrics count actual SQL statements dispatched while each tested
workflow is active. Schema verification, infrastructure preflight queries,
test-data cleanup, connection shutdown, and report generation are excluded.
Statements are reported only as reads, writes, or other; SQL text, parameters,
connection strings, and returned data are never collected.

When queue ingestion is enabled, the report records completed and failed jobs,
total logical messages, and the message counts and kinds of the first and last
jobs. The queue smoke runs two conversation turns, producing payloads of two
and four messages.

The infrastructure preflight measures PostgreSQL connect/first-query and warm
query latency. When Redis is configured, it also measures connect/first-ping
and warm ping latency. Connection strings and credentials are never included.

Provider adapters currently return text without provider usage metadata.
Consequently, LLM token figures use an approximation of four characters per
token and are labelled as estimates. They are not billing data or monetary
costs.

The basic chat, external application, graph building, `ingestText`, queue ingestion, and Fleet
shared-memory tests make paid OpenAI API calls using `gpt-4o-mini` and
`text-embedding-3-small`. Drift segmentation, recall caching, crawler
maintenance, and lifecycle checks use controlled test fixtures and make no
provider calls; their report columns show `Not Used`.

The tests use synthetic prompts, but reports can still contain model answers.
Generated reports are ignored by Git. API keys and connection URLs are never
written to reports.
