import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import {
  findConfigFiles,
  loadConfig,
  loadEnvFile,
  resolveConnectionString,
} from "../utils/config.js";
import {
  checkPgvectorAvailability,
  checkPgvectorEnabled,
  checkPostgresConnection,
  createDatabaseClient,
  getMigrationStatus,
  type DatabaseClient,
  type MigrationStatus,
} from "../utils/database.js";
import { classifyPostgresError } from "../utils/database-errors.js";
import { renderDoctor } from "../doctor/render.js";
import type { DoctorResult } from "../doctor/types.js";

interface SchemaMetadata {
  memoGrafterCurrentMigrationVersion: number;
  memoGrafterMigrationTableName: string;
  memoGrafterTableNames: readonly string[];
}

export interface DoctorOptions {
  cwd?: string;
  db?: string;
}

export interface DoctorDependencies {
  createDatabaseClient(connectionString: string): DatabaseClient;
  checkPostgresConnection(sql: DatabaseClient): Promise<{ version: string }>;
  checkPgvectorAvailability(sql: DatabaseClient): Promise<boolean>;
  checkPgvectorEnabled(sql: DatabaseClient): Promise<boolean>;
  getMigrationStatus(
    sql: DatabaseClient,
    options: {
      migrationTableName: string;
      expectedVersion: number;
      requiredTables: readonly string[];
    },
  ): Promise<MigrationStatus>;
  loadSchemaMetadata(): Promise<SchemaMetadata>;
  checkRedis(connectionString: string): Promise<void>;
  getMemoGrafterVersion(): string;
}

const defaultDependencies: DoctorDependencies = {
  createDatabaseClient,
  checkPostgresConnection,
  checkPgvectorAvailability,
  checkPgvectorEnabled,
  getMigrationStatus,
  async loadSchemaMetadata() {
    const packageName = "memo-grafter/schema";
    return await import(packageName) as SchemaMetadata;
  },
  async checkRedis(connectionString: string) {
    const redis = new Redis(connectionString, {
      connectTimeout: 3_000,
      commandTimeout: 3_000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    try {
      await redis.connect();
      await redis.ping();
    } finally {
      redis.disconnect();
    }
  },
  getMemoGrafterVersion,
};

export async function runDoctor(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = defaultDependencies,
): Promise<{ exitCode: 0 | 1; results: DoctorResult[]; output: string }> {
  return runDoctorWithRedisPolicy(options, dependencies, "application");
}

/** Runs Doctor with repository infrastructure checks instead of consumer config guidance. */
export async function runRepositoryDoctor(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = defaultDependencies,
): Promise<{ exitCode: 0 | 1; results: DoctorResult[]; output: string }> {
  return runDoctorWithRedisPolicy(options, dependencies, "repository");
}

async function runDoctorWithRedisPolicy(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
  redisPolicy: "application" | "repository",
): Promise<{ exitCode: 0 | 1; results: DoctorResult[]; output: string }> {
  const cwd = options.cwd ?? process.cwd();
  const results: DoctorResult[] = [
    passed("runtime.node", "Runtime", `Node.js ${process.versions.node}`),
    passed("runtime.memo-grafter", "Runtime", `MemoGrafter ${dependencies.getMemoGrafterVersion()}`),
  ];

  loadEnvFile(cwd);
  const configFiles = findConfigFiles(cwd);
  const envFileFound = path.join(cwd, ".env");
  const config = await loadConfig(cwd);
  const foundSources = [
    ...(configFiles.length > 0 ? configFiles.map((file) => path.relative(cwd, file)) : []),
    ...(configFiles.length === 0 && readEnvFileExists(cwd) ? [path.basename(envFileFound)] : []),
  ];
  results.push(foundSources.length > 0
    ? passed("configuration.files", "Configuration", "MemoGrafter configuration found", foundSources.join(", "))
    : failed(
      "configuration.files",
      "Configuration",
      "MemoGrafter configuration not found",
      ["Run: npx memo-grafter init"],
    ));

  for (const [kind, adapter] of [["llm", config?.llm], ["embedder", config?.embedder]] as const) {
    if (!adapter?.validate) continue;
    try {
      const readiness = await adapter.validate();
      for (const check of readiness.checks) {
        results.push({ id: check.id, section: "Providers", label: check.message, status: check.status, ...(check.help ? { help: [check.help] } : {}), required: check.status === "failed" });
      }
    } catch {
      results.push(failed(`adapter.${kind}.validation`, "Providers", `${kind === "llm" ? "LLM" : "Embedding"} adapter validation failed`));
    }
  }

  let connectionString: string | undefined;
  try {
    connectionString = await resolveConnectionString({
      cwd,
      ...(options.db ? { db: options.db } : {}),
    });
    results.push(passed("configuration.database-url", "Configuration", "DATABASE_URL configured"));
  } catch {
    results.push(failed(
      "configuration.database-url",
      "Configuration",
      "DATABASE_URL is not configured",
      ["Set DATABASE_URL, configure db.connectionString, or pass --db."],
    ));
  }

  if (connectionString) {
    const sql = dependencies.createDatabaseClient(connectionString);
    let connected = false;
    try {
      const connection = await dependencies.checkPostgresConnection(sql);
      connected = true;
      results.push(passed("postgres.connection", "PostgreSQL", "PostgreSQL reachable"));
      results.push(passed("postgres.version", "PostgreSQL", `PostgreSQL ${connection.version}`));
    } catch (error) {
      const classification = classifyPostgresError(error);
      results.push(failed(
        "postgres.connection",
        "PostgreSQL",
        "PostgreSQL could not be reached",
        [`Database error: ${classification.category}`, "Check DATABASE_URL and confirm PostgreSQL is running."],
      ));
      appendSkippedDatabaseResults(results);
    }

    if (connected) {
      try {
        const available = await dependencies.checkPgvectorAvailability(sql);
        results.push(available
          ? passed("postgres.pgvector-available", "PostgreSQL", "pgvector available")
          : failed("postgres.pgvector-available", "PostgreSQL", "pgvector is not available"));

        const enabled = await dependencies.checkPgvectorEnabled(sql);
        results.push(enabled
          ? passed("postgres.pgvector-enabled", "PostgreSQL", "pgvector enabled")
          : failed(
            "postgres.pgvector-enabled",
            "PostgreSQL",
            "pgvector is not enabled",
            ["Run: CREATE EXTENSION IF NOT EXISTS vector;"],
          ));

        const metadata = await dependencies.loadSchemaMetadata();
        const migration = await dependencies.getMigrationStatus(sql, {
          migrationTableName: metadata.memoGrafterMigrationTableName,
          expectedVersion: metadata.memoGrafterCurrentMigrationVersion,
          requiredTables: metadata.memoGrafterTableNames,
        });
        appendMigrationResults(results, migration);
      } catch (error) {
        const classification = classifyPostgresError(error);
        results.push(failed(
          "database.diagnostics",
          "Database",
          "Database diagnostics could not be completed",
          [`Database error: ${classification.category}`],
        ));
        appendSkippedDatabaseResults(results);
      }
    }
    await sql.end().catch(() => undefined);
  } else {
    results.push(skipped("postgres.connection", "PostgreSQL", "PostgreSQL check skipped"));
    appendSkippedDatabaseResults(results);
  }

  type RedisUse = "cache" | "queue" | "repository";
  const redisEndpoints = new Map<string, Set<RedisUse>>();
  if (config?.cache?.connectionString) {
    redisEndpoints.set(config.cache.connectionString, new Set(["cache"]));
  }
  if (config?.queue?.redisUrl) {
    const uses = redisEndpoints.get(config.queue.redisUrl) ?? new Set<RedisUse>();
    uses.add("queue");
    redisEndpoints.set(config.queue.redisUrl, uses);
  }
  if (redisPolicy === "repository" && redisEndpoints.size === 0 && process.env.REDIS_URL) {
    redisEndpoints.set(process.env.REDIS_URL, new Set(["repository"]));
  }

  if (redisEndpoints.size === 0) {
    results.push({
      id: "redis.connection",
      section: "Redis",
      label: "Redis not configured — optional",
      status: "skipped",
      help: redisPolicy === "repository"
        ? ["Set REDIS_URL in .env to check the repository Redis service."]
        : [
          "To enable Redis, set REDIS_URL and uncomment cache or queue in",
          "src/memo-grafter/mg.config.ts.",
        ],
      required: false,
    });
  } else {
    const distinctEndpoints = redisEndpoints.size;
    for (const [redisUrl, uses] of redisEndpoints) {
      const queueEnabled = uses.has("queue");
      const cacheEnabled = uses.has("cache");
      const repositoryEnabled = uses.has("repository");
      const id = distinctEndpoints === 1
        ? "redis.connection"
        : queueEnabled ? "redis.queue" : "redis.cache";
      try {
        await dependencies.checkRedis(redisUrl);
        results.push({
          id,
          section: "Redis",
          label: redisSuccessLabel(cacheEnabled, queueEnabled, repositoryEnabled),
          status: "passed",
          required: queueEnabled,
        });
      } catch {
        results.push({
          id,
          section: "Redis",
          label: "Redis could not be reached",
          status: queueEnabled ? "failed" : "warning",
          help: repositoryEnabled
            ? ["Check REDIS_URL and confirm the repository Redis service is running."]
            : queueEnabled
            ? [
              "Check REDIS_URL and confirm the Redis service is running.",
              "Redis is required while queue mode is enabled.",
              "Disable queue in src/memo-grafter/mg.config.ts to use synchronous ingestion.",
            ]
            : [
              "Check REDIS_URL and confirm the Redis service is running.",
              "MemoGrafter will continue without recall caching.",
            ],
          required: queueEnabled,
        });
      }
    }
  }

  const exitCode = results.some((result) => result.required && result.status === "failed") ? 1 : 0;
  return { exitCode, results, output: renderDoctor(results) };
}

function redisSuccessLabel(
  cacheEnabled: boolean,
  queueEnabled: boolean,
  repositoryEnabled: boolean,
): string {
  if (repositoryEnabled) return "Redis reachable — repository service configured";
  if (cacheEnabled && queueEnabled) return "Redis reachable — cache and queue configured";
  if (queueEnabled) return "Redis reachable — queue mode enabled";
  return "Redis reachable";
}

function appendMigrationResults(results: DoctorResult[], status: MigrationStatus): void {
  results.push(status.migrationTableExists
    ? passed("database.migration-table", "Database", "MemoGrafter migration table found")
    : failed(
      "database.migration-table",
      "Database",
      "MemoGrafter migration table is missing",
      ["Run: npx memo-grafter migrate"],
    ));
  results.push(status.currentVersion === status.expectedVersion
    ? passed("database.migration-version", "Database", "Migrations are up to date")
    : failed(
      "database.migration-version",
      "Database",
      "Migrations are not up to date",
      ["Run: npx memo-grafter migrate"],
    ));
  results.push(status.missingTables.length === 0
    ? passed("database.core-tables", "Database", "MemoGrafter schema found")
    : failed(
      "database.core-tables",
      "Database",
      "MemoGrafter schema is incomplete",
      [`Missing tables: ${status.missingTables.join(", ")}`, "Run: npx memo-grafter migrate"],
    ));
}

function appendSkippedDatabaseResults(results: DoctorResult[]): void {
  if (!results.some((result) => result.id === "postgres.version")) {
    results.push(skipped("postgres.version", "PostgreSQL", "PostgreSQL version check skipped"));
  }
  for (const [id, section, label] of [
    ["postgres.pgvector-available", "PostgreSQL", "pgvector availability check skipped"],
    ["postgres.pgvector-enabled", "PostgreSQL", "pgvector enabled check skipped"],
    ["database.migration-table", "Database", "Migration table check skipped"],
    ["database.migration-version", "Database", "Migration version check skipped"],
    ["database.core-tables", "Database", "Core table check skipped"],
  ]) {
    if (!results.some((result) => result.id === id)) results.push(skipped(id, section, label));
  }
}

function passed(id: string, section: string, label: string, message?: string): DoctorResult {
  return { id, section, label, status: "passed", ...(message ? { message } : {}), required: true };
}

function failed(id: string, section: string, label: string, help?: string[]): DoctorResult {
  return { id, section, label, status: "failed", ...(help ? { help } : {}), required: true };
}

function skipped(id: string, section: string, label: string): DoctorResult {
  return { id, section, label, status: "skipped", required: true };
}

function getMemoGrafterVersion(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDirectory = path.dirname(currentFile);
  const packagePath = [
    path.resolve(currentDirectory, "..", "..", "package.json"),
    path.resolve(currentDirectory, "..", "..", "..", "package.json"),
  ].find((candidate) => existsSync(candidate));
  if (!packagePath) return "unknown";
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  return packageJson.version ?? "unknown";
}

function readEnvFileExists(cwd: string): boolean {
  try {
    readFileSync(path.join(cwd, ".env"));
    return true;
  } catch {
    return false;
  }
}
