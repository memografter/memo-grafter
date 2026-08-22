#!/usr/bin/env node
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runStudio } from "./commands/studio.js";
import { runDoctor } from "./commands/doctor.js";
import { runReconcile } from "./commands/reconcile.js";
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
    const db = readDoctorArguments(args);
    const report = await runDoctor({ ...(db ? { db } : {}) });
    logger.info(report.output);
    process.exitCode = report.exitCode;
  } else if (command === "reconcile") {
    const report = await runReconcile(readReconcileArguments(args));
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

function readDoctorArguments(args: string[]): string | undefined {
  let db: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--db=")) {
      db = arg.slice("--db=".length);
      if (!db) throw new CliUsageError("--db requires a connection string.");
    } else if (arg === "--db") {
      db = args[index + 1];
      if (!db || db.startsWith("--")) throw new CliUsageError("--db requires a connection string.");
      index += 1;
    } else {
      throw new CliUsageError(`Unknown doctor option: ${arg}`);
    }
  }
  return db;
}

function readReconcileArguments(args: string[]): { db?: string; sessionId?: string; repair?: boolean; actions?: string[]; json?: boolean } {
  const result: { db?: string; sessionId?: string; repair?: boolean; actions?: string[]; json?: boolean } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--repair") result.repair = true;
    else if (arg === "--json") result.json = true;
    else if (["--db", "--session", "--action"].includes(arg)) {
      const value = args[++index]; if (!value || value.startsWith("--")) throw new CliUsageError(`${arg} requires a value.`);
      if (arg === "--db") result.db = value; else if (arg === "--session") result.sessionId = value; else result.actions = [...(result.actions ?? []), value];
    } else throw new CliUsageError(`Unknown reconcile option: ${arg}`);
  }
  if (result.actions?.length && !result.repair) throw new CliUsageError("--action requires --repair.");
  return result;
}

function printHelp(): void {
  logger.info(`MemoGrafter CLI

Usage:
  memo-grafter init
  memo-grafter migrate [--db <connection-string>]
  memo-grafter doctor [--db <connection-string>]
  memo-grafter studio [--db <connection-string>]
  memo-grafter reconcile [--session <id>] [--json]
  memo-grafter reconcile --repair --action <action>

Recommended setup:
  memo-grafter init
  memo-grafter migrate
  memo-grafter doctor
  memo-grafter studio
`);
}
