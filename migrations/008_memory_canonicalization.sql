ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS canonical_subject TEXT;
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS canonical_predicate TEXT;
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS canonical_value TEXT;
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS canonical_fact_key TEXT;
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS canonical_value_key TEXT;
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS canonicalization_version INT NOT NULL DEFAULT 1;
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS reinforcement_count INT NOT NULL DEFAULT 1 CHECK (reinforcement_count > 0);
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS last_reinforced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS mg_memory_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_node_id UUID NOT NULL REFERENCES mg_memory_nodes(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES mg_segments(id) ON DELETE CASCADE,
  topic_node_id TEXT NOT NULL REFERENCES mg_topic_nodes(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  original_subject TEXT NOT NULL,
  original_predicate TEXT NOT NULL,
  original_value TEXT NOT NULL,
  provenance_speaker TEXT,
  provenance_message_indexes INT[],
  provenance_session_id TEXT,
  extraction_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_node_id, segment_id, provenance_message_indexes)
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_canonical_fact ON mg_memory_nodes(session_id, canonical_fact_key) WHERE forgotten=FALSE AND decayed=FALSE AND superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_nodes_canonical_value ON mg_memory_nodes(session_id, canonical_value_key) WHERE canonical_value_key IS NOT NULL AND forgotten=FALSE AND decayed=FALSE AND superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory ON mg_memory_evidence(memory_node_id, created_at);
