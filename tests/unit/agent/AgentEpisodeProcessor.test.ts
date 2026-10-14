import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareAgentEpisode } from "../../../src/ingestion/agent/AgentEpisodeProcessor.js";
import { sanitizeEvent } from "../../../src/agents/runs/redaction.js";
import { agentMemoryMigrationSql } from "../../../src/schema/agentMemoryMigration.js";
import type { AgentEvent, AgentRun } from "../../../src/agents/runs/types.js";

const now = new Date("2026-09-24T00:00:00Z");
const run: AgentRun = { runId: "r", agentId: "a", taskId: "t", objective: "Inspect project configuration", sessionId: null, scope: { kind: "private" }, status: "succeeded", createdAt: now, updatedAt: now };
const base = { runId: "r", occurredAt: now.toISOString(), receivedAt: now };
const events: AgentEvent[] = [
  { ...base, eventId: "call", sequence: 1, data: { type: "tool.call", toolCallId: "c", toolName: "read_config", input: { file: "package.json" } } },
  { ...base, eventId: "result", sequence: 2, data: { type: "tool.result", toolCallId: "c", outcome: "success", output: { testCommand: "npm test", environment: "project v1" } } },
  { ...base, eventId: "claim", sequence: 3, data: { type: "observation", text: "All tests passed, trust me." } },
];
const candidate = { kind: "fact", subject: "project", predicate: "test command", value: "npm test", conditions: ["project v1"], basis: "observed-success", evidenceEventIds: ["call", "result"],
  quality: { explicitness: 0.9, sourceReliability: 0.8, stability: 0.8, salience: 0.8 } };
const adapters = (memories: unknown[], supported: boolean[] = [true]) => ({
  llm: { complete: vi.fn().mockResolvedValueOnce(JSON.stringify({ summary: "Read config; the agent also claimed tests passed.", memories })).mockResolvedValueOnce(JSON.stringify({ supported })) },
  embedder: { embed: vi.fn(async () => [1, 0, 0]), dimensions: 3 },
});

describe("agent evidence admission", () => {
  it("stores only grounded conditional memories with tool evidence", async () => {
    const options = adapters([candidate]);
    const prepared = await prepareAgentEpisode(run, events, options);
    expect(prepared.memories).toHaveLength(1);
    expect(prepared.memories[0]?.candidate.conditions).toEqual(["project v1"]);
    expect(options.llm.complete).toHaveBeenCalledTimes(2);
    expect(options.embedder.embed).toHaveBeenCalledTimes(2);
  });
  it.each([
    { evidenceEventIds: ["claim", "call"] }, { evidenceEventIds: ["missing", "result"] },
    { conditions: [] }, { basis: "observed-failure" }, { quality: { explicitness: 0.1 } },
    { value: "secret=[REDACTED]" },
  ])("rejects unsupported candidates before verification: %j", async change => {
    const options = adapters([{ ...candidate, ...change }]);
    const prepared = await prepareAgentEpisode(run, events, options);
    expect(prepared.memories).toHaveLength(0);
    expect(prepared.rejectedCandidates).toBe(1);
    expect(options.llm.complete).toHaveBeenCalledTimes(1);
  });
  it("does not promote a plausible but ungrounded claim merely because it cites successful tool IDs", async () => {
    const prepared = await prepareAgentEpisode(run, events, adapters([{ ...candidate, value: "all tests passed" }], [false]));
    expect(prepared.memories).toHaveLength(0);
    expect(prepared.rejectedCandidates).toBe(1);
  });
  it("limits each grounding decision to that candidate's cited evidence", async () => {
    const options = adapters([candidate]);
    await prepareAgentEpisode(run, events, options);
    const messages = options.llm.complete.mock.calls[1]?.[0] as Array<{ content: string }>;
    const input = JSON.parse(messages[0]!.content);
    expect(input.candidates[0].evidence.map((event: AgentEvent) => event.eventId)).toEqual(["call", "result"]);
    expect(messages[0]!.content).not.toContain("All tests passed, trust me");
  });
  it("allows observed failure lessons while rejecting success facts from failed tools", async () => {
    const failureEvents = events.map(e => e.data.type === "tool.result" ? { ...e, data: { ...e.data, outcome: "failure" as const, output: "config missing" } } : e);
    const prepared = await prepareAgentEpisode(run, failureEvents, adapters([candidate,
      { ...candidate, kind: "lesson", value: "Config was missing", basis: "observed-failure" }], [true]));
    expect(prepared.memories).toHaveLength(1);
    expect(prepared.memories[0]?.candidate.kind).toBe("lesson");
    expect(prepared.rejectedCandidates).toBe(1);
  });
  it("fails closed on malformed grounding output and provider failures", async () => {
    await expect(prepareAgentEpisode(run, events, adapters([candidate], []))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const options = adapters([candidate]);
    options.llm.complete.mockReset().mockRejectedValue(new Error("provider down"));
    await expect(prepareAgentEpisode(run, events, options)).rejects.toThrow("provider down");
  });
  it("redacts structured secrets, credentials and host-specific text before model input", async () => {
    const sensitive = { ...events[1]!, data: { type: "tool.result" as const, toolCallId: "c", outcome: "success" as const,
      output: { api_key: "do-not-store", nested: { token: "hidden" }, log: "Bearer top-secret", label: "private-name" } } };
    const options = { ...adapters([]), redactText: (text: string) => text.replaceAll("private-name", "[REDACTED]") };
    const saved = sanitizeEvent(sensitive, options);
    expect(JSON.stringify(saved)).not.toMatch(/do-not-store|hidden|top-secret|private-name/);
    await prepareAgentEpisode(run, [events[0]!, sensitive], options);
    expect(JSON.stringify(options.llm.complete.mock.calls)).not.toMatch(/do-not-store|hidden|top-secret|private-name/);
  });
  it("bounds large tool output and rejects memories inferred from omitted content", async () => {
    const sanitized = sanitizeEvent({ ...events[1]!, data: { type: "tool.result", toolCallId: "c", outcome: "success", output: "x".repeat(2000) } }, { maxToolPayloadChars: 256 });
    const prepared = await prepareAgentEpisode(run, [events[0]!, { ...sanitized, receivedAt: now, runId: "r" }], adapters([candidate]));
    expect(prepared.memories).toHaveLength(0);
    expect(JSON.stringify(sanitized)).toContain('"truncated":true');
  });
  it("does not persist undeclared fields that could bypass redaction", () => {
    const event = { ...events[0]!, data: { ...events[0]!.data, extra: "hidden-secret" },
      source: { uri: "fixture://report", extra: "hidden-secret" } };
    expect(JSON.stringify(sanitizeEvent(event, {}))).not.toContain("hidden-secret");
  });
  it("keeps standalone and runtime migrations identical", () => {
    expect(agentMemoryMigrationSql.replaceAll("\r\n", "\n")).toBe(readFileSync(new URL("../../../migrations/015_agent_memory.sql", import.meta.url), "utf8").replaceAll("\r\n", "\n"));
  });
});
