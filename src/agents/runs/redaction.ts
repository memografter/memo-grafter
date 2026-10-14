import { createHash } from "node:crypto";
import type { AgentCaptureOptions } from "./memoryTypes.js";
import type { AgentEventInput, JsonValue } from "./types.js";
import { AgentRunError } from "./types.js";
import { jsonSnapshot } from "./validation.js";

export function redactText(text: string, options: AgentCaptureOptions): string {
  const sanitized = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(https?:\/\/|postgres(?:ql)?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]@");
  const result = options.redactText ? options.redactText(sanitized) : sanitized;
  if (typeof result !== "string") throw new AgentRunError("INVALID_INPUT", "redactText must return a string.");
  return result;
}

export function redactValue(value: JsonValue, options: AgentCaptureOptions): JsonValue {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map(item => redactValue(item, options));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /password|secret|token|authorization|api[_-]?key|cookie/i.test(key) ? "[REDACTED]" : redactValue(item, options)]));
  return value;
}

export function sanitizeEvent(input: AgentEventInput, options: AgentCaptureOptions): AgentEventInput {
  const event = jsonSnapshot({ eventId: input.eventId, sequence: input.sequence, occurredAt: input.occurredAt,
    data: input.data, ...(input.source === undefined ? {} : { source: input.source }) });
  // Routing IDs and event types are never rewritten by a redactor.
  const data = event.data;
  switch (data?.type) {
    // Persist only contract fields; undeclared payload fields must not bypass redaction.
    case "tool.call": event.data = { type: data.type, toolCallId: data.toolCallId, toolName: redactText(data.toolName, options), input: boundedPayload(data.input, options) }; break;
    case "tool.result": event.data = { type: data.type, toolCallId: data.toolCallId, outcome: data.outcome, output: boundedPayload(data.output, options) }; break;
    case "observation": event.data = { type: data.type, text: redactText(data.text, options) }; break;
    case "artifact": event.data = { type: data.type, uri: redactText(data.uri, options), ...(data.description === undefined ? {} : { description: redactText(data.description, options) }) }; break;
    case "task.milestone": event.data = { type: data.type, label: redactText(data.label, options), summary: redactText(data.summary, options) }; break;
    case "task.started": event.data = { type: data.type, objective: redactText(data.objective, options) }; break;
    case "task.completed": case "task.failed": case "task.cancelled": event.data = { type: data.type, summary: redactText(data.summary, options) }; break;
  }
  if (event.source) event.source = { uri: redactText(event.source.uri, options), ...(event.source.externalId === undefined ? {} : { externalId: event.source.externalId }) };
  return event;
}

function boundedPayload(value: JsonValue, options: AgentCaptureOptions): JsonValue {
  const sanitized = redactValue(value, options);
  const text = JSON.stringify(sanitized);
  const limit = options.maxToolPayloadChars ?? 16000;
  if (!Number.isInteger(limit) || limit < 256 || limit > 64000) throw new AgentRunError("INVALID_INPUT", "maxToolPayloadChars must be an integer from 256 to 64000.");
  return text.length <= limit ? sanitized : {
    truncated: true, preview: text.slice(0, limit), sha256: createHash("sha256").update(text).digest("hex"),
    note: "Payload truncated before persistence; omitted content cannot support memory extraction. Use an artifact reference for the original.",
  };
}
