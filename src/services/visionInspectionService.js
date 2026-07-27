// src/services/visionInspectionService.js
// Persistencia de resultados de inspección visual (trazabilidad ISO 8.6).
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/index.js';

export async function saveInspectionResult ({
  eventId, templateId, partId, batchId, frameId,
  similarityScore, diffAreaRatio, result, evidenceRef, rawResult
}) {
  const { rows } = await pool.query(
    `INSERT INTO vision_inspection_results (
       id, event_id, template_id, part_id, batch_id, frame_id,
       similarity_score, diff_area_ratio, result, evidence_ref, raw_result
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [uuidv4(), eventId || null, templateId || null, partId || null, batchId || null, frameId || null,
      similarityScore, diffAreaRatio, result, evidenceRef || null, rawResult || {}]
  );
  return rows[0].id;
}

export async function listRecentInspections (limit = 50) {
  const { rows } = await pool.query(
    `SELECT vir.*, vt.product_code, vt.station_id, vt.line_id, vt.operation_id, vt.version AS template_version
     FROM vision_inspection_results vir
     LEFT JOIN vision_templates vt ON vir.template_id = vt.id
     ORDER BY vir.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}
