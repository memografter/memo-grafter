import { AgentRunError, type AgentEventInput } from "./types.js";

export function nonblank(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 16384) {
    throw new AgentRunError("INVALID_INPUT", `${name} must be a nonblank string (at most 16384 characters).`);
  }
}

export function identifier(value: unknown, name: string): asserts value is string {
  nonblank(value, name);
  if (Buffer.byteLength(value, "utf8") > 256 || value.includes("\0")) {
    throw new AgentRunError("INVALID_INPUT", `${name} must be at most 256 UTF-8 bytes and contain no null characters.`);
  }
}

/** Reject lossy JSON serialization, cycles, and oversized payloads before persistence. */
export function jsonSnapshot<T>(value: T): T {
  let encoded: string;
  try {
    const ancestors = new Set<object>();
    const check = (item: unknown, depth: number): void => {
      if (depth > 64) throw new Error("Too deeply nested");
      if (item === null || typeof item === "boolean") return;
      if (typeof item === "string" && !item.includes("\0")) return;
      if (typeof item === "number" && Number.isFinite(item)) return;
      if (typeof item !== "object" || ancestors.has(item)) throw new Error("Not JSON");
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Not plain JSON");
      ancestors.add(item);
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) check(item[i], depth + 1);
      } else {
        if (Object.getOwnPropertySymbols(item).length) throw new Error("Not JSON");
        for (const [key, child] of Object.entries(item)) {
          if (key.includes("\0")) throw new Error("Invalid JSON key");
          check(child, depth + 1);
        }
      }
      ancestors.delete(item);
    };
    check(value, 0);
    encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > 262144) throw new Error("Too large");
  } catch {
    throw new AgentRunError("INVALID_INPUT", "Payload must be JSON and no larger than 256 KiB; use artifact references for larger data.");
  }
  return JSON.parse(encoded) as T;
}

export function validateEvent(input: AgentEventInput): AgentEventInput {
  const event = jsonSnapshot(input);
  identifier(event?.eventId, "eventId");
  if (!Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence > 2147483647) {
    throw new AgentRunError("INVALID_INPUT", "sequence must be an integer between 1 and 2147483647.");
  }
  nonblank(event.occurredAt, "occurredAt");
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.occurredAt) || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new AgentRunError("INVALID_INPUT", "occurredAt must be an ISO timestamp with a timezone.");
  }
  event.occurredAt = new Date(event.occurredAt).toISOString();
  if (event.source !== undefined) {
    nonblank(event.source?.uri, "source.uri");
    if (event.source.externalId !== undefined) identifier(event.source.externalId, "source.externalId");
  }
  const data = event.data;
  switch (data?.type) {
    case "tool.call":
      identifier(data.toolCallId, "toolCallId"); nonblank(data.toolName, "toolName");
      if (!("input" in data)) throw new AgentRunError("INVALID_INPUT", "tool.call requires input.");
      break;
    case "tool.result":
      identifier(data.toolCallId, "toolCallId");
      if (!["success", "failure"].includes(data.outcome) || !("output" in data)) throw new AgentRunError("INVALID_INPUT", "tool.result requires outcome and output.");
      break;
    case "observation": nonblank(data.text, "text"); break;
    case "task.milestone": nonblank(data.label, "label"); nonblank(data.summary, "summary"); break;
    case "artifact":
      nonblank(data.uri, "uri");
      if (data.description !== undefined) nonblank(data.description, "description");
      break;
    case "task.completed": case "task.failed": case "task.cancelled": nonblank(data.summary, "summary"); break;
    default: throw new AgentRunError("INVALID_INPUT", "Unsupported event type; task.started is recorded by startRun.");
  }
  return event;
}
