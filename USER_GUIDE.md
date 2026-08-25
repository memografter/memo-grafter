# MemoGrafter User Guide

## Introduction

MemoGrafter is an experimental Node.js and TypeScript framework for structured chatbot memory. It stores chatbot conversations as message buffers, topic segments, topic nodes, and graph edges. Later, it can inject relevant memory into a chatbot turn or copy selected memory into another chatbot/session.

The project is intentionally focused. MemoGrafter is a chatbot memory framework, not an autonomous agent runtime. It does not run tools, schedule work, or decide goals for an agent. It helps a chatbot remember, retrieve, and transfer conversational context.

The most important idea is memory grafting. A chatbot can build useful memory during one conversation, and another chatbot can absorb only the relevant parts.

MemoGrafter ingests conversation memory incrementally. New turns append topic nodes, memory nodes, and graph edges to the existing session graph instead of clearing and rebuilding the graph on every response. This keeps grafted memory and future external graph enrichment durable across normal chatbot turns.

## Requirements

- Node.js 18 or newer.
- TypeScript or modern JavaScript using ES modules.
- PostgreSQL with the `pgvector` extension enabled for the built-in `PostgresGraphStore`.
- An LLM adapter.
- An embedding adapter.
- An OpenAI API key only if using the included OpenAI adapters.
- An Anthropic API key only if using the included Anthropic LLM adapter.
- A Gemini API key only if using the included Gemini adapters.
- Redis only if enabling queue mode or the optional recall cache.

MemoGrafter is server-side only. Do not run it in browser code.

## Installation

Install from npm:

```bash
npm install memo-grafter
```

Install from a local clone before publishing or while developing:

```bash
cd path/to/your-app
npm install D:/cohort/projects/project-memoGrafter
```

If you are working inside this repository, build it first:

```bash
cd D:/cohort/projects/project-memoGrafter
npm install
npm run build
```

## Environment Setup

Create a `.env` file in your app:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/memo_grafter
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
OPENAI_API_KEY=sk-...
REDIS_URL=redis://localhost:6379
```

`DATABASE_URL` is required when using the built-in PostgreSQL storage.

`OPENAI_API_KEY` is required only when using `OpenAILLMAdapter` or `OpenAIEmbedAdapter`.

`ANTHROPIC_API_KEY` is required only when using `AnthropicLLMAdapter`.

`GEMINI_API_KEY` is required only when using `GeminiLLMAdapter` or `GeminiEmbedAdapter`.

Provider SDKs are optional and loaded lazily. Importing `memo-grafter` or constructing an adapter does not require any provider SDK or API key. Install only the SDK for the built-in adapter you call; configuration errors surface from that adapter's `complete()` or `embed()` operation.

`REDIS_URL` is optional. Setting it alone does not activate Redis: uncomment the generated `cache` or `queue` example in `src/memo-grafter/mg.config.ts` to opt in.

For the recommended setup flow, initialize the project files, migrate the MemoGrafter tables, verify the environment, and then launch Studio:

```bash
npx memo-grafter init
npx memo-grafter migrate
npx memo-grafter doctor
npx memo-grafter studio
```

`memo-grafter init` is required before `migrate` or `studio`. Doctor does not require initialization to start; it reports missing project configuration as a failed check instead of aborting. Init creates local project files only:

- `src/memo-grafter/mg-schema.ts`: generated MemoGrafter schema reference for `mg_*` tables. This file is regenerated on every `init` run.
- `src/memo-grafter/mg.config.ts`: user-editable MemoGrafter CLI config. The generated config includes database resolution, commented Redis cache/queue examples, and an OpenAI-compatible embedder scaffold for Studio Invoke Preview. Set `OPENAI_API_KEY` to enable preview, and optionally set `MEMO_GRAFTER_EMBEDDING_MODEL`.

`memo-grafter init` does not create, relocate, or modify an application schema file. Keep application models and tables in the location expected by Prisma, Drizzle, raw SQL migrations, or your existing database tool.

`memo-grafter migrate` is the preferred migration path. It creates `pgvector`, `pgcrypto`, MemoGrafter-owned core `mg_*` tables and indexes, and the `mg_migrations` metadata table. It records the package's current migration version after the schema work succeeds. It does not migrate application tables, and it should run once per database or deployment rather than on every application startup. The command is idempotent and prints whether each extension, table, and index was created or already existed, followed by a reminder to run Doctor.

### Verify Setup With Doctor

Run Doctor after migration or whenever an environment stops behaving as expected:

```bash
npx memo-grafter doctor
```

Doctor checks:

- the active Node.js and installed MemoGrafter versions;
- whether MemoGrafter configuration files and `DATABASE_URL` are available;
- PostgreSQL connectivity and server version;
- whether pgvector is available on the server and enabled in the database;
- whether `mg_migrations` exists and records the current version;
- whether all required core MemoGrafter tables exist;
- Redis reachability when recall caching or queue mode is enabled in `mg.config.ts`.

To include read-only durable-ingestion checks, pass `--ingestion`. Scope the inspection with `--session`, or request stable machine-readable output with `--json`:

```bash
npx memo-grafter doctor --ingestion
npx memo-grafter doctor --ingestion --session <session-id>
npx memo-grafter doctor --ingestion --json
```

Doctor never repairs ingestion state. Applications must explicitly choose repairs through `memo.reconcileSession()` or `memo.reconcilePendingIngestion()`.

Doctor uses the same database resolution order as migration: `--db`, then `.env` / `DATABASE_URL`, then `src/memo-grafter/mg.config.ts`, then root `mg.config.ts`. You can override the database URL without printing it in the report:

```bash
npx memo-grafter doctor --db postgres://postgres:postgres@localhost:5432/memo_grafter
```

Checks are dependency-aware. If PostgreSQL cannot be reached, Doctor reports that required failure and marks pgvector and schema checks as skipped instead of reporting misleading secondary failures. If neither Redis feature is enabled, Doctor explains how to set `REDIS_URL` and uncomment `cache` or `queue`. An unreachable configured cache produces a warning while PostgreSQL-backed recall remains available. An unreachable configured queue is a required failure because queued ingestion depends on Redis.

Doctor exit codes are:

- `0`: all required checks passed;
- `1`: one or more required checks failed;
- `2`: invalid command usage, such as an unknown option or `--db` without a value.

Optional Redis warnings do not produce exit code `1`. Doctor stores checks as structured `passed`, `failed`, `warning`, or `skipped` results; `--json` exposes those same stable checks for scripts and deployment diagnostics.

### Cancellation, timeouts, and degraded results

Selected long-running APIs accept `signal` and `timeoutMs` through `MemoGrafterOperationOptions`:

```ts
const result = await memo.context(
  { sessionId, query },
  { signal: request.signal, timeoutMs: 5_000 },
);
```

Caller cancellation throws `OPERATION_ABORTED` and is not automatically retryable. A configured deadline throws retryable `OPERATION_TIMEOUT`. Optional recall-cache failures do not fail retrieval; successful degraded results set `degraded: true` and include structured `warnings`.

You can launch MemoGrafter Studio again whenever you want a local visibility and debugging entry point:

```bash
npx memo-grafter studio
```

Studio requires the project to be initialized and uses the same database resolution order as `migrate`: `--db`, then `.env` / `DATABASE_URL`, then `src/memo-grafter/mg.config.ts`. To pass a connection string directly:

```bash
npx memo-grafter studio --db postgres://postgres:postgres@localhost:5432/memo_grafter
```

Studio verifies the MemoGrafter schema, prints database connection status, session count, and the local URL, then opens your browser. It starts on `http://localhost:2891` or the next available port and keeps running until you stop it with `Ctrl+C`.

Studio's database and inspection features do not require the OpenAI, Anthropic, or Gemini SDKs. The CLI loads provider-independent `memo-grafter/store` and `memo-grafter/studio` entry points. Install a provider SDK only when your application or Studio Invoke Preview explicitly uses that provider's adapter.

The Studio landing page shows sessions first. Select a session to open its workspace:

The selected-session header also reports read-only ingestion health and pending-message count. Studio does not reconcile or repair ingestion state.

- **Graph:** shows topic nodes as the stable graph backbone. Memories are shown only for the selected topic, which keeps large sessions readable. Use node type, tag, and lifecycle filters to narrow the graph. Selecting a topic shows its summary, source metadata, lifecycle state, and connected memories. Selecting a memory shows its structured fact fields, confidence, lifecycle flags, source metadata, and related, conflict, or update edges.
- **Tables:** provides a read-only browser for the underlying `mg_*` tables using their original table names. Use the table selector and pagination controls to inspect rows; long cell values can be expanded in place.
- **Invoke Preview:** builds the same framework-level `{ system, messages }` request plan used by `MemoGrafterAgent` or Fleet Worker invocation without calling the LLM. It shows context selection, structured messages, a readable plain-text rendering, raw memory context, retrieval explanation, and token usage. Persisted history is labelled **Database-backed preview** because live agent history is process-local. Provider adapters may transform the request, so Studio does not claim byte-for-byte provider payload equivalence. Invoke Preview requires an embedder; other Studio views remain available without one. An optional **Run with LLM** action executes the displayed short-lived plan using the server-side configured adapter and API key; Studio warns that provider charges may apply, and the returned response is not persisted or ingested.

For an active topic, **Graft to session** copies the topic and its active memories into one or more selected sessions. Studio first shows the active memories that will be copied, lifecycle-filtered memories that will be omitted, and duplicate targets that will be skipped. A graft is an independent copy rather than a synchronized reference. The copied topic records its source-session provenance and can be removed from its target session without changing the source.

The node details panel also provides the supported maintenance action: suppressing a topic. Studio refreshes the selected graph after a successful suppression and keeps the affected node selected so its new lifecycle state is visible. Use the refresh controls to reload the session list or active tab after your application writes more memory.

Studio also hosts an internal REST API for its own views, including session listing, graph reads, table reads, memory search, Invoke Preview, topic graft preview/copy/removal, and topic suppression. This API is local tooling infrastructure, not a public web service. Authentication, multi-user access control, and internet exposure are out of scope; do not bind Studio to a public interface or proxy it as an application API.

Current MemoGrafter tables:

- `mg_migrations` (migration metadata)
- `mg_message_buffer`
- `mg_segments`
- `mg_topic_nodes`
- `mg_topic_edges`
- `mg_memory_nodes`
- `mg_memory_edges`
- `mg_fleets`
- `mg_fleet_agents`
- `mg_sessions`
- `mg_session_ingest_state`
- `mg_ingestion_runs`
- `mg_graft_registry`

`mg_topic_nodes` and `mg_memory_nodes` include optional `tags TEXT[]` columns. Tags default to an empty array, so existing untagged sessions continue to work normally.

## Quick Start

Run the setup commands once for your app before starting application code:

```bash
npx memo-grafter init
npx memo-grafter migrate
npx memo-grafter doctor
```

Create `src/index.ts`:

```ts
import "dotenv/config";

import {
  MemoGrafterAgent,
  OpenAIEmbedAdapter,
  OpenAILLMAdapter,
} from "memo-grafter";

const agent = new MemoGrafterAgent({
  db: {
    connectionString: process.env.DATABASE_URL!,
  },
  llm: new OpenAILLMAdapter("gpt-4o"),
  embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
});

try {
  await agent.initialize();

  console.log(await agent.invoke("I am planning a Japan trip."));
  console.log(await agent.invoke("I like quiet towns and local cafes."));
  console.log(await agent.invoke("What should I remember while planning?"));

  const nodes = await agent.getActiveNodes();
  console.log(nodes.map((node) => ({ label: node.label, summary: node.summary })));
} finally {
  await agent.close();
}
```

Run it:

```bash
npx tsx --env-file=.env src/index.ts
```

## Core Concepts

### Integrating An Existing Chatbot Or Agent

Use the core `MemoGrafter` API when your application already owns the model call. Retrieve memory before generation, then analyze the completed exchange afterward:

```ts
const context = await memo.context({
  sessionId: "support-42",
  query: userMessage,
  limit: 6,
  minSimilarity: 0.55,
  tokenBudget: 900,
});

const assistantMessage = await yourChatRuntime.generate({
  systemPrompt: context.systemPrompt,
  userMessage,
});

await memo.analyze({
  sessionId: "support-42",
  userMessage,
  assistantMessage,
  tags: ["support"],
});
```

`context()` embeds the query and runs the current graph retrieval path. It returns `facts`, their parent topic `nodes`, a ready-to-inject `systemPrompt`, and token metadata. It always reads fresh graph state: even if recall caching is configured, this method does not read or populate Redis. Retrieval fetches the nearest 40 candidates by default, ranks them, and adaptively selects up to `limit: 10` facts within `tokenBudget: 1200`; tag, scope, session, and scoring options are the same as targeted recall. Persistent pinned topics for the requested session are prepended in pin order, use the separately reserved `inject.tokenBudget`, and are described by `pinnedNodes`, `pinnedContextTruncated`, and `pinnedTokenBudget` in the result.

`analyze()` accepts one completed, non-empty user-assistant exchange, atomically appends it after the session's durable message buffer, and runs the normal drift detection, extraction, embedding, and graph persistence pipeline. Calls are serialized per session within a process, and the built-in PostgreSQL store uses a session lock so concurrent application instances do not claim the same indexes. If analysis fails after the exchange is stored, the graph cursor remains unchanged and a later append retries the contiguous unprocessed backlog without overwriting messages. Optional tags are applied to the topic and memory rows created from the exchange. Call it only after a response completes; do not also ingest the same exchange through another API.

Neither method performs your application's chat completion. `context()` requires an embedder; `analyze()` uses both the configured embedder and extraction LLM. Without queue mode, `analyze()` resolves to the newly created topic nodes. With queue mode, it resolves to `[]` once the append job is accepted, and the new graph state becomes visible only after the worker completes.

### Messages

A message is one user or assistant turn:

```ts
export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}
```

`MemoGrafterAgent` keeps an in-memory user/assistant history for the current session and stores messages in PostgreSQL during ingestion. When a session already has memory graph content, `invoke()` can add a system message with recalled facts before the LLM call.

Ingestion tracks the last message index that has been processed for each session. Re-running ingestion with the same history is a no-op for graph creation, while later turns append new graph state.

### Segments

A segment is a range of messages that belong to the same topic. MemoGrafter uses drift detection to decide where topic boundaries are.

Drift detection combines several signals:

- how far the current message is from the current topic embedding,
- whether the current message is a sharp pivot from the previous user message,
- whether the message contains structural phrases such as "by the way", "different topic", or "going back to",
- short-message dampening so filler like "okay" or "got it" is less likely to create false boundaries,
- optional LLM classification for ambiguous topic-shift scores.

Example:

```text
messages 0-4  -> Japan travel planning
messages 5-8  -> cover letter writing
```

Segments are stored in `mg_segments`.

### Topic Nodes

A topic node is the main unit of memory. It represents a segment as a label, summary, embedding, message range, and metadata.

Important fields:

- `id`: unique topic node ID.
- `label`: short label.
- `summary`: structured summary of the segment.
- `embedding`: vector used for semantic search.
- `tags`: optional normalized tags such as `"project:memo-grafter"` or `"planning"`.
- `messageRange`: source message range.
- `topicOrder`: chronological order.
- `driftScore`: topic-change score.
- `suppressed`: whether the topic is temporarily hidden from recall, grafting, crawler maintenance, and active topic reads.
- `suppressedAt`: timestamp for the latest suppression, or `null` when active.
- `agentColor`, `fleetId`, `agentId`: nullable fleet metadata.

Topic nodes are stored in `mg_topic_nodes`.

### Memory Nodes

Memory nodes are typed atomic memories attached to topic nodes. They are the units used by targeted recall.

Important fields:

- `memoryType`: `"fact"`, `"insight"`, `"question"`, `"task"`, or `"reference"`.
- `subject`, `predicate`, `value`: the structured memory triple.
- `confidence`: confidence score from `0` to `1`.
- `topicNodeId`: parent topic node ID.
- `tags`: optional normalized tags copied from the session or ingest call.
- `decayed`: whether the memory is stale.
- `forgotten`: whether the memory has been explicitly hidden by an application.
- `forgottenAt`: timestamp for the explicit forget action, or `null` when active.
- `hasConflict`: whether crawler maintenance found a conflicting active fact.
- `supersededBy`: newer memory ID when this memory has been replaced.

Memory nodes are stored in `mg_memory_nodes`.

`decayed`, `hasConflict`, and `supersededBy` are maintenance fields. `forgotten` is an application-controlled lifecycle field. Normal ingestion creates active memories. Optional crawler passes can later annotate existing memory rows, but they do not delete rows or rewrite topic summaries.

### Graph Edges

Edges connect related topic nodes. They can represent temporal, semantic, grafted, or reentry relationships.

- `temporal`: one topic followed another in the conversation.
- `semantic`: two topics are similar by embedding search.
- `grafted`: a topic was copied from another session or chatbot.
- `reentry`: the conversation returned to an earlier topic after discussing something else.

Edges are stored in `mg_topic_edges`.

Memory edges are stored separately in `mg_memory_edges`. They can represent:

- `semantic`: two memory facts are similar.
- `conflicts`: two active memory facts disagree.
- `updates`: a newer memory supersedes an older memory.
- `related`: reserved for broader memory relationships.

For version edges, MemoGrafter uses this direction:

```text
newer_memory --updates--> older_memory
```

### Grafting

Grafting is the process of selecting topic nodes and turning them into useful context for another prompt or another chatbot.

There are two common forms:

- Preview memory with `graft()`.
- Copy memory into another chatbot with `absorbFromAgent()` or `ingestGraftedNodes()`.

When topic nodes are absorbed into another session, MemoGrafter also copies their active memory nodes so targeted recall can find the transferred facts. Copied memory rows get fresh IDs, keep their existing embeddings, and are copied as active memories only when the source row is not decayed, superseded, forgotten, or attached to a suppressed topic.

Absorbed topic nodes are also registered in `mg_graft_registry`. The registry records the destination session, copied node ID, source session ID, source node ID, and graft timestamp so applications can inspect provenance or remove a graft later.

## Using MemoGrafterAgent

`MemoGrafterAgent` is the easiest API to start with.

For a single application configuration point, import the generated config explicitly. Automatic
config discovery is not performed:

```ts
import "dotenv/config";
import { MemoGrafterAgent } from "memo-grafter";
import config from "./memo-grafter/mg.config.js";

const agent = await MemoGrafterAgent.create(config);
```

`create()` validates environment-backed values, constructs the existing agent, and initializes it.
It also accepts field-aware overrides without discarding sibling settings:

```ts
const agent = await MemoGrafterAgent.create(config, {
  systemPrompt: "You are a travel assistant.",
  inject: { recallLimit: 10 },
  cache: false,
});
```

Use `defineConfig(() => ({ ... }))` in `mg.config.ts` when values come from the environment. The
factory is evaluated when `create()` runs. The config file participates in the normal application
build; `tsx` or TypeScript watch mode reflects changes automatically, while production uses the
usual rebuild. Keep this server-only configuration out of browser bundles.

The constructor lifecycle remains supported and unchanged:

```ts
const agent = new MemoGrafterAgent({
  db: {
    connectionString: process.env.DATABASE_URL!,
  },
  llm: new OpenAILLMAdapter("gpt-4o"),
  embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
});
```

Initialize it before use:

```ts
await agent.initialize();
```

Send user messages with `invoke()`:

```ts
const answer = await agent.invoke("Help me plan a Kyoto itinerary.");
```

Close resources when done:

```ts
await agent.close();
```

### What `invoke()` Does

On every call, `invoke()`:

1. Checks whether the current session has topic nodes in the memory graph.
2. If graph content exists, calls targeted recall using the current user message.
3. Prepends the recalled memory prompt as a system message when recall returns matching facts.
4. Builds the LLM message list from the optional memory system message, the recent raw history window, and the current user message.
5. Adds the user message and assistant response to local history after the LLM response.
6. Queues the newly completed user-assistant pair with its absolute message start index. A normal job contains two messages, not the complete session history.

The worker persists only messages beyond the stored ingest cursor, loads up to six preceding messages from PostgreSQL for drift context, and creates graph state only for the unprocessed range. This changes transport and persistence efficiency without changing the foreground LLM prompt, drift scoring, extraction prompts, or graph-building stages.

Recall is skipped entirely when the session has no topic nodes yet. This avoids an unnecessary embed and vector search on the first turn or while async ingestion has not produced graph content.

Recall failures are logged as warnings and fall back to raw history only, so a retrieval or embedder problem should not crash the foreground chatbot turn.

On the first turn there may be no memory to recall. Later turns can use memory created from earlier turns once ingestion has completed.

Normal ingestion does not call `clearSession()`. Existing topic nodes, grafted nodes, memory rows, and graph edges are preserved unless you explicitly clear the session.

### Ingesting Text Without A Conversation

Use `ingestText()` to build topic nodes, memory nodes, and graph edges from raw text without generating an assistant response:

```ts
await agent.ingestText(editorContent, {
  replace: true,
  label: "Morning entry",
  source: "classic-editor",
});
```

The extraction LLM is still used internally to summarize the text and extract structured memories. The raw text is stored for graph ingestion but is not added to `getHistory()` and is not sent through the normal assistant response-generation path.

Before ingestion, MemoGrafter splits the text into internal chunks using line and sentence boundaries, with a size limit for unusually long sentences. The existing drift detector runs across those chunks, so one `ingestText()` call can create multiple topic segments and topic nodes when the text changes subject. These chunks remain internal and do not appear in `getHistory()`.

Options:

- `replace`: clear the current session's stored graph before ingesting the text. Defaults to `false`.
- `label`: optional hint for the first topic label created by this ingestion.
- `source`: optional arbitrary metadata stored on created topic and memory nodes, such as `"import"` or `"classic-editor"`.

Use `replace: true` for autosave workflows where each call represents the complete current document. Replacement removes stored messages, topic nodes, memory nodes, graph edges, segments, grafted nodes, and the ingest cursor for the current session. It does not clear the agent's public conversational history or change the session ID.

Without `replace`, each text call appends to the current session memory. Later `invoke()` calls continue to work normally and can recall facts extracted from the ingested text.

In queue mode, `await agent.ingestText()` confirms that the ingestion job was queued. Reads may need to wait for the worker to finish before the new graph content is visible.

### Remembering Explicit Facts

Use `remember()` when your application already knows a fact, preference, or note and wants to store it without running an assistant turn:

```ts
await agent.remember("The user prefers concise TypeScript examples.", {
  label: "User preference",
  source: "profile-settings",
});
```

`remember()` is a convenience wrapper around `ingestText()`. It uses the same extraction pipeline, applies the current session tags automatically, does not change `getHistory()`, and defaults `source` to `"remember"` when you do not provide one. The extraction LLM still decides which structured memories to create, so this API is best for natural-language facts and preferences rather than exact row-level inserts.

### Clearing A Session

Use `clearSession()` when you intentionally want to reset an agent:

```ts
await agent.clearSession();
```

This waits for pending ingestion, clears the agent's local in-memory history, removes stored messages, topic nodes, memory nodes, graph edges, segments, and resets the session ingest cursor. It is a destructive operation and is not part of normal `invoke()` processing.

### Memory Lifecycle Controls

Use lifecycle controls when your application needs user-controlled memory management without physically deleting graph rows by default.

Forget a single memory node:

```ts
const recall = await agent.recall("food preferences");
const memoryId = recall.facts[0]!.id;

const changed = await agent.forget(memoryId);
console.log(changed); // true when the memory was newly marked forgotten
```

Forget several memory nodes at once:

```ts
const changedCount = await agent.forgetMany([
  "memory-id-a",
  "memory-id-b",
]);
```

Suppress a topic temporarily:

```ts
const nodes = await agent.getActiveNodes();
const topicId = nodes[0]!.id;

await agent.suppressTopic(topicId);
```

Restore a suppressed topic:

```ts
await agent.restoreTopic(topicId);
```

Forgotten memories stay in `mg_memory_nodes` with `forgotten = TRUE` and `forgotten_at` set. Suppressed topics stay in `mg_topic_nodes` with `suppressed = TRUE` and `suppressed_at` set. These rows are excluded from targeted recall, invoke-time recall, graft prompt assembly, semantic graft seed selection, absorption, active topic listing, and crawler maintenance until restored where applicable.

`forget()` and `forgetMany()` are one-way soft lifecycle operations. There is no built-in `restoreMemory()` API because user-requested memory deletion and privacy flows usually need conservative behavior. Applications that require undo or hard deletion can implement that policy at the storage layer.

`getGraphSnapshot()` remains useful for audit and visualization. Snapshot memory reads include forgotten, decayed, conflicted, and superseded rows, and snapshot topic reads include suppressed topics, so UIs can display lifecycle state explicitly.

The lower-level `MemoGrafter` class exposes the same methods when you manage sessions yourself:

```ts
await memo.forget(memoryId);
await memo.forgetMany(memoryIds);
await memo.suppressTopic(topicId);
await memo.restoreTopic(topicId);
```

### Memory History And Diff

Use memory history APIs when your application needs audit trails, explainability, or debugging for facts that changed over time.

Look up history from a specific memory node:

```ts
const history = await agent.getMemoryHistory(memoryId);

for (const entry of history.entries) {
  console.log(entry.versionIndex);
  console.log(entry.status);
  console.log(entry.memory.value);
  console.log(entry.supersededBy);
  console.log(entry.supersedes);
  console.log(entry.conflictsWith);
}

console.log(history.currentMemory);
```

Look up history by fact key:

```ts
const history = await agent.getMemoryHistory("user", "location");
```

`MemoGrafterAgent` scopes history lookups to the current session. If you manage sessions yourself with `MemoGrafter`, pass the session explicitly:

```ts
const history = await memo.getMemoryHistory("user", "location", {
  sessionId,
});
```

Compare two memory versions:

```ts
const diff = await agent.getMemoryDiff(oldMemoryId, newMemoryId);

console.log(diff.changedFields);
console.log(diff.relationship.supersededBy);
console.log(diff.relationship.updateEdges);
console.log(diff.relationship.conflictEdges);
```

History results are read-only and derived from existing memory rows plus `supersededBy`, `updates`, and `conflicts` metadata. They intentionally include superseded, decayed, forgotten, and suppressed-topic memories, even though those rows are excluded from normal recall and grafting.

`MemoryHistoryEntry.status` is one of:

- `"active"`: not superseded, decayed, forgotten, or conflicting.
- `"superseded"`: the memory has `supersededBy` set.
- `"conflicting"`: the memory has `hasConflict` or a `conflicts` edge.
- `"decayed"`: crawler decay marked the memory stale.
- `"forgotten"`: an application explicitly forgot the memory.

`getMemoryDiff()` is structural. It compares stored fields such as `value`, `confidence`, lifecycle flags, tags, source metadata, and timestamps. It does not call an LLM or generate prose explanations.

### Session Tags

Use session tags when you want to organize memory by project, planning area, week, domain, or worker route.

```ts
await agent.setSessionTags([
  "project:memo-grafter",
  "planning",
  "week:2026-05-25",
]);

console.log(agent.getSessionTags());
```

Tags are optional. They are normalized by trimming whitespace, lowercasing, deduplicating, and sorting. Calling `setSessionTags()` waits for pending ingestion, updates existing topic and memory rows for the current session, and applies the same tags to future memories created by `invoke()`.

You can also tag direct ingestion:

```ts
await memo.ingest(messages, sessionId, {
  tags: ["project:memo-grafter", "planning"],
});
```

Tags do not replace `sessionId`. By default, MemoGrafter still reads from the current session. Tag filters are opt-in.

### Targeted Recall

Use `recall()` when you want to retrieve structured memory by meaning without asking the LLM to produce an answer.

```ts
const result = await agent.recall("deployment config", {
  limit: 8,
  minSimilarity: 0.55,
  tokenBudget: 1000,
  tags: ["project:memo-grafter"],
  tagMode: "all",
  scope: "session-and-tags",
  scoring: {
    similarityWeight: 0.7,
    confidenceWeight: 0.3,
  },
  cache: {
    ttlSeconds: 90,
  },
});

console.log(result.facts);
console.log(result.nodes);
console.log(result.systemPrompt);
console.log(result.tokenCount);
```

`recall()` returns a `RetrievalResult`:

- `facts`: matching memory nodes with a `similarity` score.
- `nodes`: parent topic nodes for the included facts.
- `systemPrompt`: a formatted memory block that can be passed to an LLM if you choose.
- `tokenCount`: approximate token count for the included fact blocks.

Options:

- `limit`: max memory nodes to fetch before filtering. Defaults to `10`.
- `candidateLimit`: nearest vector candidates considered before ranking. Defaults to `40` and is never lower than `limit`.
- `minSimilarity`: deprecated compatibility option. Candidate generation no longer applies an absolute similarity cutoff.
- `selection.maxTopics`: maximum adaptively selected topic blocks. Defaults to `limit`.
- `selection.relativeScoreFloor`: minimum block score relative to the best block. Defaults to `0.75`.
- `selection.scoreGapThreshold`: adjacent block-score drop that ends selection. Defaults to `0.15`.
- `tokenBudget`: max approximate tokens for included fact blocks. Defaults to `1200`.
- `tags`: optional normalized tag filter.
- `tagMode`: `"all"` requires every requested tag, `"any"` accepts at least one requested tag. Defaults to `"all"`.
- `scope`: `"session"` keeps normal current-session recall, `"session-and-tags"` filters current-session recall by tags, and `"tagged"` searches across sessions matching the tags.
- `scoring.similarityWeight`: weight applied to semantic similarity when ranking retrieved facts. Defaults to `0.7`.
- `scoring.confidenceWeight`: weight applied to memory confidence when ranking retrieved facts. Defaults to `0.3`.
- `cache.ttlSeconds`: per-call recall cache TTL override when `MemoGrafterConfig.cache` is enabled. Values are clamped to 60-120 seconds.

`recall()` is side-effect free. It does not call `invoke()`, does not trigger a new LLM completion, and does not mutate local history. Your application can call it directly to display memories, add `result.systemPrompt` to a model call, or ignore the result. Retrieval ranks the nearest active candidates with `similarity * similarityWeight + confidence * confidenceWeight`, groups them by topic, and adaptively selects blocks from the ranked score distribution.

Cross-session tagged recall is explicit:

```ts
const projectMemory = await agent.recall("deployment decisions", {
  tags: ["project:memo-grafter"],
  scope: "tagged",
  minSimilarity: 0.3,
});
```

This can return matching active memories from older or different sessions with the same tag. Active recall excludes decayed, superseded, forgotten, and suppressed-topic memories. If your development database contains repeated smoke-test runs, you may see more than one matching fact because the older tagged rows are still present.

`MemoGrafterAgent.invoke()` also calls `recall()` internally before answering when the session has topic nodes. In that automatic path, the returned `systemPrompt` is pinned as a single system message before the recent raw chat window. Automatic recall uses `inject.recallLimit` and `inject.recallMinSimilarity`, defaulting to `6` and `0.55`.

If you call `recall()` immediately after `invoke()`, it only sees memory that has already been ingested into storage. In queue mode, wait for your background worker to finish before expecting newly created memories to appear.

## Inspecting Memory

Read a complete session graph snapshot:

```ts
const snapshot = await agent.getGraphSnapshot();

console.log(snapshot.sessionId);
console.log(snapshot.nodes);
console.log(snapshot.snapshotNodes);
console.log(snapshot.edges);
console.log(snapshot.memories);
console.log(snapshot.snapshotMemories);
console.log(snapshot.memoryEdges);
console.log(snapshot.capturedAt);
```

`getGraphSnapshot()` returns a `GraphSnapshot`:

- `sessionId`: current agent session ID.
- `nodes`: topic nodes for the session, including suppressed nodes for audit views.
- `snapshotNodes`: topic nodes wrapped with lifecycle metadata and optional graft provenance.
- `edges`: topic edges where either endpoint belongs to a session topic node.
- `memories`: all memory nodes for the session, including forgotten, decayed, conflicted, or superseded rows.
- `snapshotMemories`: memory nodes wrapped with lifecycle metadata.
- `memoryEdges`: memory-level edges such as `semantic`, `conflicts`, `updates`, and `related`.
- `capturedAt`: ISO timestamp for when the snapshot was produced.

Each `snapshotNodes` entry contains:

- `node`: the topic node.
- `lifecycle`: `{ suppressed, suppressedAt }`.
- `graftOrigin`: optional `{ sourceSessionId, sourceNodeId, graftedAt }` when the node came from a graft.

Each `snapshotMemories` entry contains:

- `memory`: the memory node.
- `lifecycle`: `{ forgotten, forgottenAt, decayed, supersededBy, hasConflict }`.

The `nodes`, `edges`, `memories`, and `memoryEdges` arrays remain available for backward-compatible callers that already read the raw graph rows directly. Snapshot arrays are sorted deterministically so graph UIs can use them as a stable primary data source.

This method is read-only. It does not include raw `mg_message_buffer` content and does not add rendering, layout, or color decisions. Like `getActiveNodes()` and `getActiveSegments()`, it waits for the agent's local pending-ingest chain before reading. Without queue mode that includes pipeline completion; with BullMQ it guarantees only that submission settled, so callers that require newly created graph state must still wait for worker completion.

Graph snapshots intentionally include stale and maintenance metadata so visualizers can show memory lifecycle state. For example, a UI can hide or label `forgotten` memories, fade `decayed` memories, show `hasConflict` badges, draw `conflicts` edges between contradictory facts, draw `updates` edges from the current fact to the older fact it replaced, and show suppressed topics separately from active topics.

Read active topic nodes:

```ts
const nodes = await agent.getActiveNodes();

for (const node of nodes) {
  console.log({
    id: node.id,
    label: node.label,
    summary: node.summary,
    messageRange: node.messageRange,
    topicOrder: node.topicOrder,
    driftScore: node.driftScore,
  });
}
```

Filter active topic nodes by tag:

```ts
const planningNodes = await agent.getActiveNodes({
  tags: ["planning"],
  tagMode: "all",
});
```

Read active segments:

```ts
const segments = await agent.getActiveSegments();
console.log(segments);
```

Read the in-memory chat history:

```ts
const history = agent.getHistory();
console.log(history);
```

Read the session ID:

```ts
console.log(agent.getSessionId());
```

## Grafting Memory

Use `graft()` to preview what memory would be injected:

```ts
const graft = await agent.graft();

console.log(graft.systemPrompt);
console.log(graft.nodes);
console.log(graft.tokenCount);
```

You can graft specific topic IDs:

```ts
const nodes = await agent.getActiveNodes();

const graft = await agent.graft([nodes[0]!.id]);
```

You can also select graft seed nodes by semantic relevance when you know the context you want but not the topic IDs:

```ts
const graft = await agent.graftByRelevance("authentication discussion", {
  topK: 5,
  minSimilarity: 0.6,
  hopDepth: 1,
  expansionStrategy: "graph",
});
```

Set `expansionStrategy: "none"` to graft only the semantic seed nodes. The default `"graph"` strategy expands from those seeds through graph neighbours using `hopDepth`.

`graft()` and `graftByRelevance()` return:

- `systemPrompt`: memory context suitable for an LLM system prompt.
- `nodes`: selected topic nodes.
- `tokenCount`: estimated token count.

Graft prompts include topic summaries because they preserve useful conversation context. Topic summaries are historical: if an older topic summary says "the user lives in Delhi" and a later memory says "the user lives in Bangalore", MemoGrafter does not rewrite the old summary. Instead, when crawler maintenance has marked a contradiction or supersession, graft prompt assembly adds deterministic maintenance notes and active memory facts:

```text
Memory maintenance notes:
- The fact "user location: Delhi" was superseded by "Bangalore".
- Prefer active memory facts over contradictory historical summary details.
Active memory facts:
- user location: Bangalore
```

This keeps history intact while telling the downstream model which fact is current.

Suppressed topics are not included in graft prompts, even if their IDs are passed explicitly. Forgotten memories are not included as active facts or as replacement details in maintenance notes.

## Maintaining Memory With The Crawler

`MemoGrafterCrawler` is an optional graph maintenance worker. It can run once on demand or on a simple in-process interval. It does not use Redis, BullMQ, OpenAI, embeddings, or LLMs for the built-in conflict/versioning/decay passes.

Typical usage with the real store:

```ts
import {
  ConflictDetectionPass,
  DecayScoringPass,
  MemoGrafter,
  MemoGrafterCrawler,
  VersioningPass,
} from "memo-grafter";

const memo = new MemoGrafter(config);
await memo.initialize();

const crawler = new MemoGrafterCrawler({
  store: memo.store,
  intervalMs: 60_000,
  passes: [
    new ConflictDetectionPass(),
    new VersioningPass(),
    new DecayScoringPass({
      halfLifeDays: 90,
      minScore: 0.25,
    }),
  ],
});

const report = await crawler.runOnce();
console.log(report);
```

When `config` is imported from `mg.config.ts`, the lower-level API can instead resolve and
initialize it in one step:

```ts
import config from "./memo-grafter/mg.config.js";

const memo = await MemoGrafter.create(config, {
  graph: { topK: 10 },
});
```

`MemoGrafter.create()` returns an initialized instance. The existing constructor remains explicit
and still requires `await memo.initialize()`.

`runOnce()` executes the configured passes exactly one time and returns a `CrawlerReport`. `intervalMs` does not affect `runOnce()`.

To run the crawler in-process on a schedule:

```ts
crawler.start();

// Later, during shutdown:
crawler.stop();
await memo.close();
```

`start()` is safe to call more than once; it does not create duplicate intervals. If a scheduled tick fires while the previous run is still executing, that tick is skipped.

The built-in conflict and versioning passes use separate deterministic classifiers:

- both classifiers begin by grouping active memories by session, normalized `subject`, and normalized `predicate`;
- a group conflicts when it has different normalized `value` strings and the newest value does not contain an explicit update cue;
- a group versions only when its newest value contains an explicit replacement or update cue such as `actually`, `now`, `changed to`, or `instead`;
- decayed memories are skipped;
- forgotten memories and memories attached to suppressed topics are skipped;
- already superseded memories are skipped;
- broad topic memories with generic subject/predicate pairs are skipped unless they match a recognized competing trip-plan pattern;
- version replacement candidates are selected by `createdAt`;
- if version candidate timestamps tie, deterministic ID ordering is used.

Conflict detection is meant for mutually exclusive fact slots such as `user location Delhi` versus `user location Bangalore`. For generic "things discussed" memories, MemoGrafter only recognizes a narrow travel destination plan pattern by default. That means `Goa trip plan` and `Vietnam trip plan` can conflict, while `how to cook rajma chawal`, `food in Vietnam`, and `places to visit Vietnam` do not all conflict just because extraction used a generic subject and predicate.

Versioning is meant for explicit replacements such as `user location Delhi` followed by `user location Actually Bangalore now`. The extraction prompt asks adapters to preserve update cues in memory values because the built-in crawler operates on stored memory rows and does not inspect the original conversation text.

`DecayScoringPass` uses confidence-weighted exponential recency decay:

```text
recency_factor = exp(-(ln(2) / half_life_days) * age_days)
decay_score = confidence * recency_factor
```

If `decay_score < minScore`, the memory is marked `decayed: true`. Superseded memories, forgotten memories, and already decayed memories are skipped. Conservative defaults are used when options are omitted:

```ts
new DecayScoringPass({
  halfLifeDays: 90,
  minScore: 0.25,
});
```

By default the pass does not change stored `confidence`; confidence is treated as extraction confidence, while decay score is temporal freshness. If you explicitly want the score written back as confidence, pass `updateConfidence: true`.

When conflicts are found:

- both active facts get `hasConflict: true`;
- a `conflicts` memory edge is created;
- neither fact is superseded.

When explicit replacements are found:

- the older fact gets `supersededBy` pointing to the newer fact;
- an `updates` edge is created as `newer_memory --updates--> older_memory`.
- stale active memories can be marked `decayed: true` by the decay pass.

Crawler maintenance is non-destructive. It annotates existing memory rows and creates memory edges. It does not delete nodes, does not rebuild topics, and does not rewrite topic summaries. Forgotten memories and memories attached to suppressed topics are ignored by maintenance scans.

Existing incorrect conflict edges are not automatically deleted. If an older crawler run created a false-positive edge, handle cleanup with a future explicit pruning pass or filter displayed memory edges to active memories in your app.

Do not put crawler behavior inside `clearSession()`. `clearSession()` is a destructive reset. The crawler is a non-destructive maintenance worker. If you intentionally rebuild a session graph, use this order:

```ts
await agent.clearSession();
await memo.ingestNow(messages, sessionId);
await crawler.runOnce();
```

## Absorbing Memory Into Another Chatbot

Use `absorbFromAgent()` to copy selected memory from one chatbot into another.

```ts
const travelBot = new MemoGrafterAgent(config);
const writingBot = new MemoGrafterAgent(config);

await travelBot.initialize();
await writingBot.initialize();

await travelBot.invoke("I am planning a Japan trip.");
await travelBot.invoke("I like quiet towns, bookstores, and local cafes.");
await travelBot.invoke("My budget is around 2500 dollars.");

const copiedNodes = await writingBot.absorbFromAgent(travelBot, {
  prompt: "Japan travel preferences",
  minSimilarity: 0.6,
  limit: 3,
});

console.log(`Copied ${copiedNodes.length} nodes.`);

const response = await writingBot.invoke(
  "Suggest a reflective blog intro for my Japan trip."
);

console.log(response);
```

Absorbing copies selected topic nodes into the target session and creates `grafted` edges back to their source nodes. It also copies active memory facts attached to those topic nodes into the target session so future `recall()` and `invoke()` calls can surface the transferred context. Decayed, superseded, forgotten, or suppressed-topic source memories are not copied.

Each copied topic node is recorded in the graft registry. Registry entries let you answer where a graft came from and which copied destination node owns it.

Known limitation: if a source topic node has no associated memory rows in `mg_memory_nodes`, there are no facts to copy. The topic node can still be grafted, but targeted recall will not return facts for that node unless memory extraction produced them.

### Inspect Graft Registry

```ts
const registry = await writingBot.getGraftRegistry();

for (const entry of registry) {
  console.log({
    nodeId: entry.nodeId,
    sourceSessionId: entry.sourceSessionId,
    sourceNodeId: entry.sourceNodeId,
    graftedAt: entry.graftedAt,
  });
}
```

Use this when your app needs to display transferred memory provenance or decide which graft to remove.

### Remove A Graft

```ts
const registry = await writingBot.getGraftRegistry();
await writingBot.removeGraft(registry[0]!.nodeId);
```

`removeGraft()` removes the copied graft node from the current session. The registry row is removed with it. The method is scoped to the current agent session and throws if the node is not a registered graft for that session.

### Absorb By Semantic Prompt

```ts
await targetAgent.absorbFromAgent(sourceAgent, {
  prompt: "Japan travel preferences",
  minSimilarity: 0.6,
  limit: 3,
});
```

Use this when you want MemoGrafter to find relevant memory by meaning.

### Absorb By Topic ID

```ts
const sourceNodes = await sourceAgent.getActiveNodes();

await targetAgent.absorbFromAgent(sourceAgent, {
  topicIds: [sourceNodes[0]!.id],
});
```

Use this when your UI lets a user choose memory nodes manually.

### Ingest Grafted Nodes Directly

```ts
const graft = await sourceAgent.graft();
await targetAgent.ingestGraftedNodes(graft.nodes);
```

Use this when you want to inspect or filter a graft before copying it.

## Configuration

Full shape:

```ts
const agent = new MemoGrafterAgent({
  db: {
    connectionString: process.env.DATABASE_URL!,
  },
  llm,
  embedder,
  drift: {
    mode: "intent",
    windowSize: 5,
    driftSensitivity: "medium",
    adaptiveSensitivity: {
      enabled: false,
    },
    minSegmentMessages: 3,
    llmAmbiguityDetection: false,
    reentryDetection: true,
    reentryThreshold: 0.85,
  },
  graph: {
    topK: 5,
    hopDepth: 2,
  },
  inject: {
    bufferSize: 4,
    tokenBudget: 1500,
    recentWindowSize: 20,
    recallLimit: 6,
    recallMinSimilarity: 0.55,
  },
  cache: {
    connectionString: process.env.REDIS_URL!,
    ttlSeconds: 90,
  },
});
```

### `db`

```ts
db: {
  connectionString: process.env.DATABASE_URL!,
}
```

PostgreSQL connection string used by the built-in `PostgresGraphStore`.

MemoGrafter currently constructs `PostgresGraphStore` from this config internally. Advanced users can also import the storage contract directly:

```ts
import {
  PostgresGraphStore,
  type GraphStore,
} from "memo-grafter";

const store: GraphStore = new PostgresGraphStore(process.env.DATABASE_URL!);
```

`GraphStore` is the public storage interface. `PostgresGraphStore` is the default PostgreSQL and pgvector implementation.

Do not call `store.migrate()` from normal application startup. Use `npx memo-grafter migrate` during setup or deploy so schema changes happen intentionally before your app starts serving traffic.

Useful store inspection methods include:

- `getNodesBySession(sessionId, options?)`: read topic nodes for a session, optionally filtered by tags.
- `getTopicNode(topicNodeId, sessionId?)`: read one topic node by ID.
- `getSegmentsBySession(sessionId)`: read topic segments for a session.
- `getEdgesByType(sessionId, type)`: inspect graph edges such as `"reentry"`, `"semantic"`, `"temporal"`, or `"grafted"`.
- `getEdgesBySession(sessionId)`: read all topic edges where either endpoint belongs to the session's topic nodes.
- `getMemoriesBySession(sessionId)`: read all memory nodes for a session, including decayed and superseded rows.
- `getMemoryEdgesBySession(sessionId)`: read memory-level edges such as `conflicts` and `updates`.
- `getGraftRegistry(sessionId)`: read graft provenance entries for a session.
- `setSessionTags(sessionId, tags)`: replace the normalized tag set on existing topic and memory rows for a session.

### `llm`

```ts
llm: new OpenAILLMAdapter("gpt-4o")
```

Adapter used to generate assistant responses and summarize segments.

OpenAI response streaming is opt-in. When enabled, `complete()` still returns the full final response, and `onChunk` receives text chunks as they arrive:

```ts
llm: new OpenAILLMAdapter("gpt-4o", {
  streaming: true,
  onChunk: (chunk) => process.stdout.write(chunk),
})
```

Anthropic models can be used with the included Anthropic adapter:

```ts
llm: new AnthropicLLMAdapter("claude-sonnet-4-5")
```

Gemini models can be used with the included Gemini adapter:

```ts
llm: new GeminiLLMAdapter("gemini-2.5-flash")
```

### `embedder`

```ts
embedder: new OpenAIEmbedAdapter("text-embedding-3-small")
```

Adapter used to create vectors for semantic search.

Anthropic does not provide a native embedding API. Pair `AnthropicLLMAdapter` with `OpenAIEmbedAdapter` or another custom `EmbedAdapter`.

Gemini embeddings can be used with the included Gemini embedder:

```ts
embedder: new GeminiEmbedAdapter("gemini-embedding-001")
```

`GeminiEmbedAdapter` requests 1536-dimensional embeddings by default to match MemoGrafter's current `vector(1536)` database schema. If you change the schema dimension, pass the matching value as the second constructor argument.

### `drift`

```ts
drift: {
  mode: "intent",
  windowSize: 5,
  driftSensitivity: "medium",
  adaptiveSensitivity: {
    enabled: false,
  },
  minSegmentMessages: 3,
  llmAmbiguityDetection: false,
  reentryDetection: true,
  reentryThreshold: 0.85,
}
```

Controls topic boundary detection.

- `mode`: `"intent"` or `"window"`.
- `windowSize`: message window size for window mode.
- `driftSensitivity`: preferred sensitivity preset, one of `"low"`, `"medium"`, or `"high"`.
- `adaptiveSensitivity`: optional session-history based threshold tuning. Disabled by default.
- `threshold`: deprecated numeric threshold. It still works when `driftSensitivity` is not set, but MemoGrafter logs a one-time warning.
- `minSegmentMessages`: minimum messages before a boundary.
- `llmAmbiguityDetection`: optional LLM check for borderline topic shifts. Defaults to `false`.
- `reentryDetection`: whether to link later topic returns back to earlier topic nodes. Defaults to `true`.
- `reentryThreshold`: embedding similarity threshold for reentry detection. Defaults to `0.85`.

Use `"intent"` for most chatbot memory demos. In intent mode, user messages drive topic shifts.

Sensitivity presets resolve internally to numeric thresholds:

- `"low"`: `0.25`
- `"medium"`: `0.35`
- `"high"`: `0.50`

Use `"medium"` first. Boundaries are cut when a drift score exceeds the resolved threshold, so lower numeric thresholds split more readily and higher numeric thresholds require stronger evidence.

If both `driftSensitivity` and `threshold` are provided, `driftSensitivity` wins.

#### Adaptive Sensitivity

Adaptive sensitivity is opt-in and keeps the configured `driftSensitivity` as its baseline. When enabled, MemoGrafter looks at recent saved segments for the session and nudges the resolved threshold by a small bounded step:

```ts
drift: {
  mode: "intent",
  driftSensitivity: "medium",
  adaptiveSensitivity: {
    enabled: true,
    minSegments: 4,
    lookbackSegments: 8,
    targetSegmentMessages: {
      min: 3,
      max: 8,
    },
    adjustmentStep: 0.05,
    maxAdjustment: 0.1,
  },
}
```

If recent segments are consistently short, MemoGrafter raises the threshold slightly to reduce fragmentation. If recent segments are consistently long, it lowers the threshold slightly to split more readily. It does not adapt until enough segment history exists, and it skips adjustment when recent segment lengths are too erratic.

#### Reentry Detection

Reentry detection handles conversations that leave a topic and later return to it:

```text
database choice -> authentication flow -> database connection pooling
```

Without reentry detection, the later database discussion is just another topic node. With reentry detection, MemoGrafter creates a `reentry` edge from the later database node back to the earlier database node.

This helps graph traversal and memory injection recover earlier related context. A later question about connection pooling can still be connected to the original PostgreSQL/ACID discussion.

Reentry edges are written between newly ingested topic nodes, and can also point from a new node back to an existing durable topic node when the detector recognizes a return to earlier context.

### `graph`

```ts
graph: {
  topK: 5,
  hopDepth: 2,
}
```

Controls graph retrieval and traversal.

- `topK`: number of similar nodes to retrieve.
- `hopDepth`: how far grafting walks graph neighbors.

### `inject`

```ts
inject: {
  bufferSize: 4,
  tokenBudget: 1500,
  recentWindowSize: 20,
  recallLimit: 6,
  recallMinSimilarity: 0.55,
}
```

Controls memory prompt sizing, invoke-time recall, and the raw history window sent to the LLM.

- `bufferSize`: nearby raw messages to include.
- `tokenBudget`: approximate token budget used for graft prompt assembly.
- `recentWindowSize`: number of newest raw chat messages to send after the optional invoke-time memory system message. Defaults to `20`.
- `recallLimit`: max memory facts to fetch for automatic invoke-time recall. Defaults to `6`.
- `recallMinSimilarity`: similarity floor for automatic invoke-time recall. Defaults to `0.55`.

When `MemoGrafterAgent.invoke()` sees existing topic nodes for the session, it calls recall with the current user message, prepends the returned memory prompt as a system message when facts are found, and keeps the last `recentWindowSize` raw messages. If recall fails or returns no facts, it uses only that recent raw window plus the current user message.

### `cache`

```ts
cache: {
  connectionString: process.env.REDIS_URL!,
  ttlSeconds: 90,
}
```

Enables an opt-in Redis cache for targeted recall. MemoGrafter creates one shared Redis client and uses it to cache only the raw `searchMemories()` result. It does not cache final prompts, filtered blocks, or `RetrievalResult`, so different `tokenBudget` values still assemble fresh output.

- `connectionString`: Redis URL.
- `ttlSeconds`: cache TTL in seconds. Defaults to `90` and is clamped between `60` and `120`.

Recall cache keys include the session ID, `candidateLimit`, candidate-strategy version, retrieval scope and tags, and a deterministic hash of the query embedding. Redis failures are logged as warnings and recall falls back to PostgreSQL search. The cache is disabled unless this section is present.

When tag-aware recall is used, cache keys also include recall `scope`, `tagMode`, and the normalized tag list. This prevents untagged, session-filtered, and cross-session tagged recall from sharing cached search results.

## Manual Smoke Tests

From this repository, run the session-tagging smoke with a real PostgreSQL database:

```powershell
npx tsx --env-file=.env ./tests/manual/graft/session-tags-smoke.ts
```

Run the OpenAI streaming smoke with a real `OPENAI_API_KEY`:

```powershell
npx tsx --env-file=.env ./tests/manual/providers/openai-streaming-smoke.ts
```

Run the semantic grafting smoke with a real PostgreSQL database:

```powershell
npx tsx --env-file=.env ./tests/manual/graft/graft-by-relevance-smoke.ts
```

Run the memory lifecycle smoke with a real PostgreSQL database and `OPENAI_API_KEY`:

```powershell
npx tsx --env-file=.env ./tests/manual/graft/memory-lifecycle-smoke.ts
```

Run the memory history smoke with a real PostgreSQL database:

```powershell
npx tsx --env-file=.env ./tests/manual/graft/memory-history-smoke.ts
```

Use the forward-slash path in PowerShell. An unquoted backslash path can be collapsed before `tsx` receives it.

The smoke creates two tagged sessions, writes one memory into each, verifies current-session tag filtering with `getActiveNodes()`, and verifies cross-session project recall with `recall(..., { scope: "tagged" })`. If you run it repeatedly against the same database, tagged recall can return rows from previous smoke runs because those historical sessions are still present.

## Queue Mode

Without queue config, ingestion runs synchronously after `invoke()`.

With queue config, MemoGrafter uses BullMQ and Redis:

```ts
const agent = new MemoGrafterAgent({
  db: {
    connectionString: process.env.DATABASE_URL!,
  },
  llm: new OpenAILLMAdapter("gpt-4o"),
  embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
  queue: {
    redisUrl: process.env.REDIS_URL!,
    removeOnComplete: true,
    removeOnFail: true,
  },
});
```

Queue mode is useful when ingestion becomes too slow to run inline. Redis connection problems are logged as warnings and should not throw from normal chatbot invocation.

For agent conversations, a normal BullMQ job contains the latest user-assistant pair plus an absolute `startIndex`. The worker does not receive the complete session history: it loads up to six preceding messages from `mg_message_buffer` and combines them with the new pair for the existing drift calculation. Only the new, unprocessed messages are written back to the message buffer.

Whether ingestion runs inline or through the queue, MemoGrafter uses the stored ingest cursor to skip completed jobs, trim partially overlapping retries, and prevent duplicate topic nodes. A job arriving after a gap can recover the missing contiguous range when those messages were already persisted; otherwise it fails without advancing the cursor. If Redis rejects an enqueue before a job is created, `MemoGrafterAgent` retains the unsent range and includes it in the next enqueue attempt. Normal successful jobs remain two messages.

Optional queue telemetry reports job kind, logical message count, serialized payload bytes, and queue timing. These metrics can be used to confirm that normal conversation jobs remain constant-sized as session history grows.

## Custom Adapters

You can use any model provider if you implement the public adapter interfaces.

Custom LLM adapter:

```ts
import type { LLMAdapter, Message } from "memo-grafter";

class MyLLMAdapter implements LLMAdapter {
  async complete(messages: Message[], system?: string): Promise<string> {
    // Call your model provider here.
    return "Assistant response";
  }
}
```

Custom embedding adapter:

```ts
import type { EmbedAdapter } from "memo-grafter";

class MyEmbedAdapter implements EmbedAdapter {
  async embed(text: string): Promise<number[]> {
    // Return an embedding vector from your provider here.
    return [];
  }
}
```

Use them normally:

```ts
const agent = new MemoGrafterAgent({
  db: {
    connectionString: process.env.DATABASE_URL!,
  },
  llm: new MyLLMAdapter(),
  embedder: new MyEmbedAdapter(),
});
```

Your embedding vector dimension must match the vector dimension expected by the database schema.

## Storage Backends

MemoGrafter exposes storage through the `GraphStore` interface. The built-in implementation is `PostgresGraphStore`, which stores relational data, graph edges, and vector search data in PostgreSQL with `pgvector`.

Most users do not need to instantiate a store directly. `MemoGrafter` and `MemoGrafterAgent` use `PostgresGraphStore` from the `db.connectionString` config:

```ts
const agent = new MemoGrafterAgent({
  db: {
    connectionString: process.env.DATABASE_URL!,
  },
  llm,
  embedder,
});
```

If you are extending MemoGrafter, use `GraphStore` as the contract and keep concrete storage details behind an implementation:

```ts
import type { GraphStore } from "memo-grafter";

class MyGraphStore implements GraphStore {
  // Implement the full GraphStore contract.
}
```

Future storage implementations can use the same interface without changing pipeline or fleet code. For example, a SQLite plus vector-database implementation would implement `GraphStore` while preserving the same behavior expected by ingestion, grafting, and fleet APIs.

## Using Pipelines Directly

`MemoGrafterAgent` is the recommended starting point, but the underlying
pipeline classes are also exported for developers who want to build custom
agent loops or integrate MemoGrafter memory primitives into an existing
orchestration framework.

Pipeline classes are exported for composability. Their constructors and
internal behavior are not covered by semver stability guarantees until v1.0.
Breaking changes to pipeline internals may occur in minor versions.

Available pipeline exports:

- `IngestPipeline`: incrementally segments new messages, builds topic nodes, extracts memory nodes, and writes graph edges.
- `RetrieverPipeline`: embeds a query, searches memory nodes, and returns a structured `RetrievalResult`.
- `GrafterPipeline`: traverses the topic graph and assembles a token-budget-fitted system prompt.

Example using `RetrieverPipeline` directly:

```ts
import {
  PostgresGraphStore,
  RetrieverPipeline,
  OpenAIEmbedAdapter,
} from "memo-grafter";

const store = new PostgresGraphStore(process.env.DATABASE_URL!);
await store.initialize();

const embedder = new OpenAIEmbedAdapter("text-embedding-3-small");

const retriever = new RetrieverPipeline(store, embedder, {
  limit: 8,
  minSimilarity: 0.55,
  tokenBudget: 1000,
  scoring: {
    similarityWeight: 0.7,
    confidenceWeight: 0.3,
  },
});

const result = await retriever.run(
  "deployment config and Kubernetes namespace",
  sessionId,
);

console.log(result.facts);
console.log(result.systemPrompt);

await store.close();
```

If the CLI cannot run in your deploy, CI, or test environment, `PostgresGraphStore.migrate()` remains available as a manual fallback:

```ts
import { PostgresGraphStore } from "memo-grafter";

const store = new PostgresGraphStore(process.env.DATABASE_URL!);
await store.migrate();
await store.close();
```

Use this fallback as a dedicated setup step, not inside your main app startup path.

When using pipelines directly you are responsible for managing the store
connection lifecycle. Call `store.close()` during graceful shutdown.

`MemoGrafterAgent` remains the batteries-included default. Existing code
that uses `MemoGrafterAgent` does not need to change.

## Fleet API

Fleets let you group color-scoped worker chatbots and use a conductor to graft memory across workers.

```ts
import {
  MemoGrafterFleet,
  OpenAIEmbedAdapter,
  OpenAILLMAdapter,
} from "memo-grafter";

const fleet = new MemoGrafterFleet(
  {
    db: {
      connectionString: process.env.DATABASE_URL!,
    },
    llm: new OpenAILLMAdapter("gpt-4o"),
    embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
  },
  {
    id: "support-fleet",
    name: "Support Fleet",
  }
);

await fleet.initialize();

const conductor = fleet.createConductor();
const billing = await fleet.createWorker({ color: "billing" });
const technical = await fleet.createWorker({ color: "technical" });

await billing.invoke("The customer needs help understanding invoice credits.");
await conductor.graftColorIntoAgent("billing", technical);

const answer = await technical.invoke(
  "Use any relevant billing context while helping with this technical issue."
);

console.log(answer);

await fleet.close();
```

The worker color `conductor` is reserved.

### Shared fleet memory

Fleet memory is a shared parent scope for every worker in a fleet. Use it for
common knowledge such as product docs, company policies, operating procedures,
or global application context.

```ts
await fleet.ingestToFleet(
  "Refund policy: customers can request a refund within 30 days.",
  {
    tags: ["policy"],
    source: "support-handbook",
  }
);

const shared = await fleet.getSharedMemory();
console.log(shared.memories);

const recall = await fleet.recallFromFleet("refund policy");
console.log(recall.facts);
```

Workers keep their own session memory. When a worker should also inherit fleet
knowledge, configure its memory mode:

```ts
const support = await fleet.createWorker({
  color: "support",
  memory: "both",
});

await support.invoke("What is the refund window?");
```

Worker retrieval and relevance grafting can also choose the scope per call:

```ts
await support.recall("refund policy", {
  memory: "fleet",
});

await support.graftByRelevance("refund policy", {
  memory: "both",
  minSimilarity: 0.55,
});
```

Memory modes:

- `"local"`: only the worker session memory.
- `"fleet"`: only the shared fleet memory.
- `"both"`: worker session memory plus shared fleet memory.

The default worker mode is `"local"` for compatibility. You can set
`defaultWorkerMemory: "both"` when creating the fleet if all workers should
inherit shared fleet memory unless overridden.

Prompt-guided fleet grafting:

```ts
await conductor.graftByPrompt("invoice credit policy", technical, {
  minSimilarity: 0.6,
  limit: 3,
});
```

## Example Projects

This repository includes two runnable examples:

```text
examples/basic-chat-memory
examples/chatbot-memory-demo
```

Run the single-agent memory demo:

```bash
cd D:/cohort/projects/project-memoGrafter
npm install
npm run build

cd examples/basic-chat-memory
npm install
cp .env.example .env
npm run dev
```

Run the two-agent grafting demo:

```bash
cd D:/cohort/projects/project-memoGrafter
npm install
npm run build

cd examples/chatbot-memory-demo
npm install
cp .env.example .env
npm run dev
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

The example creates a travel chatbot and a writing chatbot, transfers Japan travel memory, and asks the writing bot to use that transferred context.

## Troubleshooting

### `DATABASE_URL is not reachable`

Check that PostgreSQL is running and the connection string is correct.

Confirm `pgvector` is enabled:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Run the complete diagnostic report:

```bash
npx memo-grafter doctor
```

If Doctor reports that the migration table, migration version, or required core tables are missing, rerun:

```bash
npx memo-grafter migrate
```

### No Topic Nodes Are Created

Common causes:

- The conversation is too short.
- `minSegmentMessages` is too high for the demo.
- The LLM adapter failed.
- The embedding adapter failed.
- Queue mode is enabled and background ingestion has not finished yet.

For small demos, try:

```ts
drift: {
  mode: "intent",
  driftSensitivity: "medium",
  minSegmentMessages: 3,
}
```

If segments are too coarse, try a lower resolved threshold:

```ts
drift: {
  mode: "intent",
  driftSensitivity: "low",
  minSegmentMessages: 2,
}
```

If segments are too fragmented, try a higher resolved threshold:

```ts
drift: {
  mode: "intent",
  driftSensitivity: "high",
  minSegmentMessages: 4,
}
```

### Absorb Copies Zero Nodes

Inspect the source memory:

```ts
console.log(await sourceAgent.getActiveNodes());
```

Then try a lower similarity threshold:

```ts
await targetAgent.absorbFromAgent(sourceAgent, {
  prompt: "Japan travel preferences",
  minSimilarity: 0.3,
  limit: 3,
});
```

### Recall Returns Zero Facts

`recall()` searches atomic memory nodes, not raw chat messages. If it returns no facts:

- Make sure ingestion has completed.
- Confirm memory nodes exist for the session.
- Try a lower `minSimilarity`.
- Try a more specific query that uses the same vocabulary as the original conversation.

Example:

```ts
const result = await agent.recall("Japan travel preferences", {
  minSimilarity: 0.3,
  limit: 5,
});
```

For grafted sessions, also confirm that the source topic had active memory nodes before it was absorbed. Absorbing copies active memory rows, but it cannot create facts for a topic if extraction produced only a topic summary and no `mg_memory_nodes` rows.

### Duplicate Or Unexpected Topic Nodes

MemoGrafter processes only messages after the stored ingest cursor. If you see duplicate topic ranges:

- Confirm your database has the `mg_session_ingest_state` table.
- Confirm the same session ID is being reused for the same agent.
- Check whether `clearSession()` was called, which resets the cursor and removes stored session data.

Incremental ingest can still create semantically similar topic nodes over time. That is expected; node merge and graph compaction are separate maintenance features.

### Redis Warnings

Redis is only used when you pass `queue` or `cache` config. A running Redis container or `REDIS_URL` by itself does not enable either feature; both examples in the generated `src/memo-grafter/mg.config.ts` are commented by default. Doctor reports setup guidance when neither is enabled. If cache Redis is unreachable, Doctor warns without failing readiness because recall falls back to PostgreSQL. If queue Redis is unreachable, Doctor fails readiness because enqueue failure does not currently guarantee a synchronous retry. If both features share one URL, Doctor checks that endpoint once.

### Browser Runtime Error

MemoGrafter is server-side only. Run it in Node.js.

## Production Notes

MemoGrafter v0.1.0 is experimental. Treat it as a starting point for prototypes and evaluation, not a finished production memory platform.

Practical notes:

- Keep secrets in environment variables.
- Use PostgreSQL with `pgvector` enabled.
- Tune `tokenBudget` to control prompt size and cost.
- Use queue mode if ingestion becomes slow.
- Use `clearSession()` only for intentional resets; normal ingestion preserves the graph incrementally.
- Use `forget()`, `forgetMany()`, `suppressTopic()`, and `restoreTopic()` for user-controlled memory lifecycle flows.
- Use the optional recall cache for long sessions with repeated direct or invoke-time recall.
- Store your own user/session mapping outside MemoGrafter.
- Call `close()` during graceful shutdown.
- Do not expose database credentials or OpenAI keys to browser code.
- Run your own evaluation before trusting memory transfer behavior in user-facing flows.

## Public API Overview

Main exports:

- `MemoGrafterAgent`
- `MemoGrafter`
- `MemoGrafterFleet`
- `WorkerAgent`
- `ConductorAgent`
- `AnthropicLLMAdapter`
- `GeminiLLMAdapter`
- `GeminiEmbedAdapter`
- `OpenAILLMAdapter`
- `OpenAIEmbedAdapter`
- `PostgresGraphStore`
- `MemoGrafterCrawler`
- `ConflictDetectionPass`
- `DecayScoringPass`
- `VersioningPass`
- `GrafterPipeline`
- `IngestPipeline`
- `RetrieverPipeline`
- `GraphStore`
- `FleetAgentRecord`
- `RetrievalResult`
- `MemoGrafterOperationOptions`
- `RetrieverConfig`
- `TagFilterOptions`
- `IngestOptions`
- `IngestTextOptions`
- `RememberOptions`
- public shared and fleet types

Useful `GraphStore` inspection methods:

- `getTopicNode(topicNodeId, sessionId?)`
- `getNodesBySession(sessionId, options?)`
- `getSegmentsBySession(sessionId)`
- `getEdgesByType(sessionId, type)`
- `getEdgesBySession(sessionId)`
- `getMemoriesBySession(sessionId)`
- `getMemoryEdgesBySession(sessionId)`
- `getSessionNodeCount(sessionId)`
- `getSessionIngestState(sessionId)`
- `forgetMemory(memoryId)`
- `forgetMemories(memoryIds)`
- `suppressTopic(topicId)`
- `restoreTopic(topicId)`
- `getMemoryHistoryById(memoryId, options?)`
- `getMemoryHistoryByFact(subject, predicate, options?)`
- `getMemoryDiff(fromMemoryId, toMemoryId)`

Common `MemoGrafterAgent` methods:

- `initialize()`: verify that MemoGrafter storage has already been migrated.
- `invoke(message, operationOptions?)`: send a user message and receive an assistant response, with optional cancellation or timeout control.
- `ingestText(text, options?)`: ingest raw text without generating an assistant response.
- `remember(text, options?)`: store explicit natural-language facts or preferences through the text ingestion path.
- `getHistory()`: read local chat history.
- `getSessionId()`: read the current session ID.
- `getGraphSnapshot()`: read a stable graph snapshot with raw topic and memory rows, graph edges, lifecycle metadata, graft metadata, session ID, and capture timestamp for visualization or inspection.
- `getGraftRegistry()`: inspect provenance for grafted nodes in the current session.
- `getActiveNodes(options?)`: inspect topic nodes, optionally filtered by tags.
- `getActiveSegments()`: inspect topic segments.
- `setSessionTags(tags)`: replace tags on the current session and apply them to future ingested memories.
- `getSessionTags()`: read the current agent's normalized session tags.
- `pinTopic(topicId)`: persist an active topic as required system context for this session.
- `unpinTopic(topicId)`: stop automatically injecting a pinned topic.
- `getPinnedTopics()`: list active pinned topics in deterministic pin order.
- `clearSession()`: explicitly clear local history and stored session memory.
- `forget(memoryId)`: soft-forget a memory node so it is excluded from future recall, grafting, absorption, and crawler maintenance.
- `forgetMany(memoryIds)`: soft-forget several memory nodes and return the number changed.
- `suppressTopic(topicId)`: hide a topic from active reads, recall, grafting, absorption, and crawler maintenance.
- `restoreTopic(topicId)`: make a suppressed topic active again.
- `getMemoryHistory(memoryId)`: inspect the current session lineage for a specific memory.
- `getMemoryHistory(subject, predicate)`: inspect the current session lineage for a fact key.
- `getMemoryDiff(fromMemoryId, toMemoryId)`: compare two memory versions and their maintenance relationship.
- `recall(query, options?)`: retrieve structured memory by semantic query, optionally filtered by tags.
- `graft(topicIds?)`: preview memory injection.
- `graftByRelevance(query, options?)`: preview memory injection selected by semantic topic-node relevance.
- `ingestGraftedNodes(nodes)`: copy provided nodes into this agent.
- `absorbFromAgent(sourceAgent, options)`: select and copy memory from another agent.
- `removeGraft(nodeId)`: remove a registered graft node from the current session.
- `close()`: close database and queue resources.
