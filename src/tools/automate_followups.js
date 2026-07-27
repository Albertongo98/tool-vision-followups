// src/tools/automate_followups.js
// Seguimiento automatizado hasta cierre de cada acción. isoEvent: "followup_automation_event".
// Tool TERMINAL del paquete: ninguna otra reacciona a su salida.
// Implementa spec-driven-design/002-configurable-event-followups-redis (CER-001 a CER-005),
// usando el bus síncrono existente como "router" en lugar de Redis Streams real.
import pool from '../db/index.js';
import { matchRules, matchesFilter } from '../services/eventRuleService.js';
import { createFollowupsForEvent } from '../services/followupService.js';

export const meta = {
  id: 'automate_followups',
  name: 'Automatización de Seguimientos',
  version: '1.1.0',
  category: 'system',
  description: 'Crea tareas de seguimiento con responsable y fecha límite cuando se emite un reporte 8D o un proyecto entra en riesgo, con reglas configurables e idempotencia (ISO 9001 §10.2).',
  consumes: ['SALES_PREDICTED', '8D_REPORT_ISSUED', 'PROJECT_AT_RISK'],
  produces: ['FOLLOWUP_SCHEDULED']
};

// Idempotencia (CER idempotency key): una fila única por rule_id+source_event_id+target_tool_id.
// Si ya existe, este evento ya fue procesado (o está en curso) y no se duplica.
async function claimRun (ruleId, sourceEventId, targetToolId) {
  const { rows } = await pool.query(
    `INSERT INTO tool_runs (rule_id, source_event_id, target_tool_id, status)
     VALUES ($1,$2,$3,'running')
     ON CONFLICT (rule_id, source_event_id, target_tool_id) DO NOTHING
     RETURNING id`,
    [ruleId, sourceEventId, targetToolId]
  );
  return rows[0]?.id || null;
}

async function finishRun (runId, status, attempts, error) {
  await pool.query(
    'UPDATE tool_runs SET status = $1, attempts = $2, error = $3, finished_at = NOW() WHERE id = $4',
    [status, attempts, error || null, runId]
  );
}

export async function handler (event) {
  const eventType = event.event?.type;
  const rules = await matchRules(eventType);
  const rule = rules.find((r) => matchesFilter(r.filter, event));
  if (!rule) return null; // sin regla habilitada para este evento: no hay acción (CER: activable sin redeploy)

  const targetToolId = rule.target_tool_id || meta.id;
  const runId = await claimRun(rule.id, event.event_id, targetToolId);
  if (!runId) return null; // ya procesado: idempotencia

  const retryPolicy = rule.retry_policy || { maxAttempts: 3, backoffMs: 5000 };
  const maxAttempts = retryPolicy.maxAttempts || 3;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await createFollowupsForEvent(event);
      await finishRun(runId, 'success', attempt, null);
      if (!result) return null; // tipo de evento sin plantilla de followup
      return {
        event: { type: 'FOLLOWUP_SCHEDULED', category: 'system', severity: 'low' },
        asset: event.asset,
        data: result
      };
    } catch (err) {
      lastError = err;
    }
  }

  // Reintentos agotados: marca dead-letter (equivalente local a
  // industrial:events:deadletter de la spec, sin infraestructura Redis).
  await finishRun(runId, 'deadletter', maxAttempts, lastError?.message);
  console.error(`[automate_followups] dead-letter tras ${maxAttempts} intentos:`, lastError?.message);
  return null;
}
