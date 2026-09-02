import type { ExtractedMemory, MemoryNodeInsert, MemorySourceType, Message, TopicSegment } from "../../core/types.js";

export interface DurableMemoryRejection {
  memory: ExtractedMemory;
  reason: "invalid-index" | "speaker-mismatch" | "non-user-conversation-memory" | "invalid-method";
}

export function validateDurableMemories(
  memories: ExtractedMemory[],
  messages: Message[],
  segment: Pick<TopicSegment, "sessionId" | "startIndex">,
  sourceType: MemorySourceType,
): { accepted: Array<ExtractedMemory & { absoluteProvenance: NonNullable<MemoryNodeInsert["provenance"]> }>; rejected: DurableMemoryRejection[] } {
  const accepted: Array<ExtractedMemory & { absoluteProvenance: NonNullable<MemoryNodeInsert["provenance"]> }> = [];
  const rejected: DurableMemoryRejection[] = [];
  const isDocument = sourceType !== "conversation";

  for (const memory of memories) {
    const indexes = memory.provenance.messageIndexes;
    if (indexes.some((index) => index < 1 || index > messages.length)) {
      rejected.push({ memory, reason: "invalid-index" });
      continue;
    }
    if (isDocument) {
      accepted.push({
        ...memory,
        absoluteProvenance: {
          speaker: "document",
          messageIndexes: indexes.map((index) => segment.startIndex + index - 1),
          sessionId: segment.sessionId,
          extractionMethod: "document-extraction",
        },
      });
      continue;
    } else {
      if (memory.provenance.speaker !== "user") {
        rejected.push({ memory, reason: "non-user-conversation-memory" });
        continue;
      }
      if (indexes.some((index) => messages[index - 1]?.role !== "user")) {
        rejected.push({ memory, reason: "speaker-mismatch" });
        continue;
      }
      if (memory.provenance.extractionMethod === "document-extraction") {
        rejected.push({ memory, reason: "invalid-method" });
        continue;
      }
    }
    accepted.push({
      ...memory,
      absoluteProvenance: {
        speaker: memory.provenance.speaker,
        messageIndexes: indexes.map((index) => segment.startIndex + index - 1),
        sessionId: segment.sessionId,
        extractionMethod: memory.provenance.extractionMethod,
      },
    });
  }
  return { accepted, rejected };
}
