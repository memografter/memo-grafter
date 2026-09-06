CREATE TABLE IF NOT EXISTS mg_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  segment_id TEXT NOT NULL UNIQUE REFERENCES mg_segments(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES mg_topic_nodes(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  intent TEXT NOT NULL,
  outcome TEXT NOT NULL,
  open_question TEXT,
  embedding vector(1536),
  message_range INT[] NOT NULL,
  episode_order INT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'conversation' CHECK (source_type IN ('conversation','note','document','code')),
  source TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  assignment_method TEXT NOT NULL DEFAULT 'created' CHECK (assignment_method IN ('created','embedding','llm','backfill')),
  assignment_similarity FLOAT,
  assignment_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, episode_order)
);

ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS episode_count INT NOT NULL DEFAULT 1;
ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS embedding_count INT NOT NULL DEFAULT 1;
ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS first_active_at TIMESTAMPTZ;
ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS last_episode_id UUID;
ALTER TABLE mg_topic_nodes ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 1;
ALTER TABLE mg_memory_evidence ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES mg_episodes(id) ON DELETE SET NULL;

INSERT INTO mg_episodes (
  session_id, segment_id, topic_id, summary, intent, outcome, embedding,
  message_range, episode_order, source_type, source, tags, assignment_method, created_at
)
SELECT n.session_id, n.segment_id, n.id, COALESCE(n.summary, ''), '', '', n.embedding,
       n.message_range, n.topic_order, 'conversation', n.source, n.tags, 'backfill', n.created_at
FROM mg_topic_nodes n
ON CONFLICT (segment_id) DO NOTHING;

UPDATE mg_topic_nodes n SET
  episode_count = counts.episode_count,
  embedding_count = counts.episode_count,
  first_active_at = counts.first_active_at,
  last_active_at = counts.last_active_at,
  last_episode_id = counts.last_episode_id
FROM (
  SELECT topic_id, COUNT(*)::INT AS episode_count, MIN(created_at) AS first_active_at,
         MAX(created_at) AS last_active_at,
         (ARRAY_AGG(id ORDER BY created_at DESC))[1] AS last_episode_id
  FROM mg_episodes GROUP BY topic_id
) counts WHERE counts.topic_id = n.id;

UPDATE mg_memory_evidence evidence SET episode_id = episode.id
FROM mg_episodes episode
WHERE evidence.segment_id = episode.segment_id AND evidence.episode_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_episodes_session_order ON mg_episodes(session_id, episode_order);
CREATE INDEX IF NOT EXISTS idx_episodes_topic_activity ON mg_episodes(topic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_embedding_hnsw ON mg_episodes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_topic_nodes_activity ON mg_topic_nodes(session_id, last_active_at DESC);
