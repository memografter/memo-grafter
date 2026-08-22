import postgres from "postgres";
import { assert, cleanupDatabase, createInitializedMemo, databaseUrl, skipWithoutDatabase } from "../setup.js";

if (!(await skipWithoutDatabase("core/database-init"))) {
  const memo = await createInitializedMemo();
  await memo.initialize();

  const sql = postgres(databaseUrl!);
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'mg_%'
    ORDER BY table_name
  `;

  assert.deepEqual(rows.map((row) => row.table_name), [
    "mg_fleet_agents",
    "mg_fleets",
    "mg_graft_registry",
    "mg_memory_edges",
    "mg_memory_nodes",
    "mg_message_buffer",
    "mg_segments",
    "mg_sessions",
    "mg_session_ingest_state",
    "mg_ingestion_runs",
    "mg_topic_edges",
    "mg_topic_nodes",
  ]);

  await sql.end();
  await memo.close();
  await cleanupDatabase();
}
