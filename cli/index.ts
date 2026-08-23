#!/usr/bin/env node
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runStudio } from "./commands/studio.js";
import { runDoctor } from "./commands/doctor.js";
import { isHandledDatabaseSetupError } from "./utils/database-errors.js";
import { logger } from "./utils/logger.js";

const [, , command, ...args] = process.argv;

class CliUsageError extends Error {}

try {
  if (command === "init") {
    await runInit();
  } else if (command === "migrate") {
    await runMigrate({ db: readFlag(args, "--db") });
  } else if (command === "studio") {
    await runStudio({ db: readFlag(args, "--db") });
  } else if (command === "doctor") {
    const options = readDoctorArguments(args);
    const report = await runDoctor(options);
    logger.info(report.output);
    process.exitCode = report.exitCode;
  } else {
    printHelp();
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  if (error instanceof CliUsageError) {
    logger.error(error.message);
    process.exitCode = 2;
  } else {
    if (!isHandledDatabaseSetupError(error)) {
      logger.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

function readFlag(args: string[], flag: string): string | undefined {
  const equalsValue = args.find((arg) => arg.startsWith(`${flag}=`));
  if (equalsValue) return equalsValue.slice(flag.length + 1);

  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];

  return undefined;
}

function readDoctorArguments(args: string[]): { db?: string; ingestion?: boolean; sessionId?: string; json?: boolean } {
  const result: { db?: string; ingestion?: boolean; sessionId?: string; json?: boolean } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--db=")) {
      result.db = arg.slice("--db=".length);
      if (!result.db) throw new CliUsageError("--db requires a connection string.");
    } else if (arg === "--db") {
      result.db = args[index + 1];
      if (!result.db || result.db.startsWith("--")) throw new CliUsageError("--db requires a connection string.");
      index += 1;
    } else if (arg === "--ingestion") {
      result.ingestion = true;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--session") {
      result.sessionId = args[index + 1];
      if (!result.sessionId || result.sessionId.startsWith("--")) throw new CliUsageError("--session requires an id.");
      index += 1;
    } else {
      throw new CliUsageError(`Unknown doctor option: ${arg}`);
    }
  }
  if (result.sessionId && !result.ingestion) throw new CliUsageError("--session requires --ingestion.");
  return result;
}

function printHelp(): void {
  logger.info(`MemoGrafter CLI

Usage:
  memo-grafter init
  memo-grafter migrate [--db <connection-string>]
  memo-grafter doctor [--db <connection-string>] [--ingestion] [--session <id>] [--json]
  memo-grafter studio [--db <connection-string>]

Recommended setup:
  memo-grafter init
  memo-grafter migrate
  memo-grafter doctor
  memo-grafter studio
`);
}
