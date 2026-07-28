// scripts/view.js
// Visor local de solo lectura: templates, inspecciones (con evidencia) y
// followups. No importa ni toca los handlers de las tools — solo lee la
// base propia y sirve archivos de storage/. Node puro, sin dependencias nuevas.
//
// Uso: node scripts/view.js  →  http://localhost:3300
import 'dotenv/config';
import http from 'http';
import path from 'path';
import pool from '../src/db/index.js';
import { resolvePath, exists } from '../src/services/storageRefService.js';

const PORT = process.env.VIEW_PORT || 3300;
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage'));

function escapeHtml (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderPage () {
  const [templates, inspections, followups] = await Promise.all([
    pool.query('SELECT * FROM vision_templates ORDER BY created_at DESC LIMIT 50'),
    pool.query('SELECT * FROM vision_inspection_results ORDER BY created_at DESC LIMIT 50'),
    pool.query('SELECT * FROM followup_tasks ORDER BY created_at DESC LIMIT 50')
  ]);

  const img = (ref) => (ref && exists(ref)) ? `<img src="/image?ref=${encodeURIComponent(ref)}" height="80">` : '(sin imagen)';

  return `<!doctype html><html><head><meta charset="utf-8"><title>tool-vision-followups</title>
  <style>body{font-family:sans-serif;margin:2rem}table{border-collapse:collapse;width:100%;margin-bottom:2rem}
  td,th{border:1px solid #ccc;padding:4px 8px;font-size:13px;text-align:left}th{background:#eee}</style></head><body>
  <h2>Templates</h2>
  <table><tr><th>id</th><th>producto</th><th>estado</th><th>imagen</th></tr>
  ${templates.rows.map((t) => `<tr><td>${escapeHtml(t.id)}</td><td>${escapeHtml(t.product_code)}</td><td>${escapeHtml(t.status)}</td><td>${img(t.image_ref)}</td></tr>`).join('')}
  </table>
  <h2>Inspecciones recientes</h2>
  <table><tr><th>frame</th><th>resultado</th><th>similitud</th><th>evidencia</th></tr>
  ${inspections.rows.map((r) => `<tr><td>${escapeHtml(r.frame_id)}</td><td>${escapeHtml(r.result)}</td><td>${r.similarity_score}</td><td>${img(r.evidence_ref)}</td></tr>`).join('')}
  </table>
  <h2>Followups</h2>
  <table><tr><th>código</th><th>título</th><th>owner</th><th>vence</th><th>estado</th></tr>
  ${followups.rows.map((f) => `<tr><td>${escapeHtml(f.followup_code)}</td><td>${escapeHtml(f.title)}</td><td>${escapeHtml(f.owner)}</td><td>${escapeHtml(f.due_date)}</td><td>${escapeHtml(f.status)}</td></tr>`).join('')}
  </table>
  </body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/image') {
      const ref = url.searchParams.get('ref');
      const filePath = resolvePath(ref);
      // ponytail: guarda simple contra path traversal en el query param, ref siempre debe resolver dentro de storage/
      if (!filePath.startsWith(STORAGE_ROOT)) { res.writeHead(400); return res.end('ref inválido'); }
      const fs = await import('fs');
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return fs.createReadStream(filePath).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await renderPage());
  } catch (err) {
    res.writeHead(500);
    res.end(`Error: ${err.message}`);
  }
});

server.listen(PORT, () => console.log(`[view] http://localhost:${PORT}`));
