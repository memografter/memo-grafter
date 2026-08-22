CREATE TABLE IF NOT EXISTS mg_ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id TEXT NOT NULL, kind TEXT NOT NULL,
  start_index INT NOT NULL CHECK (start_index >= 0), end_index INT NOT NULL CHECK (end_index >= start_index),
  idempotency_key TEXT, status TEXT NOT NULL CHECK (status IN ('accepted','queued','running','retry_pending','completed','completed_with_warnings','failed','cancelled','abandoned')),
  attempt_count INT NOT NULL DEFAULT 0, queued_at TIMESTAMPTZ, started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ, failed_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ, last_error_code TEXT, last_error_stage TEXT,
  last_error_safe_message TEXT, retryable BOOLEAN, worker_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, start_index, end_index, kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS mg_ingestion_runs_idempotency_idx ON mg_ingestion_runs(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS mg_ingestion_runs_session_status_idx ON mg_ingestion_runs(session_id, status);
CREATE INDEX IF NOT EXISTS mg_ingestion_runs_pending_idx ON mg_ingestion_runs(status, retryable, updated_at);
CREATE INDEX IF NOT EXISTS mg_ingestion_runs_lease_idx ON mg_ingestion_runs(lease_expires_at) WHERE status = 'running';
