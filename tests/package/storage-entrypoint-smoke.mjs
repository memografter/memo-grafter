import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "memo-grafter-package-"));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this smoke test through npm so npm_execpath is available");

const runNpm = (args, options) =>
  execFileSync(process.execPath, [npmCli, ...args], options);

try {
  const packResult = JSON.parse(runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", fixtureRoot],
    { cwd: repositoryRoot, encoding: "utf8" },
  ));
  const packageFilename = packResult[0]?.filename;
  assert(packageFilename, "npm pack did not return a package filename");

  runNpm(["init", "-y"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  runNpm(
    ["install", path.join(fixtureRoot, packageFilename), "--omit=optional", "--ignore-scripts"],
    { cwd: fixtureRoot, encoding: "utf8", stdio: "pipe" },
  );

  const packageJson = JSON.parse(readFileSync(
    path.join(fixtureRoot, "node_modules", "memo-grafter", "package.json"),
    "utf8",
  ));
  for (const providerSdk of ["@anthropic-ai/sdk", "@google/genai", "openai"]) {
    assert.equal(
      packageJson.peerDependenciesMeta?.[providerSdk]?.optional,
      true,
      `${providerSdk} must remain an optional peer dependency`,
    );
    assert.equal(
      existsSync(path.join(fixtureRoot, "node_modules", ...providerSdk.split("/"))),
      false,
      `${providerSdk} should not be installed in the storage-only fixture`,
    );
  }

  const storeModuleUrl = pathToFileURL(
    path.join(fixtureRoot, "node_modules", "memo-grafter", "dist", "store", "index.js"),
  ).href;
  const storeModule = await import(storeModuleUrl);
  assert.equal(typeof storeModule.PostgresGraphStore, "function");
  assert.equal(typeof storeModule.AgentRunError, "function");
  const agentEventStore = new storeModule.PostgresGraphStore("postgres://unused");
  const scopedRuns = agentEventStore.agentRuns({ tenantId: "package-test", agentId: "agent-test" });
  for (const method of ["startRun", "getRun", "recordEvent", "listEvents", "interruptRun", "resumeRun", "completeRun",
    "getWorkingState", "updateWorkingState", "processRun", "listEpisodes", "listMemories", "forgetAgentMemory", "suppressEpisode", "restoreEpisode"]) {
    assert.equal(typeof scopedRuns[method], "function", `agent event API must expose ${method}`);
  }
  await agentEventStore.close();

  const rootModuleUrl = pathToFileURL(
    path.join(fixtureRoot, "node_modules", "memo-grafter", "dist", "index.js"),
  ).href;
  const rootModule = await import(rootModuleUrl);
  assert.equal(typeof rootModule.MemoGrafterAgent, "function");
  for (const method of ["ingestText", "ingestTextDetailed", "ingestDocument", "ingestDocumentDetailed"]) {
    assert.equal(typeof rootModule.MemoGrafter.prototype[method], "function", `packed API must expose ${method}`);
  }

  const adapters = [
    new rootModule.OpenAILLMAdapter(),
    new rootModule.OpenAIEmbedAdapter(),
    new rootModule.AnthropicLLMAdapter(),
    new rootModule.GeminiLLMAdapter(),
    new rootModule.GeminiEmbedAdapter(),
  ];
  assert.equal(adapters.length, 5, "all adapters should construct without provider SDKs");

  await assert.rejects(
    adapters[0].complete([{ role: "user", content: "Hello" }]),
    /requires the optional "openai" package.*npm install openai/,
  );
  await assert.rejects(
    adapters[2].complete([{ role: "user", content: "Hello" }]),
    /requires the optional "@anthropic-ai\/sdk" package.*npm install @anthropic-ai\/sdk/,
  );
  await assert.rejects(
    adapters[3].complete([{ role: "user", content: "Hello" }]),
    /requires the optional "@google\/genai" package.*npm install @google\/genai/,
  );

  const memoGrafterCli = path.join(
    fixtureRoot,
    "node_modules",
    "memo-grafter",
    "dist",
    "cli",
    "index.js",
  );
  execFileSync(process.execPath, [memoGrafterCli, "init"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  const migration = spawnSync(
    process.execPath,
    [
      memoGrafterCli,
      "migrate",
      "--db",
      "postgres://postgres:postgres@127.0.0.1:1/memo_grafter?connect_timeout=1",
    ],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
  const migrationOutput = `${migration.stdout ?? ""}\n${migration.stderr ?? ""}`;
  assert.notEqual(migration.status, 0, "migration against a closed port should fail");
  assert.doesNotMatch(
    migrationOutput,
    /ERR_MODULE_NOT_FOUND|@anthropic-ai\/sdk|@google\/genai|Cannot find package ['"]openai/,
    migrationOutput,
  );

  const doctor = spawnSync(
    process.execPath,
    [
      memoGrafterCli,
      "doctor",
      "--db",
      "postgres://postgres:postgres@127.0.0.1:1/memo_grafter?connect_timeout=1",
    ],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
  const doctorOutput = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`;
  assert.equal(doctor.status, 1, "doctor against a closed port should report a required failure");
  assert.match(doctorOutput, /MemoGrafter Doctor/);
  assert.match(doctorOutput, /PostgreSQL could not be reached/);
  assert.doesNotMatch(
    doctorOutput,
    /ERR_MODULE_NOT_FOUND|@anthropic-ai\/sdk|@google\/genai|Cannot find package ['"]openai/,
    doctorOutput,
  );
  const invalidDoctorUsage = spawnSync(
    process.execPath,
    [memoGrafterCli, "doctor", "--unknown"],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
  assert.equal(invalidDoctorUsage.status, 2, "invalid doctor options should return usage exit code 2");

  const studio = spawnSync(
    process.execPath,
    [
      memoGrafterCli,
      "studio",
      "--db",
      "postgres://postgres:postgres@127.0.0.1:1/memo_grafter?connect_timeout=1",
    ],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
  const studioOutput = `${studio.stdout ?? ""}\n${studio.stderr ?? ""}`;
  assert.notEqual(studio.status, 0, "Studio against a closed port should fail");
  assert.doesNotMatch(
    studioOutput,
    /ERR_MODULE_NOT_FOUND|@anthropic-ai\/sdk|@google\/genai|Cannot find package ['"]openai/,
    studioOutput,
  );

  process.stdout.write("provider-independent CLI package smoke test passed\n");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  // process.stdout.write(`Fixture retained at: ${fixtureRoot}\n`);
}
