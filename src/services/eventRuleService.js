// src/services/eventRuleService.js
// Reglas configurables (CER-001): qué eventos disparan qué tool, con qué
// filtro, sin necesitar redeploy. CRUD vive en Postgres; automate_followups
// las consulta en cada evento que recibe.
import pool from '../db/index.js';

function lookup (obj, dottedPath) {
  return dottedPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// filter: { "event.category": "quality", "data.status": ["open","issued"] }
// Cada entrada compara por igualdad o pertenencia a lista contra el evento.
export function matchesFilter (filter, event) {
  if (!filter || Object.keys(filter).length === 0) return true;
  return Object.entries(filter).every(([path, expected]) => {
    const actual = lookup(event, path);
    if (Array.isArray(expected)) return expected.includes(actual);
    return actual === expected;
  });
}

export async function listRules ({ sourceEventType } = {}) {
  const conditions = [];
  const values = [];
  if (sourceEventType) {
    values.push(sourceEventType);
    conditions.push(`source_event_type = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM event_rules ${where} ORDER BY id`, values);
  return rows;
}

export async function getRule (id) {
  const { rows } = await pool.query('SELECT * FROM event_rules WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createRule ({ id, enabled = true, sourceEventType, targetType = 'tool', targetToolId, filter, delivery, retry }) {
  const { rows } = await pool.query(
    `INSERT INTO event_rules (id, enabled, source_event_type, target_type, target_tool_id, filter, delivery, retry_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [id, enabled, sourceEventType, targetType, targetToolId || null, filter || {}, delivery || {}, retry || { maxAttempts: 3, backoffMs: 5000 }]
  );
  return rows[0];
}

export async function updateRule (id, patch) {
  const fields = [];
  const values = [];
  const map = {
    enabled: 'enabled',
    sourceEventType: 'source_event_type',
    targetType: 'target_type',
    targetToolId: 'target_tool_id',
    filter: 'filter',
    delivery: 'delivery',
    retry: 'retry_policy'
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      fields.push(`${column} = $${values.length}`);
    }
  }
  if (fields.length === 0) return getRule(id);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE event_rules SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rows[0] || null;
}

// Reglas habilitadas que reaccionan a un tipo de evento.
export async function matchRules (sourceEventType) {
  const { rows } = await pool.query(
    'SELECT * FROM event_rules WHERE source_event_type = $1 AND enabled = TRUE',
    [sourceEventType]
  );
  return rows;
}

export function testRule (rule, sampleEvent) {
  const typeMatches = sampleEvent.event?.type === rule.source_event_type;
  const filterMatches = matchesFilter(rule.filter, sampleEvent);
  return { matched: rule.enabled && typeMatches && filterMatches, typeMatches, filterMatches };
}
