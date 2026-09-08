CREATE TABLE IF NOT EXISTS mg_topic_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  label TEXT NOT NULL,
  normalized_label TEXT NOT NULL CHECK (length(normalized_label) > 0),
  description TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  embedding vector NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, normalized_label),
  UNIQUE (session_id, id)
);

ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS cluster_id UUID;
ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS cluster_assignment JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mg_topic_cluster_scope_fk' AND conrelid = 'mg_topic_nodes'::regclass) THEN
    ALTER TABLE mg_topic_nodes ADD CONSTRAINT mg_topic_cluster_scope_fk
      FOREIGN KEY (session_id, cluster_id) REFERENCES mg_topic_clusters(session_id, id)
      ON DELETE SET NULL (cluster_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_topic_nodes_cluster ON mg_topic_nodes(session_id, cluster_id);
