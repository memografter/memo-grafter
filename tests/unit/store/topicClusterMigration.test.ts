import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { topicClusterMigrationSql } from "../../../src/schema/topicClusterMigration.js";

describe("topic cluster migration", () => {
  it("keeps the packaged runtime migration identical to the standalone upgrade", () => {
    expect(topicClusterMigrationSql.replaceAll("\r\n", "\n")).toBe(
      readFileSync(new URL("../../../migrations/011_topic_clusters.sql", import.meta.url), "utf8").replaceAll("\r\n", "\n"));
  });
});
