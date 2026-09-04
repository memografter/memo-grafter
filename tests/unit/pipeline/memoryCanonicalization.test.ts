import { describe, expect, it } from "vitest";
import { canonicalizeMemory, classifyCanonicalMemory } from "../../../src/utils/extraction/memoryCanonicalization.js";

function canonical(subject: string, predicate: string, value: string) {
  return canonicalizeMemory({ sessionId: "s1", subject, predicate, value, provenance: { speaker: "user", messageIndexes: [1], sessionId: "s1", extractionMethod: "explicit" } });
}

describe("memory canonicalization", () => {
  it("maps stable wording aliases to the same canonical value", () => {
    expect(canonical("The user", "preference is", "Postgres.").valueKey)
      .toBe(canonical("user", "prefers", "PostgreSQL").valueKey);
  });

  it("classifies repeated, changed, and conflicting values", () => {
    const first = canonical("user", "prefers", "PostgreSQL");
    const active = [{ canonicalValueKey: first.valueKey }];
    expect(classifyCanonicalMemory(first, active)).toBe("reinforcement");
    expect(classifyCanonicalMemory(canonical("user", "prefers", "now SQLite"), active)).toBe("update");
    expect(classifyCanonicalMemory(canonical("user", "prefers", "MySQL"), active)).toBe("conflict");
    expect(classifyCanonicalMemory(first, [])).toBe("new");
  });

  it("keeps speakers and sessions in separate identity scopes", () => {
    const user = canonical("user", "prefers", "PostgreSQL");
    const document = canonicalizeMemory({ sessionId: "s1", subject: "user", predicate: "prefers", value: "PostgreSQL", provenance: { speaker: "document", messageIndexes: [1], sessionId: "s1", extractionMethod: "document-extraction" } });
    expect(user.factKey).not.toBe(document.factKey);
    expect(user.factKey).not.toBe(canonicalizeMemory({ sessionId: "s2", subject: "user", predicate: "prefers", value: "PostgreSQL", provenance: { speaker: "user", messageIndexes: [1], sessionId: "s2", extractionMethod: "explicit" } }).factKey);
  });
});
