// Keep in sync with migrations/015_agent_memory.sql.
export const agentMemoryMigrationSql = `ALTER TABLE mg_memory_nodes DROP CONSTRAINT IF EXISTS mg_memory_nodes_source_type_check;
ALTER TABLE mg_memory_nodes ADD CONSTRAINT mg_memory_nodes_source_type_check CHECK (source_type IN ('conversation','note','document','code','agent'));
ALTER TABLE mg_episodes DROP CONSTRAINT IF EXISTS mg_episodes_source_type_check;
ALTER TABLE mg_episodes ADD CONSTRAINT mg_episodes_source_type_check CHECK (source_type IN ('conversation','note','document','code','agent'));
CREATE TABLE IF NOT EXISTS mg_agent_working_state (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision INT NOT NULL CHECK (revision > 0),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES mg_agent_runs(tenant_id, run_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mg_agent_episode_links (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  start_sequence INT NOT NULL CHECK (start_sequence >= 0),
  end_sequence INT NOT NULL CHECK (end_sequence >= start_sequence),
  episode_id UUID NOT NULL REFERENCES mg_episodes(id) ON DELETE CASCADE,
  graph_session_id TEXT NOT NULL,
  rejected_candidates INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, run_id, end_sequence),
  UNIQUE (episode_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES mg_agent_runs(tenant_id, run_id)
);
CREATE TABLE IF NOT EXISTS mg_agent_memory_links (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  episode_id UUID NOT NULL REFERENCES mg_agent_episode_links(episode_id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES mg_memory_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fact','lesson')),
  basis TEXT NOT NULL CHECK (basis IN ('observed-success','observed-failure')),
  conditions TEXT[] NOT NULL,
  event_ids TEXT[] NOT NULL,
  artifact_uris TEXT[] NOT NULL,
  PRIMARY KEY (tenant_id, run_id, episode_id, memory_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES mg_agent_runs(tenant_id, run_id)
);
CREATE INDEX IF NOT EXISTS mg_agent_memory_links_memory_idx ON mg_agent_memory_links(memory_id);
`;
