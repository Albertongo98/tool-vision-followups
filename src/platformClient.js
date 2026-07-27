// src/platformClient.js
// Único punto de contacto con la plataforma IsoTools (Railway). Esta tool NO
// tiene acceso directo al Postgres de la plataforma — todo entra y sale por
// HTTP con la API key. Nunca se hace push/PR al repo IsoTools.
import { randomUUID } from 'crypto';

const BASE = process.env.CORE_BASE_URL;
const KEY = process.env.API_KEY;

if (!BASE || !KEY) {
  throw new Error('Faltan CORE_BASE_URL y/o API_KEY en el .env (ver .env.example)');
}

async function request (path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json', ...options.headers }
  });
  if (res.status === 304) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

// Trae solo los eventos que ESTA tool consume (según tools.json en el catálogo
// de la plataforma), a partir del cursor guardado localmente.
export async function consume (toolId, sinceSeq, limit = 50) {
  return request(`/events/subscriptions/${toolId}?since_seq=${sinceSeq}&limit=${limit}`);
}

// Publica el resultado de un handler nativo (event/asset/data) como evento
// real de la plataforma. Hereda correlation_id/causation_id del evento que lo
// disparó — así la cadena causal queda igual de trazable que si el bus interno
// la hubiera armado.
export async function publish (result, sourceEvent, moduleId, moduleVersion = '1.0.0') {
  const payload = {
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    platform_version: '2.0',
    module: { id: moduleId, version: moduleVersion },
    asset: result.asset,
    event: result.event,
    data: result.data,
    correlation_id: sourceEvent.correlation_id || sourceEvent.event_id,
    causation_id: sourceEvent.event_id
  };
  return request('/events', { method: 'POST', body: JSON.stringify(payload) });
}
