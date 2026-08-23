import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runDoctor,
  runRepositoryDoctor,
  type DoctorDependencies,
} from "../../../cli/commands/doctor.js";
import type { DatabaseClient } from "../../../cli/utils/database.js";

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousRedisUrl = process.env.REDIS_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe("memo-grafter doctor", () => {
  it("folds read-only ingestion inspection into doctor JSON output", async () => {
    const cwd = await createProject();
    const { dependencies } = healthyDependencies();
    dependencies.inspectIngestion = vi.fn(async () => [{ code: "retryable-failure", severity: "error", sessionId: "session-1", message: "Processing failed.", repairable: true }]);
    const report = await runDoctor({ cwd, db: "postgres://example", ingestion: true, sessionId: "session-1", json: true }, dependencies);
    expect(report.exitCode).toBe(1);
    expect(JSON.parse(report.output)).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ id: "ingestion.health", status: "failed" })]) });
  });
  it("reports a healthy PostgreSQL setup and optional Redis", async () => {
    const cwd = await createProject();
    const { dependencies, end } = healthyDependencies();

    const report = await runDoctor({ cwd, db: "postgres://example" }, dependencies);

    expect(report.exitCode).toBe(0);
    expect(report.output).toContain("MemoGrafter Doctor");
    expect(report.output).toContain("✓ PostgreSQL 16.4");
    expect(report.output).toContain("✓ Migrations are up to date");
    expect(report.output).toContain("○ Redis not configured — optional");
    expect(report.output).toContain("set REDIS_URL and uncomment cache or queue");
    expect(report.output).toContain("src/memo-grafter/mg.config.ts");
    expect(report.output).toContain("✓ MemoGrafter is ready");
    expect(end).toHaveBeenCalledOnce();
  });

  it("does not treat standalone REDIS_URL as application Redis configuration", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const cwd = await createProject();
    const { dependencies } = healthyDependencies();

    const report = await runDoctor({ cwd, db: "postgres://example" }, dependencies);

    expect(dependencies.checkRedis).not.toHaveBeenCalled();
    expect(report.output).toContain("Redis not configured");
    expect(report.output).toContain("src/memo-grafter/mg.config.ts");
  });

  it("checks standalone REDIS_URL for the cloned repository", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const cwd = await createProject();
    const { dependencies } = healthyDependencies();

    const report = await runRepositoryDoctor(
      { cwd, db: "postgres://example" },
      dependencies,
    );

    expect(report.exitCode).toBe(0);
    expect(dependencies.checkRedis).toHaveBeenCalledWith("redis://localhost:6379");
    expect(report.output).toContain("Redis reachable — repository service configured");
  });

  it("uses repository guidance when REDIS_URL is missing", async () => {
    delete process.env.REDIS_URL;
    const cwd = await createProject();
    const { dependencies } = healthyDependencies();

    const report = await runRepositoryDoctor(
      { cwd, db: "postgres://example" },
      dependencies,
    );

    expect(report.output).toContain("Set REDIS_URL in .env to check the repository Redis service");
    expect(report.output).not.toContain("src/memo-grafter/mg.config.ts");
  });

  it("warns without failing when repository Redis is unreachable", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const cwd = await createProject();
    const { dependencies } = healthyDependencies();
    dependencies.checkRedis = vi.fn(async () => {
      throw new Error("unreachable");
    });

    const report = await runRepositoryDoctor(
      { cwd, db: "postgres://example" },
      dependencies,
    );

    expect(report.exitCode).toBe(0);
    expect(report.output).toContain("! Redis could not be reached");
    expect(report.output).toContain("repository Redis service is running");
    expect(report.output).not.toContain("src/memo-grafter/mg.config.ts");
  });

  it("fails once and skips dependent checks when PostgreSQL is unreachable", async () => {
    const cwd = await createProject();
    const { dependencies, end } = healthyDependencies();
    dependencies.checkPostgresConnection = vi.fn(async () => {
      throw { code: "ECONNREFUSED", message: "connect refused" };
    });

    const report = await runDoctor({ cwd, db: "postgres://example" }, dependencies);

    expect(report.exitCode).toBe(1);
    expect(report.output).toContain("✗ PostgreSQL could not be reached");
    expect(report.output).toContain("○ pgvector availability check skipped");
    expect(dependencies.checkPgvectorAvailability).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it("reports missing migration metadata as a required failure", async () => {
    const cwd = await createProject();
    const { dependencies } = healthyDependencies();
    dependencies.getMigrationStatus = vi.fn(async () => ({
      migrationTableExists: false,
      expectedVersion: 1,
      missingTables: ["mg_sessions"],
    }));

    const report = await runDoctor({ cwd, db: "postgres://example" }, dependencies);

    expect(report.exitCode).toBe(1);
    expect(report.output).toContain("✗ MemoGrafter migration table is missing");
    expect(report.output).toContain("Missing tables: mg_sessions");
  });

  it("warns without failing when configured cache Redis is unreachable", async () => {
    const cwd = await createProject({
      config: `export default {
  db: { connectionString: "postgres://example" },
  cache: { connectionString: "redis://127.0.0.1:1" },
};\n`,
    });
    const { dependencies } = healthyDependencies();
    dependencies.checkRedis = vi.fn(async () => {
      throw new Error("unreachable");
    });

    const report = await runDoctor({ cwd }, dependencies);

    expect(report.exitCode).toBe(0);
    expect(report.output).toContain("! Redis could not be reached");
    expect(report.output).toContain("MemoGrafter will continue without recall caching");
    expect(report.output).toContain("✓ MemoGrafter is ready");
  });

  it("fails when queue Redis is configured but unreachable", async () => {
    const cwd = await createProject({
      config: `export default {
  db: { connectionString: "postgres://example" },
  queue: { redisUrl: "redis://127.0.0.1:1" },
};\n`,
    });
    const { dependencies } = healthyDependencies();
    dependencies.checkRedis = vi.fn(async () => {
      throw new Error("unreachable");
    });

    const report = await runDoctor({ cwd }, dependencies);

    expect(report.exitCode).toBe(1);
    expect(report.output).toContain("✗ Redis could not be reached");
    expect(report.output).toContain("Redis is required while queue mode is enabled");
    expect(report.output).toContain("Disable queue in src/memo-grafter/mg.config.ts");
  });

  it("checks a shared cache and queue Redis endpoint only once", async () => {
    const cwd = await createProject({
      config: `export default {
  db: { connectionString: "postgres://example" },
  cache: { connectionString: "redis://localhost:6379" },
  queue: { redisUrl: "redis://localhost:6379" },
};\n`,
    });
    const { dependencies } = healthyDependencies();

    const report = await runDoctor({ cwd }, dependencies);

    expect(report.exitCode).toBe(0);
    expect(dependencies.checkRedis).toHaveBeenCalledOnce();
    expect(report.output).toContain("Redis reachable — cache and queue configured");
  });

  it("fails cleanly when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    const cwd = await createProject();
    const { dependencies } = healthyDependencies();

    const report = await runDoctor({ cwd }, dependencies);

    expect(report.exitCode).toBe(1);
    expect(report.output).toContain("✗ DATABASE_URL is not configured");
    expect(dependencies.createDatabaseClient).not.toHaveBeenCalled();
  });
});

async function createProject(options: { config?: string } = {}): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "memo-grafter-doctor-"));
  const directory = path.join(cwd, "src", "memo-grafter");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "mg.config.js"),
    options.config ?? "export default {};\n",
    "utf8",
  );
  return cwd;
}

function healthyDependencies(): {
  dependencies: DoctorDependencies;
  end: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn(async () => undefined);
  const sql = { end } as unknown as DatabaseClient;
  const dependencies: DoctorDependencies = {
    createDatabaseClient: vi.fn(() => sql),
    checkPostgresConnection: vi.fn(async () => ({ version: "16.4" })),
    checkPgvectorAvailability: vi.fn(async () => true),
    checkPgvectorEnabled: vi.fn(async () => true),
    getMigrationStatus: vi.fn(async () => ({
      migrationTableExists: true,
      currentVersion: 1,
      expectedVersion: 1,
      missingTables: [],
    })),
    loadSchemaMetadata: vi.fn(async () => ({
      memoGrafterCurrentMigrationVersion: 1,
      memoGrafterMigrationTableName: "mg_migrations",
      memoGrafterTableNames: ["mg_sessions"],
    })),
    checkRedis: vi.fn(async () => undefined),
    getMemoGrafterVersion: vi.fn(() => "0.4.2"),
  };
  return { dependencies, end };
}
