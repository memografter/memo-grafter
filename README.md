<p align="center">
  <img src="./assets/memografter-logo.png" alt="MemoGrafter logo" width="180" />
</p>

<h1 align="center">MemoGrafter</h1>

<p align="center">
  Lifecycle-managed memory for TypeScript AI agents.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/memo-grafter"><img src="https://img.shields.io/npm/v/memo-grafter.svg" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node.js 18 or newer" />
</p>

<p align="center">
  <a href="https://memografter.com">Website</a>
  ·
  <a href="https://memografter.com/docs">Docs</a>
  ·
  <a href="https://mgplayground-green.vercel.app/">Playground</a>
  ·
  <a href="./USER_GUIDE.md">User Guide</a>
</p>

MemoGrafter gives AI agents structured memory that can evolve, be inspected, and be recalled safely across conversations. It turns chat history and raw text into topic-based graph memory, retrieves relevant facts later, and can graft useful memory from one session or agent into another.

MemoGrafter is memory infrastructure, not an autonomous agent runtime. It does not run tools, schedule work, or decide goals for an agent. It helps your application remember, retrieve, maintain, and transfer context.

## Website And Docs

- Website: [memografter.com](https://memografter.com)
- Docs: [memografter.com/docs](https://memografter.com/docs)
- Playground: [MemoGrafter Playground](https://mgplayground-green.vercel.app/)
- Playground demo repo: [mayhemking007/mg-demo](https://github.com/mayhemking007/mg-demo)

## Why MemoGrafter?

- Build long-running memory for TypeScript chatbots and AI agents.
- Store conversation history as topic nodes, memory nodes, and graph edges.
- Recall relevant facts without stuffing every old message back into the prompt.
- Track lifecycle state such as forgotten, suppressed, conflicted, superseded, and decayed memory.
- Graft selected memory between sessions, workers, or agents.
- Inspect sessions locally with MemoGrafter Studio.
- Use PostgreSQL and `pgvector` for durable graph-backed memory.

## How It Works

```text
conversation or text
  -> topic segments
  -> interaction episodes
  -> stable topic nodes
  -> atomic memory facts
  -> lifecycle metadata
  -> recall or grafting
  -> prompt-ready context
```

MemoGrafter stores conversation turns, tracks which messages have already been ingested, detects topic changes, and records each segment as an episode. Episodes describe what happened; durable memories separately capture facts worth retaining long-term. New episodes reuse a semantically matching topic when possible, so recurring subjects remain connected across later conversation segments.

Memory is built incrementally. New chatbot turns append topic and memory nodes to the existing graph instead of clearing and rebuilding the session on every response. Grafted and externally enriched memory can survive later conversation turns. Use `clearSession()` explicitly when you want to reset an agent's local history and stored session memory.

## Quick Start

```bash
npm install memo-grafter
npx memo-grafter init
npx memo-grafter migrate
npx memo-grafter studio
```

MemoGrafter runs server-side on Node.js 18 or newer. The built-in storage backend uses PostgreSQL with `pgvector`.

The CLI migration and Studio commands use provider-independent entry points. Database setup and browsing do not require an LLM provider SDK. Invoke Preview retrieval and runtime memory extraction require the adapters you configure.

`init` creates MemoGrafter-owned project files under `src/memo-grafter/`:

- `mg-schema.ts`: generated reference for MemoGrafter-owned `mg_*` tables.
- `mg.config.ts`: user-editable CLI and Studio config.

`migrate` creates or updates MemoGrafter-owned database infrastructure. Run it once per database or deployment, not during normal app startup.

`studio` starts a local MemoGrafter Studio host for session browsing, graph inspection, read-only table browsing, and Invoke Preview.

To pass a database URL directly:

```bash
npx memo-grafter studio --db postgres://user:password@localhost:5432/memo_grafter
```

If `--db` is omitted, Studio reads `.env` / `DATABASE_URL`, then `mg.config.ts`. It starts on `http://localhost:2891` or the next available port and keeps running until you stop the process.

### Readiness and ingestion health

MemoGrafter validates provider and storage readiness during initialization. To inspect configuration and durable-ingestion health, run:

```bash
npx memo-grafter doctor --ingestion
```

See the [User Guide](./USER_GUIDE.md) for readiness checks, structured errors, ingestion receipts, and reconciliation.

## Minimal Example

```ts
import "dotenv/config";

import {
  MemoGrafterAgent,
  OpenAIEmbedAdapter,
  OpenAILLMAdapter,
} from "memo-grafter";

const agent = new MemoGrafterAgent({
  db: { connectionString: process.env.DATABASE_URL! },
  llm: new OpenAILLMAdapter("gpt-4o"),
  embedder: new OpenAIEmbedAdapter("text-embedding-3-small"),
});

await agent.initialize();

await agent.invoke("I am planning a Kyoto trip.");
await agent.invoke("I like quiet streets, bookstores, and local cafes.");

await agent.remember("The user prefers concise TypeScript examples.");

const recall = await agent.recall("travel preferences");
console.log(recall.facts);

await agent.close();
```

### Initialize from `mg.config.ts`

`mg.config.ts` can also be the application runtime configuration. Import it explicitly and use
`MemoGrafterAgent.create()` to validate the configuration and return an initialized agent:

```ts
// src/memo-grafter/mg.config.ts
import { defineConfig, OpenAILLMAdapter } from "memo-grafter";

export default defineConfig(() => ({
  db: { connectionString: process.env.DATABASE_URL },
  llm: new OpenAILLMAdapter("gpt-4o"),
  embedder: {
    async embed(text: string): Promise<number[]> {
      // Call the embedding provider used by your application.
      return embed(text);
    },
  },
}));
```

```ts
import "dotenv/config";
import { MemoGrafterAgent } from "memo-grafter";
import config from "./memo-grafter/mg.config.js";

const agent = await MemoGrafterAgent.create(config, {
  inject: { recallLimit: 10 },
});
```

Applications that manage their own sessions can initialize the lower-level API from the same
config:

```ts
import { MemoGrafter } from "memo-grafter";

const memo = await MemoGrafter.create(config, {
  graph: { topK: 10 },
});
```

### Use with an existing AI application

`MemoGrafter` can provide memory to any SDK or framework without owning its LLM call. Retrieve fresh graph context before the call, then analyze the completed exchange afterward:

```ts
const context = await memo.context({
  sessionId,
  query: userMessage,
  limit: 10,
  tokenBudget: 1200,
});

const assistantMessage = await myApplication.invoke({
  systemPrompt: context.systemPrompt,
  userMessage,
});

await memo.analyze({
  sessionId,
  userMessage,
  assistantMessage,
});
```

`context()` returns the prompt, topic nodes, and atomic memory facts selected by the existing retrieval pipeline. It bypasses the recall cache so it always reads current graph state. `analyze()` appends one user-assistant exchange and processes it through the existing drift detection, extraction, and graph persistence pipeline. Existing `MemoGrafterAgent` usage remains fully supported.

The `.js` import specifier is intentional for NodeNext TypeScript projects. The config is compiled
with the rest of the application, so development watchers pick up changes and production changes
use the application's normal build. `create()` calls `initialize()`; constructor-based applications
continue to call `initialize()` themselves. Provider SDKs remain lazy and optional.

## Core Concepts

- **Messages:** raw user, assistant, or system turns.
- **Segments:** ranges of messages that belong to the same topic.
- **Topic nodes:** graph-level summaries of conversation segments.
- **Memory nodes:** atomic facts, insights, questions, tasks, or references attached to topics.
- **Recall:** semantic retrieval of relevant memory facts for a query or chatbot turn.
- **Grafting:** copying selected memory from one session or agent into another.
- **Lifecycle controls:** soft memory state such as forgetting memories or suppressing topics without physically deleting graph rows.

## MemoGrafter Studio

MemoGrafter Studio is a local visibility and debugging tool for your memory graph.

```bash
npx memo-grafter studio
```

Studio lets you:

- browse sessions;
- inspect topic and memory graphs;
- view lifecycle state and graft provenance;
- browse underlying `mg_*` tables in read-only mode;
- preview the exact recall or graft prompt context sent to a model;
- suppress topics during local inspection.

Studio is local development tooling. Do not bind it to a public interface or proxy it as an application API.

## Memory Lifecycle

Applications can control active memory without losing provenance:

- `pinTopic(topicId)` persists an active topic as required context for every invocation in that session.
- `unpinTopic(topicId)` removes the topic from required context; multiple pins are injected in pin order.
- `forget(memoryId)` hides an individual memory from active recall and grafting.
- `forgetMany(memoryIds)` hides multiple memories.
- `suppressTopic(topicId)` hides a topic from active reads, recall, grafting, absorption, and maintenance.
- `restoreTopic(topicId)` makes a suppressed topic active again.
- `getMemoryHistory(...)` and `getMemoryDiff(...)` help inspect how facts changed over time.

Optional crawler passes can annotate memory quality:

- `ConflictDetectionPass` marks contradictory active facts.
- `VersioningPass` marks explicit updates and superseded facts.
- `DecayScoringPass` marks stale active facts as decayed.

## Text And Document Ingestion

Use `ingestText()` for notes, documents, transcripts, editor content, or other non-chat text:

```ts
await agent.ingestText("The product roadmap now prioritizes document imports.", {
  source: "import",
});
```

Use `remember()` for explicit facts:

```ts
await agent.remember("The user prefers short examples with complete imports.");
```

Both paths reuse the same topic detection, extraction, embedding, and graph storage pipeline as conversation ingestion.

## Shared Fleet Memory

Fleets can store common knowledge once and make it available to workers without copying it into each worker session.

```ts
const fleet = new MemoGrafterFleet(config, {
  id: "support-fleet",
  defaultWorkerMemory: "both",
});

await fleet.initialize();
await fleet.ingestToFleet("Refund policy: customers can request a refund within 30 days.");

const support = await fleet.createWorker({ color: "support" });
const recall = await support.recall("refund policy", { memory: "both" });

console.log(recall.facts);
```

## Requirements

- Node.js 18 or newer.
- TypeScript or modern JavaScript using ES modules.
- PostgreSQL with the `pgvector` extension enabled for the built-in store.
- An LLM adapter.
- An embedding adapter.
- OpenAI, Anthropic, or Gemini SDKs and API keys only when the corresponding included adapter performs its first completion or embedding operation. Importing MemoGrafter and constructing adapters do not load provider SDKs.
- Redis only when enabling queue mode or the optional recall cache.

MemoGrafter is server-side only. Do not run it in browser code.

## Production Notes

- Run `npx memo-grafter init` and `npx memo-grafter migrate` outside request handling.
- Prefer `npx memo-grafter migrate` for normal projects.
- Use `PostgresGraphStore.migrate()` only for advanced deploy, CI, or constrained runtime tooling.
- Keep Studio local; it is not a hosted multi-user admin API.
- Configure only the provider SDKs and API keys your app actually uses.

## Learn More

- [Website](https://memografter.com)
- [Docs](https://memografter.com/docs)
- [USER_GUIDE.md](./USER_GUIDE.md) covers setup, configuration, adapters, queue mode, fleet APIs, examples, and troubleshooting.
- [ARCHITECTURE.md](./ARCHITECTURE.md) explains the high-level implementation.
- [examples/basic-chat-memory](./examples/basic-chat-memory) is the simplest runnable single-agent memory demo.
- [examples/chatbot-memory-demo](./examples/chatbot-memory-demo) shows a larger two-agent grafting workflow.

## License

MIT
### Optional topic domains

Set `clustering: { enabled: true }` to organize stable topics into session-scoped domains such as **Travel → Japan Trip, Visa Planning, Flights**. Classification runs after ingestion commits and remains disabled by default. Domains appear in Studio and retrieval metadata without changing retrieval scores, traversal, or prompts. See the [topic domain guide](USER_GUIDE.md#optional-topic-domains) for migration, backfill, limits, and evaluation.
