import { describe, expect, it } from "vitest";
import { buildSegmentExtractionPrompt } from "../../../src/prompts/segmentExtractionPrompt.js";

describe("segment extraction prompt", () => {
  it("prohibits assistant-originated durable user state and requires evidence", () => {
    const prompt = buildSegmentExtractionPrompt([
      { role: "assistant", content: "Would you like yogurt dressing?" },
      { role: "user", content: "No, I dislike yogurt." },
    ]);
    expect(prompt).toContain("Never turn an assistant suggestion");
    expect(prompt).toContain('"message_indexes": [1]');
    expect(prompt).toContain("[assistant] Would you like yogurt dressing?");
    expect(prompt).toContain("[user] No, I dislike yogurt.");
  });

  it("uses document ownership for document ingestion", () => {
    const prompt = buildSegmentExtractionPrompt([{ role: "user", content: "Refunds are available for 30 days." }], undefined, "document");
    expect(prompt).toContain("Analyze this document segment");
    expect(prompt).toContain('"speaker": "document"');
    expect(prompt).toContain('"extraction_method": "document-extraction"');
  });
});
