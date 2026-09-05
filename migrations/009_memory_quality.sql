-- Quality defaults are unknown, never reconstructed from legacy confidence.
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS quality_explicitness FLOAT NOT NULL DEFAULT 0.5 CHECK (quality_explicitness >= 0 AND quality_explicitness <= 1);
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS quality_source_reliability FLOAT NOT NULL DEFAULT 0.5 CHECK (quality_source_reliability >= 0 AND quality_source_reliability <= 1);
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS quality_stability FLOAT NOT NULL DEFAULT 0.5 CHECK (quality_stability >= 0 AND quality_stability <= 1);
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS quality_salience FLOAT NOT NULL DEFAULT 0.5 CHECK (quality_salience >= 0 AND quality_salience <= 1);
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS quality_defaulted TEXT[] NOT NULL DEFAULT '{explicitness,sourceReliability,stability,salience}';
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS quality_origin TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE mg_memory_nodes ADD COLUMN IF NOT EXISTS quality_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE mg_memory_evidence ADD COLUMN IF NOT EXISTS quality_explicitness FLOAT NOT NULL DEFAULT 0.5 CHECK (quality_explicitness >= 0 AND quality_explicitness <= 1);
ALTER TABLE mg_memory_evidence ADD COLUMN IF NOT EXISTS quality_source_reliability FLOAT NOT NULL DEFAULT 0.5 CHECK (quality_source_reliability >= 0 AND quality_source_reliability <= 1);
ALTER TABLE mg_memory_evidence ADD COLUMN IF NOT EXISTS quality_stability FLOAT NOT NULL DEFAULT 0.5 CHECK (quality_stability >= 0 AND quality_stability <= 1);
ALTER TABLE mg_memory_evidence ADD COLUMN IF NOT EXISTS quality_salience FLOAT NOT NULL DEFAULT 0.5 CHECK (quality_salience >= 0 AND quality_salience <= 1);
ALTER TABLE mg_memory_evidence ADD COLUMN IF NOT EXISTS quality_defaulted TEXT[] NOT NULL DEFAULT '{explicitness,sourceReliability,stability,salience}';
ALTER TABLE mg_memory_evidence ADD COLUMN IF NOT EXISTS quality_origin TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE mg_memory_evidence ADD COLUMN IF NOT EXISTS quality_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
