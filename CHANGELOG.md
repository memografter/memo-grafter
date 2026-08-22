# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Added

- Added typed public errors, warnings, safe serialization, and non-network provider readiness checks.
- Added provider completion, extraction, and embedding response validation at public analysis and context boundaries.
- Preserved specific provider error codes while attaching safe ingestion state metadata.

### Fixed

- Prevented failed `analyze()` extraction attempts from allowing later exchanges to overwrite their buffered messages, including across queued job retries.
- Prevented shared ingestion paths from leaving orphan segments when topic extraction or summary embedding fails.
- Made PostgreSQL segment/topic persistence atomic and preserved topic-node IDs during retry upserts.

## [0.1.1] - 2026-05-14

### Added

- Anthropic adapter support

### Changed

- Refactored prompts into dedicated prompts folder structure

## [0.2.0] - 2026-05-20

### Added

- Gemini adapter support
- Atomic fact extraction and storage as a second memory graph layer
- RetrieverPipeline for semantic fact retrieval and recall workflows

### Changed

- Redesigned drift detection with multi-signal scoring and adaptive thresholds
- Introduced pluggable `GraphStore` interface for future database/vector store extensibility

### Internal

- Refactored reusable domain utilities out of pipeline classes
- Removed mid-session graph injection from invoke pipeline
- Added Vitest unit testing setup

## [0.2.1] - 2026-05-22

### Added

- Optional Redis cache layer for `recall()` results
- Exposed pipeline classes and `PostgresGraphStore` as public API components

### Changed

- Integrated `recall()` into `buildHistory()` for context window overflow handling

## [0.2.2] - 2026-05-22

### Added

- Added `getGraphSnapshot()` method for retrieving a snapshot of the current session graph, including memory state and graph structure

## [0.2.3] - 2026-05-28

### Fixed

- Ensured grafted memories reach the LLM in the default `invoke()` path
- Preserved grafted memory across ingest rebuilds

### Changed

- Made `IngestPipeline` incremental using ingest cursors to avoid full-history rebuilds and improve memory durability

## [0.2.4] - 2026-05-30

### Added

- Added `MemoGrafterCrawler` maintenance passes for deterministic conflict detection, memory versioning, and decay scoring.
- Added memory lifecycle annotations including `hasConflict`, `supersededBy`, and `decayed`, plus `conflicts` and `updates` memory edges.

### Changed

- Updated graph snapshots and graft prompts so conflicted, superseded, and decayed memory state is visible and active facts are preferred over stale summaries.

## [0.2.5] - 2026-06-01

### Added

- Added session tagging and filtered memory retrieval for scoped memory organization and targeted recall.
- Added confidence-weighted ranking to semantic retrieval for improved memory selection quality.
- Added adaptive drift sensitivity tuning for dynamic topic boundary detection.

### Fixed

- Prevented false-positive conflict detection caused by broad topic memories.

## [0.2.6] - 2026-06-03

### Added

- Added `ingestText()` API for ingesting non-conversational text directly into the memory graph.

### Fixed

- Separated conflict detection from versioning classification to improve memory lifecycle accuracy and prevent incorrect conflict annotations.

## [0.2.7] - 2026-06-04

### Added

- Added `graftByRelevance()` for semantic selective grafting without requiring explicit topic node IDs.
- Added configurable graft selection controls including relevance-based seed node discovery, similarity filtering, and graph expansion options.
- Added streaming support to `OpenAIAdapter` with optional token callbacks for real-time response generation.

## [0.2.8] - 2026-06-09

### Added

- Added `getMemoryHistory()` API to inspect memory evolution, supersession chains, and historical fact updates.
- Added manual memory pruning APIs for explicit memory removal and suppression.
- Added graph-level support for reviewing active, superseded, and historical memory states.

## [0.3.0] - 2026-06-16

### Added

- Added `agent.remember()` API for direct memory injection without requiring conversational ingestion.
- Added CLI foundation with `npx memo-grafter init` and `npx memo-grafter migrate` commands for project setup and schema management.
- Added shared fleet-level memory accessible across worker agents within a fleet.

### Changed

- Reorganized the source tree into dedicated `core`, `ingestion`, `retrieval`, `maintenance`, and `agents` modules.
- Refactored graph snapshot infrastructure to support upcoming browser-based session exploration and graph inspection tooling.

### Internal

- Improved project structure and module boundaries to support future CLI, fleet, and visualization capabilities.

## [0.4.0] - 2026-06-28

### Added

- Added MemoGrafter Studio with graph, tables, and Prompt Preview tabs.
- Added `memo-grafter studio` CLI command and internal Studio API.
- Added read-only table inspection and prompt preview runtime wiring.

### Changed

- Redesigned Studio graph visualization, filtering, node details, and lifecycle actions.
- Enforced explicit `init` / `migrate` setup before Studio startup.

### Internal

- Refactored Studio infrastructure for future developer tooling.

## [0.4.1] - 2026-06-28

### Added

- Added session labels and search to MemoGrafter Studio for improved workspace organization.
- Added graph search with result navigation for locating memories and topics within large session graphs.

### Changed

- Enhanced Studio graph visualization with advanced navigation, interaction, and graph exploration capabilities.
- Applied a unified visual design system across MemoGrafter Studio for a more consistent and polished user experience.

## [0.4.2] - 2026-07-26

### Added

- Added provider-independent `memo-grafter/studio` entry point for Studio services.
- Added graceful fallback for Prompt Preview when no embedding provider is configured, while keeping all other Studio features available.

### Changed

- Updated the Studio CLI to use the new `memo-grafter/studio` and `memo-grafter/store` entry points instead of importing the package root.
- Isolated Studio from provider adapters so Studio can run without installing optional OpenAI, Anthropic, or Gemini SDKs.

### Internal

- Added packaged-install regression tests for `memo-grafter migrate` and `memo-grafter studio`.
- Added focused tests for the new Studio entry point and unavailable Prompt Preview behavior.

## [0.4.3] - 2026-07-29

### Added

- Added `doctor` CLI command to validate MemoGrafter environment setup, dependencies, and project configuration.
- Added commented Redis configuration to the generated `mg-config.ts` template for easier optional cache setup.
- Added Docker Compose setup and `CONTRIBUTING.md` to simplify local development and project onboarding.

### Changed

- Improved `init` CLI terminal output with clearer setup guidance and next steps.
- Improved `migrate` CLI messaging with more actionable errors and recovery instructions.
- Updated CLI helper messages and setup guidance throughout the initialization workflow.
- Updated documentation across `USER_GUIDE.md`, `ARCHITECTURE.md`, and `CONTRIBUTION.md`, including refreshed documentation links.

## [0.4.4] - 2026-08-03

### Changed

- Introduced lazy loading for provider SDKs so optional provider dependencies are loaded only when their corresponding adapters are used.
- Optimized queued ingestion by reducing database calls per ingestion job, improving throughput and reducing database load.

### Internal

- Added manual smoke tests for memory accuracy and performance validation.
- Added optional result export support for live smoke testing.

## [0.4.5] - 2026-08-09

### Added

- Added `MemoGrafter.create()` for asynchronous MemoGrafter initialization.
- Added `MemoGrafterAgent.create()` for initializing agents through the updated configuration flow.

### Changed

- Updated `MemoGrafterAgent` configuration and initialization flow for more consistent setup and dependency handling.

### Internal

- Added root-level scripts for running `migrate` and `doctor` commands during repository development.

## [0.5.0] - 2026-08-17

### Added

* Added `analyze` and `context` APIs for integrating MemoGrafter's memory capabilities into existing chatbot and agent systems.
* Added persistent topic pinning to keep selected session topics available as prioritized invocation context.
* Added grafting workflows to MemoGrafter Studio for selecting and transferring relevant memory through the Studio UI.
* Added Invoke Preview to Studio for inspecting the context and request structure prepared for LLM invocation.

### Changed

* Expanded MemoGrafter Studio from memory inspection toward interactive memory management and invocation debugging.
* Improved MemoGrafter's integration model so existing chatbot applications can use its memory and context capabilities without depending solely on the built-in agent flow.
