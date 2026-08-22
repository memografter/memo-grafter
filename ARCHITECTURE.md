# MemoGrafter Architecture

This document describes the high-level architecture and core design of memo-grafter. It is intended for contributors and coding agents who need to understand how the main pieces fit together without duplicating setup or API usage details from `README.md` and `USER_GUIDE.md`.

## System Overview

MemoGrafter is a server-side TypeScript memory framework for chatbot applications. It records conversation turns, groups them into topic segments, extracts structured memory, stores topic and memory graphs, and later retrieves or grafts relevant memory into another prompt or session. Sessions and memory rows can also carry optional normalized tags for project, planning, week, domain, or worker-routing filters. Applications can also apply soft lifecycle state to explicitly forget memory nodes or suppress and restore topic nodes without physically deleting graph rows by default.

The main runtime layers are:

- `MemoGrafterAgent`: the high-level conversational wrapper used by most applications.
- `MemoGrafter`: the internal coordinator that wires storage, pipelines, adapters, optional queueing, and optional recall caching.
- Pipeline classes: ingestion, drift detection, segment processing, retrieval, and graft prompt assembly.
- `MemoGrafterCrawler`: an optional background maintenance worker for deterministic memory conflict detection and versioning.
- `GraphStore`: the persistence boundary for messages, segments, topic nodes, memory nodes, edges, graft provenance, ingest state, and fleet metadata.
- `PostgresGraphStore`: the current built-in `GraphStore` implementation, backed by PostgreSQL and `pgvector`.
- CLI commands: setup, migration, and the local Studio host used for memory graph visibility.

At a simplified level:

```text
user / assistant messages or raw text
  -> message buffer
  -> topic drift detection
  -> topic segments
  -> topic nodes
  -> atomic memory nodes
  -> optional crawler maintenance
  -> graph edges
  -> recall, injection, or grafting
```

## Core Pipeline Flow

The default application flow starts with `MemoGrafterAgent.invoke()`:

1. The agent checks whether the session already has topic nodes in storage.
2. If graph content exists, the agent recalls relevant structured memory for the current user message.
3. The agent builds the LLM message list from an optional recalled-memory system message, a recent raw history window, and the current user message.
4. The configured `LLMAdapter` produces the assistant response.
5. The user message and assistant response are appended to session history.
6. The newly completed user-assistant pair and its absolute start index are queued for background ingestion. If an enqueue attempt fails, the agent retains that unsent range and includes it with the next enqueue attempt.
7. Ingestion persists only unprocessed messages, loads a small preceding overlap from storage, appends new graph state, and updates graph edges.

Applications that already own their LLM call use the split external-integration flow instead. Before generation they call `MemoGrafter.context({ sessionId, query, ...retrieverOptions })` to build fresh prompt-ready memory without invoking the configured LLM or consulting the recall cache. After generation they call `MemoGrafter.analyze({ sessionId, userMessage, assistantMessage, tags? })`; this atomically appends exactly that completed exchange after the durable message buffer and reuses the same drift, extraction, persistence, and edge-building stages. In queue mode the exchange is durably staged before its `append` job is submitted and `analyze()` returns an empty node array after enqueue, so graph visibility follows worker completion.

`MemoGrafterAgent.ingestText()` is a separate write path for non-conversational content. It splits raw text into internal chunks using line, sentence, and maximum-size boundaries, then adds those chunks to the graph ingestion history without adding them to public chat history or running the assistant response-generation call. The existing drift detector runs across the chunks, and the extraction LLM, topic segmentation, memory extraction, and edge-building stages are reused.

The node-count guard avoids an embed and memory search on the first turn or while async ingestion has not produced active graph content. This keeps the foreground chatbot turn simple while memory construction happens after the response. Read and lifecycle calls wait for the agent's local pending-ingest chain. Without queue mode that includes pipeline completion; with BullMQ it covers submission only, and durable graph visibility still depends on worker completion.

## Ingestion Flow

`IngestPipeline` is responsible for turning a session message history into graph state.

```text
indexed messages + sessionId
  -> load session ingest cursor
  -> save only the unprocessed message range
  -> load up to six preceding messages
  -> load existing topic nodes
  -> embed overlap + unprocessed messages
  -> detect topic segments for new message ranges
  -> process each new segment
  -> append temporal, semantic, and reentry edges
  -> add reentry edges when detected
```

The current ingestion model is incremental. `mg_session_ingest_state` tracks the last successfully processed message index for each session, so repeated jobs are no-ops and partially overlapping jobs are trimmed to their unprocessed suffix. Indexed jobs never advance the cursor across a missing range. External `analyze()` calls use `IngestPipeline.append()`, which serializes appends per process and atomically assigns the next absolute index from `mg_message_buffer`; the PostgreSQL store also uses a session advisory lock for cross-process allocation. The graph cursor remains unchanged when extraction fails, allowing the next append to process the contiguous backlog without overwriting it. The BullMQ append path stages the range before enqueue so retries reuse the same indexes. Existing topic nodes, grafted nodes, memory nodes, and graph edges are preserved during normal `invoke()` or external integration processing. `clearSession()` remains available as an explicit reset API rather than a default ingest step.

## Main Components

### CLI And Studio

The CLI is an additive Node.js layer that lives under `cli/` and is built separately into `dist/cli`. Its commands are:

- `memo-grafter init`: required project setup that generates the MemoGrafter-owned `mg-schema.ts` reference and `mg.config.ts` without creating or modifying an application schema entrypoint.
- `memo-grafter migrate`: preferred database setup command that creates or updates MemoGrafter-owned database infrastructure.
- `memo-grafter doctor`: read-only environment diagnostics for runtime, configuration, PostgreSQL, pgvector, migration state, core tables, and optional configured cache Redis.
- `memo-grafter studio`: launch a local Studio host for browsing sessions, inspecting graph/table/prompt-preview state, grafting topics, and applying supported topic suppression and pinning actions.

`migrate` and `studio` first verify that `init` has created the MemoGrafter project files. This keeps application setup explicit and gives the CLI a stable local frame without requiring MemoGrafter to own or discover the host application's schema files. The cloned repository uses unpublished development migration and Doctor runners so contributors can prepare and diagnose its infrastructure without scaffolding consumer files. The repository Doctor checks a standalone `REDIS_URL` as an optional development service; the public Doctor checks Redis only when application cache or queue configuration enables it. Doctor represents missing initialization/configuration as structured failed checks so it can still report every independent diagnostic. Doctor, migration, and Studio resolve an explicit `--db` before `.env` / `DATABASE_URL` and `mg.config.ts`. At startup Studio verifies the MemoGrafter schema through `PostgresGraphStore.verifySchema()`, reads a distinct session count from existing `mg_*` tables, starts an HTTP server on `localhost:2891` or the next available port, opens the browser, and keeps the process alive until termination.

The CLI does not load the provider-bearing package root for database tooling. Migration loads `PostgresGraphStore` from the provider-independent `memo-grafter/store` subpath. Doctor loads schema metadata from `memo-grafter/schema` and uses the PostgreSQL driver directly through shared diagnostic utilities. Studio loads storage from `memo-grafter/store` and preview services from `memo-grafter/studio`. This keeps all three commands runnable when the optional OpenAI, Anthropic, and Gemini SDKs are absent.

Doctor separates check collection from terminal rendering. Each result has a stable ID, section, label, `passed | failed | warning | skipped` status, optional message/help, and a `required` flag. Dependent checks are skipped after an upstream connection failure. Required failures produce exit code `1`, malformed Doctor usage produces `2`, and optional Redis warnings preserve exit code `0`. This model is the compatibility boundary for future JSON, verbose, or repair-oriented output.

The generated `mg.config.ts` keeps both Redis cache and queue examples commented, so `REDIS_URL` alone does not change runtime behavior. Doctor parses active cache and queue configuration after removing comments without damaging URL strings. Cache Redis is optional because retrieval falls back to PostgreSQL; queue Redis is required once queue mode is enabled. Shared cache/queue endpoints are pinged once, while distinct endpoints receive separate results.

Database setup and diagnosis share error classification through `classifyPostgresError()`. Doctor's `checkPostgresConnection()`, `checkPgvectorAvailability()`, `checkPgvectorEnabled()`, and `getMigrationStatus()` keep catalog queries centralized. Migration and Doctor also share package-owned schema constants for required table names, the `mg_migrations` table name, and the current migration version.

Studio includes an internal REST API for the bundled frontend. The API is DB-driven and scoped to one requested session at a time. It reuses `GraphStore` for session graph reads, read-only table data, prompt-preview pipeline execution, and topic suppression, while `cli/studio/repository.ts` contains Studio-only SQL helpers for session listing, ownership checks, scoped edge reads, table browsing, and lexical memory search. Keeping these helpers in the CLI avoids adding required methods to `GraphStore` and preserves compatibility for custom store implementations.

Studio can copy one selected active topic into one or more target sessions. The browser submits source and target identifiers only; the server re-reads the source topic and classifies its memories before preview and execution. Each target copy runs in its own transaction under a target-session advisory lock, copies only active memories, records source provenance in `mg_graft_registry`, and skips an existing source-topic/target-session graft. Grafted copies can be removed only through the dedicated graft-removal route.

The frontend follows a session-first workflow. It loads only the session summary list on landing, then fetches tab data for the selected session on demand. The Graph tab renders topic nodes in a dependency-free SVG graph and shows memory nodes only for the selected topic, keeping large sessions readable while preserving node details, lifecycle/pin badges, curved directional edges, client-side filters, and active-topic pin/unpin controls. Suppressed topics must be restored before pinning. The Tables tab is a read-only database inspection surface with original `mg_*` table names, pagination, and expandable cells for long values. Invoke Preview renders the shared invocation plan as context selection, structured messages, raw memory context, and retrieval explanation, including pinned-topic context. Manual refresh controls let developers reload the session list or the active tab without restarting Studio.

Invoke Preview is backed by `src/studio/StudioPreviewService.ts`, uses the shared `src/invocation/InvocationPlanner.ts`, and is exported through `memo-grafter/studio`. Studio resolves runtime settings from `mg.config.ts`; an embedder activates invocation-time retrieval. Without an embedder, the Invoke Preview tab remains visible but reports that preview is unavailable; database browsing, graph inspection, table inspection, and supported lifecycle actions remain usable without any provider SDK. The preview is a framework-level request and does not claim byte-for-byte provider payload equivalence.

The Studio API is local tooling infrastructure, not a public web service. Authentication and multi-user access control are intentionally out of scope. The bundled Studio frontend is emitted with the CLI build so the package can serve it from `dist` without extra publish-time asset copying.

### MemoGrafterAgent

`MemoGrafterAgent` is the public session-oriented wrapper around `MemoGrafter`. It owns the current session ID, in-memory chat history, base system prompt, invoke-time recall settings, recent history window size, and pending background ingestion promise.

Its responsibilities include:

- accepting user messages through `invoke()`;
- accepting raw non-conversational content through `ingestText()`;
- recalling relevant memory before the LLM call when the session has graph content;
- calling the configured LLM with an optional prepended recall memory block, recent raw turns, and the current user message;
- scheduling ingestion after assistant responses;
- exposing active topic nodes and segments for the current session;
- exposing a read-only graph snapshot for visualization and inspection;
- providing high-level grafting and absorbing helpers;
- providing targeted recall through `RetrieverPipeline`;
- storing optional session tags and applying them to future ingested topic and memory rows;
- exposing explicit memory lifecycle controls for forgetting memory nodes and suppressing or restoring topic nodes;
- waiting for the local pending-ingest chain before dependent reads; in queue mode, worker completion remains a separate consistency boundary.

The agent keeps public conversational history separate from its graph ingestion history. This allows raw text and later chat turns to share one incremental graph cursor while keeping `getHistory()` and invoke-time prompts conversational.

`MemoGrafterAgent` is intentionally a memory-aware chatbot wrapper, not an autonomous agent runtime.

Applications with an existing chatbot or agent runtime can use `MemoGrafter` directly instead. `context()` is the read half of that integration boundary and `analyze()` is the completed-turn write half; the application retains ownership of provider messages, streaming, tools, and response generation.

### IngestPipeline

`IngestPipeline` coordinates the write-side memory pipeline. Agent queue jobs normally carry only the newly completed user-assistant pair plus its absolute start index; after an enqueue failure, the next attempt also carries the retained unsent range. The pipeline reads the session ingest cursor, persists only the unprocessed range, loads up to six preceding messages from storage, embeds that overlap plus the new messages, delegates topic boundary detection to `TopicDriftDetector`, delegates node creation to `SegmentProcessor`, and appends graph edges. The public full-history ingestion APIs are retained and internally reduced to the same unprocessed indexed range.

When adaptive drift sensitivity is enabled, ingestion reads recent saved segments for the session before detection and derives a conservative per-run threshold from the configured static sensitivity. Short, consistently fragmented recent segments raise the threshold slightly; consistently long recent segments lower it slightly. The adjustment is bounded, skipped for short or unstable histories, and does not require schema changes.

It also handles reentry linking in two forms:

- matching newly detected topic boundaries back to existing durable session nodes;
- linking later segments in the current run back to earlier related segments.

### TopicDriftDetector

`TopicDriftDetector` decides where topic boundaries occur. It supports two modes:

- `intent`: evaluates user-message intent changes against the current topic embedding.
- `window`: compares moving windows of message embeddings.

Drift scoring combines embedding distance with message-level signals from the drift utilities. The detector also supports:

- minimum segment length checks to avoid over-fragmenting short runs;
- optional LLM ambiguity detection for borderline shifts;
- optional reentry detection, where a new segment is linked back to an earlier matching topic.

The output is a list of drift segments plus a reentry map used later by ingestion.

### SegmentProcessor

`SegmentProcessor` converts a detected segment into persisted graph objects.

For each segment it:

1. builds a segment extraction prompt from the segment messages;
2. parses the LLM extraction into a label, summary fields, and typed memories;
3. builds and embeds the segment summary before graph persistence begins;
4. prepares the topic node from the extracted fields;
5. atomically saves the `TopicSegment` and `TopicNode`, preserving an existing topic ID on retry;
6. embeds and inserts atomic `MemoryNode` records;
7. builds semantic memory edges inside the topic when appropriate.

Provider and embedding failures therefore leave buffered messages available for retry without creating orphan segment rows. Memory persistence remains best-effort after the topic is durable.

The topic node is the coarse unit of conversation memory. Memory nodes are the finer-grained facts, insights, questions, tasks, or references used by targeted recall. When ingestion receives tags, the same normalized tag set is written to the topic node and every memory node produced for that segment.

### GrafterPipeline

`GrafterPipeline` assembles memory injection context from selected topic nodes.

It starts from requested topic IDs, expands through graph neighbours up to the configured hop depth, orders nodes by conversation position, and formats each topic with a small configurable message buffer around its source range. It then trims from the end until the assembled system prompt fits the configured token budget. Per-call options can override hop depth or disable graph expansion so only the provided seed nodes are formatted.

This pipeline is used by `MemoGrafter.inject()`, `MemoGrafterAgent.graft()`, and semantic grafting. `graft()` passes explicit topic IDs directly into the pipeline. `graftByRelevance()` first embeds the query, selects seed topic nodes with `GraphStore.getSimilarNodes()`, then reuses the same graft assembly path with optional graph expansion from those seeds. Copying memory into another session is handled by store-level node absorption, followed by edge updates.

When selected topics contain crawler-maintained conflict or version metadata, graft prompt assembly keeps the original topic summary intact and adds deterministic maintenance notes plus active memory facts. This is important because topic summaries are historical segment summaries and may contain older facts. The prompt explicitly tells downstream LLMs to prefer active memory facts over contradictory historical summary details instead of rewriting stored summaries.

Absorption copies selected topic nodes into the target session and records `grafted` edges back to their source nodes. The PostgreSQL store also copies active memory nodes attached to those topics so targeted recall can search the transferred facts. Copied memory rows get fresh IDs, preserve their embeddings, reset `superseded_by` to `NULL`, reset `decayed` to `FALSE`, and are copied only when the source memory is active. Suppressed source topics and forgotten source memories are not copied.

The same store-level absorption path inserts `mg_graft_registry` rows for copied topic nodes. Keeping registry writes in `PostgresGraphStore.absorbNodes()` means `MemoGrafterAgent`, direct graft ingestion, and fleet grafting all get provenance tracking without duplicating logic.

### GraphStore

`GraphStore` is the persistence interface used by the core and pipeline layers. It keeps storage-specific concerns out of the orchestration code.

The interface covers:

- initialization and shutdown;
- message buffer persistence;
- segment, topic node, and topic edge persistence;
- memory node insertion, memory lookup, and memory edge construction;
- optional session and memory tag updates and tag-aware read filters;
- explicit lifecycle state updates for forgotten memories and suppressed/restored topics;
- memory history and diff reads derived from memory rows and maintenance edges;
- session snapshot reads for topic edges, memory nodes, and memory edges;
- memory maintenance reads and annotations for crawler passes;
- session topic-node counts for invoke-time recall guards;
- session ingest cursor reads and writes for incremental ingestion;
- vector similarity queries for topic and memory retrieval;
- graph neighbourhood traversal;
- grafted node absorption, provenance registry reads, and graft node deletion;
- fleet and agent metadata;
- explicit session clearing.

The built-in `PostgresGraphStore` creates and manages the current schema, including `mg_message_buffer`, `mg_segments`, `mg_topic_nodes`, `mg_topic_edges`, `mg_memory_nodes`, `mg_memory_edges`, `mg_sessions`, `mg_session_ingest_state`, `mg_graft_registry`, `mg_fleets`, and `mg_fleet_agents`, plus the `mg_migrations` metadata table. `mg_topic_nodes` and `mg_memory_nodes` both include `tags TEXT[] NOT NULL DEFAULT '{}'` plus GIN indexes for tag filters. `mg_memory_nodes` also carries `forgotten BOOLEAN NOT NULL DEFAULT FALSE` and `forgotten_at`; `mg_topic_nodes` carries `suppressed BOOLEAN NOT NULL DEFAULT FALSE` and `suppressed_at`.

The public `PostgresGraphStore.migrate()` method remains available for advanced CI, deploy, test, or constrained runtime tooling. It is an escape hatch around the CLI, not the recommended app startup path. Migration creates or updates extensions, core tables, compatibility columns, and indexes, then creates `mg_migrations` and records the current version only after the schema work succeeds. Normal applications should run `memo-grafter init`, `memo-grafter migrate`, and `memo-grafter doctor` outside request handling before constructing agents.

Most store reads used by recall, grafting, semantic seed selection, neighbourhood expansion, absorption, and maintenance are active reads. They exclude forgotten memories and suppressed topics at the storage boundary so callers do not need to duplicate lifecycle filtering.

`MemoGrafterAgent.getGraphSnapshot()` is a read-side convenience over this storage boundary. It returns the current session ID, deterministic topic nodes, topic node wrappers with lifecycle and optional graft provenance, topic edges that touch the session's nodes, all memory nodes for the session, memory wrappers with lifecycle metadata, memory edges that touch those memories, and an ISO capture timestamp. The raw `nodes`, `edges`, `memories`, and `memoryEdges` arrays remain available for backward-compatible callers, while `snapshotNodes` and `snapshotMemories` are the stable UI-facing wrappers. It does not include `mg_message_buffer` content, rendering metadata, layout information, or color decisions. Unlike targeted recall, snapshot memory reads intentionally include forgotten, decayed, conflicted, and superseded memory rows, and snapshot topic reads include suppressed topic rows, so callers such as visualizers can decide what to show.

### Explicit Lifecycle Controls

Explicit lifecycle controls are application-facing soft pruning operations:

- `forget(memoryId)` marks a memory row as `forgotten = TRUE` and sets `forgotten_at`.
- `forgetMany(memoryIds)` performs the same update in bulk and returns the changed-row count.
- `suppressTopic(topicId)` marks a topic row as `suppressed = TRUE` and sets `suppressed_at`.
- `restoreTopic(topicId)` clears topic suppression and its timestamp.

Forgetting is intentionally one-way at the public API layer. MemoGrafter does not expose `restoreMemory()` because privacy and deletion workflows usually prefer conservative behavior. Storage implementations can still retain enough metadata for application-specific audit, hard-delete, or undo policies.

Lifecycle controls are not physical deletes. They preserve graph rows and provenance while changing active participation. Forgotten memory nodes are excluded from targeted recall, invoke-time recall, graft prompt active facts and maintenance notes, absorption, memory edge construction, and crawler maintenance. Suppressed topic nodes are excluded from active topic reads, topic similarity search, fleet topic search, graph neighbourhood expansion, graft prompt assembly, absorption, and crawler maintenance until restored.

When recall caching is enabled, successful lifecycle changes clear MemoGrafter recall cache entries. This prevents recently forgotten or suppressed content from being returned through a stale vector-search cache entry.

### Memory History Reads

Memory history APIs are read-only audit helpers layered on the existing graph schema. They do not introduce a separate event store.

The store derives history from:

- `mg_memory_nodes` rows matching a memory's normalized `subject` and `predicate`;
- `superseded_by` pointers on memory rows;
- `mg_memory_edges` rows with `edge_type = 'updates'`;
- `mg_memory_edges` rows with `edge_type = 'conflicts'`;
- lifecycle metadata such as `decayed`, `forgotten`, and `has_conflict`.

`getMemoryHistory(memoryId)` anchors the lookup at a memory row, loads memories in the same session with the same normalized fact key, and folds in directly connected update/conflict edge endpoints. `getMemoryHistory(subject, predicate)` loads the complete fact-key lineage for the requested scope. `MemoGrafterAgent` passes its current session ID by default; direct `MemoGrafter` callers can provide a `sessionId` option.

History reads intentionally include memory rows that active retrieval ignores, including superseded, decayed, forgotten, and suppressed-topic memories. This lets audit and governance tools answer what the system believed before an update and why a current fact replaced or conflicts with earlier data.

`getMemoryDiff(fromMemoryId, toMemoryId)` performs a deterministic structural comparison. It compares stored memory fields and reports whether the two rows are connected by `superseded_by`, `updates`, or `conflicts` metadata. It does not call an LLM and does not synthesize natural-language explanations.

### MemoGrafterCrawler

`MemoGrafterCrawler` is an optional graph maintenance worker. It can be run manually with `runOnce()` or scheduled in-process with `start()` and `stop()`. The crawler does not require Redis or queues, and `intervalMs` only controls the recurring loop started by `start()`; it has no effect on a direct `runOnce()` call.

The built-in maintenance passes are deterministic:

- `ConflictDetectionPass` groups active memories by session, normalized `subject`, and normalized `predicate`. A group conflicts when it contains different normalized `value` strings and the newest value does not carry an explicit update cue. Decayed, forgotten, suppressed-topic, and already superseded memories are skipped.
- `VersioningPass` uses a separate version classifier. It only accepts competing groups whose newest memory carries an explicit replacement or update cue such as `actually`, `now`, `changed to`, or `instead`, then marks older memories with `superseded_by` and creates version edges.
- `DecayScoringPass` scores non-superseded active memories with confidence-weighted exponential recency decay. Forgotten memories and suppressed-topic memories are skipped. Memories whose score falls below the configured threshold are marked `decayed = TRUE`.

Conflict grouping treats broad topic memories carefully when both the subject and predicate are generic, such as `user asked_about ...` or `conversation discussed ...`. Most broad topic rows are skipped because they describe what was discussed rather than mutually exclusive fact slots. Recognized travel destination plan rows are partitioned into a deterministic `travel-trip-plan` bucket and compared by destination, so `Goa trip plan` can conflict with `Vietnam trip plan`, while unrelated topics like `how to cook rajma chawal` or non-exclusive Vietnam subtopics do not join that conflict group. Plain disagreements remain active conflicts; they are not superseded merely because one memory is newer.

Decay scoring uses:

```text
age_days = now - created_at
recency_factor = exp(-(ln(2) / half_life_days) * age_days)
decay_score = confidence * recency_factor
```

The crawler annotates existing memory rows and creates memory edges. It never deletes graph nodes. Conflict detection marks both sides with `has_conflict = TRUE` and creates an idempotent `conflicts` edge. Versioning creates an idempotent `updates` edge using this direction:

```text
newer_memory --updates--> older_memory
```

The original topic summaries are not rewritten. Topic summaries remain historical descriptions of the segment that produced them, while memory-node lifecycle fields and memory edges represent current fact status. The decay pass does not create edges by default; it only marks stale active memory rows as decayed. Stored extraction confidence remains unchanged unless a caller explicitly enables confidence updates on the pass.

The crawler does not delete or prune existing conflict edges. If an older version of the crawler created a false-positive edge, that edge remains historical graph data until a future explicit cleanup pass or display-side active-edge filter handles it.

## Recall Path

Targeted recall is handled by `RetrieverPipeline`, which is used by `MemoGrafterAgent.recall()`.

The recall path embeds the query, searches active memory nodes by vector similarity, filters decayed, superseded, forgotten, or suppressed-topic memories, combines each fact's similarity and confidence into a confidence-weighted retrieval score, groups facts by parent topic node, ranks those topic blocks by best fact retrieval score, and formats a token-budgeted system prompt.

Recall can be tag-aware. With no tag options, recall stays scoped to the current session. With `tags`, the default scope is `session-and-tags`, which filters current-session memories by tag. With `scope: "tagged"`, recall can search active memories across sessions that match the supplied tags. Tag matching supports `tagMode: "all"` with PostgreSQL `@>` semantics and `tagMode: "any"` with `&&` semantics. Tags are normalized by trimming, lowercasing, deduplicating, and sorting before storage or retrieval.

When `cache` config is provided, `MemoGrafter` owns one shared Redis client for recall caching. `RetrieverPipeline` uses that client only around the raw memory vector search, caching the `store.searchMemories()` result before defensive stale-memory filtering and prompt assembly. Cache keys include the session ID, `limit`, `minSimilarity`, recall scope, tag mode, normalized tag list, and a short hash of the embedding. TTL is clamped to 60-120 seconds, defaulting to 90 seconds. Redis errors are logged as warnings and retrieval falls back to the store. Successful lifecycle changes clear recall cache keys so stale cached search results do not reintroduce forgotten or suppressed memory.

`MemoGrafterAgent.invoke()` also uses this path before each LLM call when the session has at least one topic node. It uses the current user message as the recall query, calls `recall()` with `inject.recallLimit` and `inject.recallMinSimilarity` defaults of `6` and `0.55`, injects the returned `systemPrompt` as a single prepended system message when facts are found, and keeps only the last `inject.recentWindowSize` raw messages. If the session has no topic nodes, recall returns no facts, or recall fails, the agent proceeds with raw history only and does not fail the foreground `invoke()` call.

This read-side path is separate from grafting:

- recall returns atomic memories and parent topics for a query;
- graph snapshots return raw graph inspection data for a session;
- explicit grafting assembles broader topic context from selected topic nodes and their neighbours;
- semantic grafting selects topic-node seeds by query similarity before using the same graft assembly path;
- absorbing copies selected topic nodes and their active atomic memories into another session.

Crawler versioning, decay, and explicit lifecycle controls feed this path through lifecycle fields. Once an older memory has `superseded_by` set, a stale memory has `decayed = TRUE`, a memory has `forgotten = TRUE`, or a topic has `suppressed = TRUE`, targeted recall and absorption treat it as inactive without needing a separate conflict-resolution step.

## Data And Graph Lifecycle

MemoGrafter stores memory in two related layers:

- Topic layer: `TopicSegment`, `TopicNode`, and `TopicEdge`.
- Memory layer: `MemoryNode` and `MemoryEdge`.

The lifecycle for a normal conversation is:

1. Raw messages are persisted in `mg_message_buffer` by session and message index.
2. Drift detection splits the message range into topic segments.
3. Each segment is saved in `mg_segments`.
4. Each segment produces one topic node in `mg_topic_nodes`.
5. Segment extraction may produce multiple memory nodes in `mg_memory_nodes`.
   When session tags are supplied, topic and memory nodes receive the normalized tag array.
6. Topic edges are appended:
   - `temporal` edges link adjacent topic nodes;
   - `semantic` edges link similar topic nodes;
   - `reentry` edges link a returned topic to an earlier related topic.
7. Memory edges may link semantically related memories within a topic.
8. Grafted topic nodes are copied into a target session, registered in `mg_graft_registry`, linked to their source with `grafted` edges, and accompanied by copies of active memory nodes when those memories exist.
9. Optional crawler passes can annotate active memory nodes with `has_conflict`, set `superseded_by` on older conflicting facts, mark stale active facts as `decayed`, and add `conflicts` or `updates` edges in `mg_memory_edges`.
10. Applications can explicitly mark individual memory nodes as forgotten or suppress entire topic nodes. Those rows remain in the graph for audit/snapshot reads, but active recall, grafting, absorption, and crawler operations ignore them.

During normal ingestion, existing graph state is not cleared. New topic nodes and memory nodes are appended after the stored ingest cursor, and new edges can connect them to prior native or grafted nodes. `clearSession()` is an explicit destructive reset for callers that intentionally want to remove stored session memory.

## Current Architecture Decisions

- **Server-only runtime:** `MemoGrafter` checks for browser globals and is designed for Node.js server environments.
- **Adapter boundary:** model providers are represented by `LLMAdapter` and `EmbedAdapter`, keeping provider-specific code outside the pipelines.
- **Storage boundary:** core logic depends on `GraphStore`; PostgreSQL with `pgvector` is the current implementation, not a requirement baked into pipeline code.
- **Incremental graph growth:** ingestion processes only new message ranges and preserves existing graph state by default; explicit `clearSession()` is the reset path.
- **Separate topic and memory layers:** topic nodes preserve conversational structure, while memory nodes support precise fact-level recall.
- **Optional tag filters:** tags are additive metadata on topic and memory rows. Untagged sessions keep existing behavior, while tagged recall can support project-scoped, planning-scoped, or future worker-routed retrieval.
- **Non-destructive maintenance and pruning:** crawler passes and application lifecycle controls annotate memory state and topic state without deleting graph data or rewriting historical topic summaries.
- **Invoke-time recall:** `MemoGrafterAgent.invoke()` recalls relevant active memories before answering whenever the session has graph content, while still falling back to raw history if recall is unavailable.
- **Token-budgeted graft assembly:** graft prompt assembly respects token budgets by trimming context and includes maintenance notes when active memory facts supersede contradictory summary details.
- **Semantic graft selection is additive:** `graftByRelevance()` uses topic-node vector search to choose graft seeds by natural-language query, then delegates to the existing graft assembly path. Existing `graft()` and `inject()` behavior remains unchanged.
- **Optional asynchronous ingestion:** queue mode can move ingestion work behind a BullMQ/Redis queue without changing the pipeline contract.
- **Bounded conversational queue payloads:** normal agent jobs carry one user-assistant pair and an absolute start index; historical drift overlap is loaded from PostgreSQL instead of copied through Redis.
- **Cursor-safe delivery:** completed retries are no-ops, partial overlaps are trimmed, persisted gaps can be recovered, and missing gaps fail before cursor advancement.
- **Optional recall cache:** recall can cache raw memory search results in Redis for a short bounded TTL without caching final prompt assembly.
- **Grafting is explicit and traceable:** memory transfer copies selected topic nodes and active atomic memories into a target session, records graph edges, and stores provenance in `mg_graft_registry` instead of silently mixing sessions.
