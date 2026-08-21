// src/poll.js
// Reemplaza al bus interno de IsoTools para nuestras 2 tools: cada
// POLL_INTERVAL_MS, trae eventos nuevos de la plataforma (por cursor),
// corre el mismo handler(event) que vivía dentro del repo, y publica el
// resultado de vuelta por HTTP. La lógica de negocio (inspect_product_quality,
// automate_followups y sus 6 servicios) es idéntica a la nativa — lo único
// que cambia es cómo entra y sale el evento.
import 'dotenv/config';
import pool from './db/index.js';
import { consume, publish } from './platformClient.js';
import * as inspectProductQuality from './tools/inspect_product_quality.js';
import * as automateFollowups from './tools/automate_followups.js';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const ALL_TOOLS = { inspect_product_quality: inspectProductQuality, automate_followups: automateFollowups };
// TOOL_IDS filtra qué tools corre este proceso (ej. "inspect_product_quality").
// Sin definir, corre las dos — así el default local (npm run start) no cambia;
// en Railway cada servicio (un servicio por tool) fija su propio TOOL_IDS.
const TOOLS = (process.env.TOOL_IDS ? process.env.TOOL_IDS.split(',') : Object.keys(ALL_TOOLS))
  .map((id) => ALL_TOOLS[id.trim()]);

// GET /events y /events/subscriptions/:id devuelven la fila "plana" de la
// tabla (module_id, asset_id, event_type...), no el sobre anidado que espera
// un handler nativo (module.id, asset.asset_id, event.type). El bus interno
// arma ese sobre antes de invocar al handler; aquí lo hacemos nosotros.
function toEnvelope (row) {
  return {
    event_id: row.event_id,
    timestamp: row.timestamp,
    platform_version: row.platform_version,
    module: { id: row.module_id, version: row.module_version },
    asset: {
      asset_id: row.asset_id,
      asset_type: row.asset_type,
      plant_id: row.plant_id,
      area_id: row.area_id,
      line_id: row.line_id,
      location: row.location
    },
    event: { type: row.event_type, category: row.category, severity: row.severity },
    data: row.data,
    metadata: row.metadata,
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    seq: row.seq
  };
}

async function getCursor (toolId) {
  const inserted = await pool.query(
    'INSERT INTO poll_cursors (tool_id) VALUES ($1) ON CONFLICT (tool_id) DO NOTHING RETURNING since_seq',
    [toolId]
  );
  if (inserted.rows[0]) return inserted.rows[0].since_seq;
  const { rows } = await pool.query('SELECT since_seq FROM poll_cursors WHERE tool_id = $1', [toolId]);
  return rows[0].since_seq;
}

async function saveCursor (toolId, sinceSeq) {
  await pool.query(
    'UPDATE poll_cursors SET since_seq = $1, updated_at = NOW() WHERE tool_id = $2',
    [sinceSeq, toolId]
  );
}

async function tick (tool) {
  const toolId = tool.meta.id;
  const cursor = await getCursor(toolId);
  const page = await consume(toolId, cursor);
  if (!page || page.events.length === 0) return;

  for (const row of page.events) {
    const event = toEnvelope(row);
    let results;
    try {
      results = await tool.handler(event);
    } catch (err) {
      // ponytail: el cursor avanza por lote (next_seq), no por evento — un evento
      // que falla aquí no se reintenta solo, queda logueado y se sigue con el resto.
      // Si esto se vuelve frecuente, mover a cursor-por-evento o dead-letter.
      console.error(`[${toolId}] error procesando ${event.event_id}:`, err.message);
      continue;
    }
    if (!results) continue;
    for (const result of Array.isArray(results) ? results : [results]) {
      try {
        const res = await publish(result, event, toolId, tool.meta.version);
        console.log(`[${toolId}] ${event.event.type} (seq ${event.seq}) -> ${result.event.type} · ${res.status} seq=${res.seq}`);
      } catch (err) {
        console.error(`[${toolId}] error publicando resultado de ${event.event_id}:`, err.message);
      }
    }
  }

  if (page.next_seq != null) await saveCursor(toolId, page.next_seq);
}

async function loop () {
  for (const tool of TOOLS) {
    await tick(tool).catch((err) => console.error(`[poll] fallo en ${tool.meta.id}:`, err.message));
  }
}

console.log(`[poll] arrancando · intervalo ${POLL_INTERVAL_MS}ms · plataforma ${process.env.CORE_BASE_URL}`);
loop();
setInterval(loop, POLL_INTERVAL_MS);
