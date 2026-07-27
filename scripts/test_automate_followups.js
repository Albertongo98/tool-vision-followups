// scripts/test_automate_followups.js
// ─────────────────────────────────────────────────────────────────────────────
// Self-check de spec-driven-design/002-configurable-event-followups-redis.
// Llama directo al handler de automate_followups (sin HTTP) para verificar:
// creación de followups por plantilla, idempotencia por source_event_id, y
// que un evento sin regla habilitada no genere nada.
//
// Requiere Postgres propio de esta tool arriba y migrado (docker compose up -d,
// incluye las reglas sembradas rule-followup-8d-issued y
// rule-followup-project-at-risk desde db/init.sql).
//
// Uso: node scripts/test_automate_followups.js
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import assert from 'assert';
import { randomUUID } from 'crypto';
import { handler } from '../src/tools/automate_followups.js';
import pool from '../src/db/index.js';

function buildEvent (type, data) {
  return {
    event_id: randomUUID(),
    event: { type, category: 'quality', severity: 'medium' },
    asset: { asset_id: 'PLANT-01' },
    data
  };
}

async function main () {
  // 1) 8D_REPORT_ISSUED → 4 tareas con responsables y vencimiento (CER-004)
  const eightD = buildEvent('8D_REPORT_ISSUED', { reportId: `8D-${randomUUID()}`, ncId: 'NC-TEST-01' });
  const scheduled = await handler(eightD);
  assert.strictEqual(scheduled.event.type, 'FOLLOWUP_SCHEDULED');
  assert.strictEqual(scheduled.data.followups_created, 4);
  assert.strictEqual(scheduled.data.scheduled_ids.length, 4);
  assert.ok(scheduled.data.next_due_date);
  console.log('✓ 8D_REPORT_ISSUED → FOLLOWUP_SCHEDULED con', scheduled.data.followups_created, 'tareas:', scheduled.data.scheduled_ids.join(', '));

  // 2) Mismo evento (mismo event_id) no debe duplicar tareas (idempotencia CER)
  const duplicate = await handler(eightD);
  assert.strictEqual(duplicate, null, 'el mismo evento no debe procesarse dos veces');
  console.log('✓ idempotencia: reprocesar el mismo event_id no crea duplicados');

  // 3) PROJECT_AT_RISK con status=at_risk → 3 tareas, incluye escalamiento (CER-004/CER-007)
  const atRisk = buildEvent('PROJECT_AT_RISK', { projectId: `PRJ-${randomUUID()}`, status: 'at_risk' });
  const projectScheduled = await handler(atRisk);
  assert.strictEqual(projectScheduled.data.followups_created, 3);
  assert.strictEqual(projectScheduled.data.escalation_required, true);
  console.log('✓ PROJECT_AT_RISK (at_risk) → 3 tareas, escalation_required = true');

  // 4) PROJECT_AT_RISK que NO cumple el filtro de la regla (status != at_risk) → sin acción
  const onTrack = buildEvent('PROJECT_AT_RISK', { projectId: `PRJ-${randomUUID()}`, status: 'on_track' });
  const noAction = await handler(onTrack);
  assert.strictEqual(noAction, null, 'status fuera del filtro no debe disparar followups');
  console.log('✓ filtro de regla: status=on_track no genera followups');

  // 5) Evento sin regla configurada para ese tipo → sin acción (activable/desactivable sin redeploy)
  const noRule = buildEvent('SALES_PREDICTED', { closeProbability: 0.9 });
  const noRuleResult = await handler(noRule);
  assert.strictEqual(noRuleResult, null, 'sin event_rule habilitada no debe haber acción');
  console.log('✓ sin regla habilitada para SALES_PREDICTED: no se ejecuta nada');

  console.log('\nTodos los checks de automate_followups pasaron.');
  await pool.end();
}

main().catch((err) => {
  console.error('✗ self-check falló:', err);
  process.exit(1);
});
