import { describe, expect, it } from "vitest";
import type { ExtractedMemory, Message } from "../../../src/core/types.js";
import { validateDurableMemories } from "../../../src/utils/extraction/durableMemoryValidation.js";

function memory(speaker: ExtractedMemory["provenance"]["speaker"], indexes: number[], method: ExtractedMemory["provenance"]["extractionMethod"] = "explicit"): ExtractedMemory {
  return {
    memoryType: "fact", subject: "user", predicate: "prefers", value: "vegetarian food", confidence: 0.95,
    provenance: { speaker, messageIndexes: indexes, extractionMethod: method },
  };
}

describe("durable memory validation", () => {
  const messages: Message[] = [
    { role: "assistant", content: "Would you prefer vegetarian food?" },
    { role: "user", content: "Yes, I prefer vegetarian food." },
  ];
  const segment = { sessionId: "session-1", startIndex: 10 };

  it("accepts a supported user-confirmed memory and converts indexes to absolute session indexes", () => {
    const result = validateDurableMemories([memory("user", [2], "user-confirmed")], messages, segment, "conversation");
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.absoluteProvenance).toEqual({
      speaker: "user", messageIndexes: [11], sessionId: "session-1", extractionMethod: "user-confirmed",
    });
  });

  it("rejects assistant-owned suggestions and user claims supported by assistant messages", () => {
    expect(validateDurableMemories([memory("assistant", [1])], messages, segment, "conversation").rejected[0]?.reason)
      .toBe("non-user-conversation-memory");
    expect(validateDurableMemories([memory("user", [1])], messages, segment, "conversation").rejected[0]?.reason)
      .toBe("speaker-mismatch");
  });

  it("rejects invalid indexes", () => {
    expect(validateDurableMemories([memory("user", [3])], messages, segment, "conversation").rejected[0]?.reason)
      .toBe("invalid-index");
  });

  it("normalizes non-conversation provenance to the known document source", () => {
    const accepted = validateDurableMemories([memory("document", [1], "document-extraction")], [messages[1]!], segment, "document");
    expect(accepted.accepted).toHaveLength(1);
    expect(validateDurableMemories([memory("user", [1])], [messages[1]!], segment, "document").accepted[0]?.absoluteProvenance)
      .toEqual({ speaker: "document", messageIndexes: [10], sessionId: "session-1", extractionMethod: "document-extraction" });
  });
});
