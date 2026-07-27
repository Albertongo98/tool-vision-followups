// src/services/followupService.js
// Plantillas de seguimiento por tipo de evento fuente (CER-004) + creación de
// tareas con idempotencia por source_event_id (CER-003/CER-005).
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const TEMPLATES = {
  '8D_REPORT_ISSUED': (data) => [
    { title: 'Validar causa raíz', owner: data.ownerEmail || 'quality.engineer@company.com', slaDays: 2, priority: 'high' },
    { title: 'Adjuntar evidencia de contención', owner: 'quality.engineer@company.com', slaDays: 1, priority: 'high', evidenceRequired: true },
    { title: 'Verificar acción correctiva', owner: 'process.owner@company.com', slaDays: 5, priority: 'medium' },
    { title: 'Confirmar eficacia', owner: 'quality.manager@company.com', slaDays: 15, priority: 'medium' }
  ],
  PROJECT_AT_RISK: (data) => [
    { title: 'Revisar desviación', owner: 'project.owner@company.com', slaDays: 1, priority: 'high' },
    { title: 'Definir plan de recuperación', owner: 'project.owner@company.com', slaDays: 2, priority: 'high' },
    {
      title: 'Notificar bloqueo',
      owner: 'sponsor@company.com',
      slaDays: 0,
      priority: 'critical',
      escalationOwner: 'sponsor@company.com'
    }
  ]
};

function resolveOriginType (eventType) {
  if (eventType === '8D_REPORT_ISSUED') return '8d';
  if (eventType === 'PROJECT_AT_RISK') return 'project';
  return 'manual';
}

function resolveOriginId (eventType, data) {
  return data.reportId || data.ncId || data.projectId || data.id || null;
}

export function hasTemplate (eventType) {
  return Boolean(TEMPLATES[eventType]);
}

// Si ya existen followups para este source_event_id, no vuelve a crearlos.
export async function findExistingByEvent (sourceEventId) {
  const { rows } = await pool.query(
    'SELECT * FROM followup_tasks WHERE source_event_id = $1 ORDER BY created_at ASC',
    [sourceEventId]
  );
  return rows;
}

export async function createFollowupsForEvent (event) {
  const eventType = event.event?.type;
  const data = event.data || {};
  const buildTasks = TEMPLATES[eventType];
  if (!buildTasks) return null;

  const existing = await findExistingByEvent(event.event_id);
  if (existing.length > 0) {
    return summarize(existing, eventType);
  }

  const originType = resolveOriginType(eventType);
  const originId = resolveOriginId(eventType, data) || event.event_id;
  const tasks = buildTasks(data);
  const created = [];

  for (const task of tasks) {
    const followupCode = `FUP-${uuidv4().slice(0, 8).toUpperCase()}`;
    const dueDate = new Date(Date.now() + (task.slaDays * DAY_MS)).toISOString();
    const { rows } = await pool.query(
      `INSERT INTO followup_tasks (
         followup_code, source_event_id, origin_type, origin_id,
         title, owner, due_date, status, priority, escalation_owner, evidence_required
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10)
       RETURNING *`,
      [followupCode, event.event_id, originType, originId, task.title, task.owner, dueDate,
        task.priority, task.escalationOwner || null, Boolean(task.evidenceRequired)]
    );
    created.push(rows[0]);
  }

  return summarize(created, eventType, originId);
}

function summarize (tasks, eventType, originId) {
  const owners = [...new Set(tasks.map((t) => t.owner).filter(Boolean))];
  const dueDates = tasks.map((t) => new Date(t.due_date).getTime()).filter((n) => !Number.isNaN(n));
  const nextDueDate = dueDates.length ? new Date(Math.min(...dueDates)).toISOString() : null;
  return {
    origin: originId || tasks[0]?.origin_id,
    source_event_type: eventType,
    followups_created: tasks.length,
    scheduled_ids: tasks.map((t) => t.followup_code),
    next_due_date: nextDueDate,
    owners,
    escalation_required: tasks.some((t) => Boolean(t.escalation_owner)),
    status: 'open'
  };
}

export async function listFollowups ({ status, owner, originId } = {}) {
  const conditions = [];
  const values = [];
  if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
  if (owner) { values.push(owner); conditions.push(`owner = $${values.length}`); }
  if (originId) { values.push(originId); conditions.push(`origin_id = $${values.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM followup_tasks ${where} ORDER BY due_date ASC`, values);
  return rows;
}

export async function updateFollowup (id, patch) {
  const fields = [];
  const values = [];
  const map = { status: 'status', owner: 'owner', evidenceRefs: 'evidence_refs', description: 'description' };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      fields.push(`${column} = $${values.length}`);
    }
  }
  if (fields.length === 0) return null;
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE followup_tasks SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function closeFollowup (id) {
  const { rows } = await pool.query(
    `UPDATE followup_tasks SET status = 'closed', closed_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}
