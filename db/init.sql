CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Spec 001: Vision AIO Template Inspection (ISO 9001:8.6)
CREATE TABLE IF NOT EXISTS vision_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_code TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    station_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    version INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    image_ref TEXT NOT NULL,
    mask_ref TEXT,
    image_hash TEXT,
    thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vision_templates_active_combo
    ON vision_templates (product_code, operation_id, station_id, line_id, status);

CREATE TABLE IF NOT EXISTS vision_inspection_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id TEXT,
    template_id UUID REFERENCES vision_templates (id),
    part_id TEXT,
    batch_id TEXT,
    frame_id TEXT,
    similarity_score NUMERIC,
    diff_area_ratio NUMERIC,
    result TEXT NOT NULL,
    evidence_ref TEXT,
    raw_result JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vision_inspection_results_frame_id ON vision_inspection_results (frame_id);

-- Spec 002: Configurable Event Followups (ISO 9001:10.2)
CREATE TABLE IF NOT EXISTS event_rules (
    id TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    source_event_type TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT 'tool',
    target_tool_id TEXT,
    filter JSONB DEFAULT '{}'::jsonb,
    delivery JSONB DEFAULT '{}'::jsonb,
    retry_policy JSONB DEFAULT '{"maxAttempts": 3, "backoffMs": 5000}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_rules_source_event_type ON event_rules (source_event_type);

CREATE TABLE IF NOT EXISTS tool_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_id TEXT,
    source_event_id TEXT NOT NULL,
    target_tool_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    UNIQUE (rule_id, source_event_id, target_tool_id)
);

CREATE TABLE IF NOT EXISTS followup_tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    followup_code TEXT NOT NULL UNIQUE,
    source_event_id TEXT NOT NULL,
    origin_type TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    owner TEXT,
    due_date TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    escalation_owner TEXT,
    evidence_required BOOLEAN NOT NULL DEFAULT FALSE,
    evidence_refs JSONB DEFAULT '[]'::jsonb,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_followup_tasks_source_event_id ON followup_tasks (source_event_id);
CREATE INDEX IF NOT EXISTS idx_followup_tasks_status ON followup_tasks (status);
CREATE INDEX IF NOT EXISTS idx_followup_tasks_owner ON followup_tasks (owner);

-- Reglas por defecto: activables/desactivables sin redeploy vía SQL directo.
INSERT INTO event_rules (id, enabled, source_event_type, target_type, target_tool_id, filter)
VALUES ('rule-followup-8d-issued', TRUE, '8D_REPORT_ISSUED', 'tool', 'automate_followups', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO event_rules (id, enabled, source_event_type, target_type, target_tool_id, filter)
VALUES ('rule-followup-project-at-risk', TRUE, 'PROJECT_AT_RISK', 'tool', 'automate_followups', '{"data.status": ["at_risk"]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Cursor de polling: hasta que seq de la plataforma ya procesamos, por tool.
-- Sin esto, cada arranque reprocesaria el historico completo.
CREATE TABLE IF NOT EXISTS poll_cursors (
    tool_id TEXT PRIMARY KEY,
    since_seq BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
