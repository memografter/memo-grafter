import { mgIndex, mgTable } from "./builders.js";

export const agentMemoryTables = [
  mgTable({ name: "mg_agent_working_state", description: "Revisioned mutable state local to one agent run.", columns: [
    { name: "tenant_id", type: "text", primaryKey: true }, { name: "run_id", type: "text", primaryKey: true },
    { name: "revision", type: "int", check: "revision > 0" }, { name: "state", type: "jsonb", check: "jsonb_typeof(state) = 'object'" },
    { name: "updated_at", type: "timestamptz", default: "now()" },
  ], constraints: ["FOREIGN KEY (tenant_id, run_id) REFERENCES mg_agent_runs(tenant_id, run_id) ON DELETE CASCADE"] }),
  mgTable({ name: "mg_agent_episode_links", description: "Agent event boundaries and access ownership for graph episodes.", columns: [
    { name: "tenant_id", type: "text", primaryKey: true }, { name: "run_id", type: "text", primaryKey: true },
    { name: "start_sequence", type: "int", check: "start_sequence >= 0" }, { name: "end_sequence", type: "int", primaryKey: true, check: "end_sequence >= start_sequence" },
    { name: "episode_id", type: "uuid", unique: true, references: "mg_episodes(id) ON DELETE CASCADE" },
    { name: "graph_session_id", type: "text" }, { name: "rejected_candidates", type: "int", default: "0" },
  ], constraints: ["FOREIGN KEY (tenant_id, run_id) REFERENCES mg_agent_runs(tenant_id, run_id)"] }),
  mgTable({ name: "mg_agent_memory_links", description: "Evidence and applicability conditions for agent graph memories.", columns: [
    { name: "tenant_id", type: "text", primaryKey: true }, { name: "run_id", type: "text", primaryKey: true },
    { name: "episode_id", type: "uuid", primaryKey: true, references: "mg_agent_episode_links(episode_id) ON DELETE CASCADE" },
    { name: "memory_id", type: "uuid", primaryKey: true, references: "mg_memory_nodes(id) ON DELETE CASCADE" },
    { name: "kind", type: "text", check: "kind IN ('fact','lesson')" }, { name: "basis", type: "text", check: "basis IN ('observed-success','observed-failure')" },
    { name: "conditions", type: "text[]" }, { name: "event_ids", type: "text[]" }, { name: "artifact_uris", type: "text[]" },
  ], constraints: ["FOREIGN KEY (tenant_id, run_id) REFERENCES mg_agent_runs(tenant_id, run_id)"] }),
];
export const agentMemoryIndexes = [mgIndex({ name: "mg_agent_memory_links_memory_idx", table: "mg_agent_memory_links", description: "Agent memory provenance lookup." })];
