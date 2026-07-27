// src/services/visionTemplateService.js
// Registro, versionado y activación de templates de inspección visual (ISO 8.6).
// Invariante VAI-002: solo un template `active` por combinación
// productCode + operationId + stationId + lineId.
import crypto from 'crypto';
import pool from '../db/index.js';
import { readBuffer } from './storageRefService.js';

async function computeImageHash (imageRef) {
  try {
    const buffer = await readBuffer(imageRef);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null; // imagen aún no subida al storage local: no es fatal, solo no hay hash
  }
}

export async function createTemplate ({
  productCode, operationId, stationId, lineId,
  imageRef, maskRef, thresholds, createdBy
}) {
  const { rows: versionRows } = await pool.query(
    `SELECT COALESCE(MAX(version), 0) AS max_version FROM vision_templates
     WHERE product_code = $1 AND operation_id = $2 AND station_id = $3 AND line_id = $4`,
    [productCode, operationId, stationId, lineId]
  );
  const version = Number(versionRows[0].max_version) + 1;
  const imageHash = await computeImageHash(imageRef);

  const { rows } = await pool.query(
    `INSERT INTO vision_templates (
       product_code, operation_id, station_id, line_id, version, status,
       image_ref, mask_ref, image_hash, thresholds, created_by
     ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10)
     RETURNING *`,
    [productCode, operationId, stationId, lineId, version, imageRef, maskRef || null, imageHash, thresholds || {}, createdBy || null]
  );
  return rows[0];
}

export async function listTemplates ({ productCode, stationId } = {}) {
  const conditions = [];
  const values = [];
  if (productCode) {
    values.push(productCode);
    conditions.push(`product_code = $${values.length}`);
  }
  if (stationId) {
    values.push(stationId);
    conditions.push(`station_id = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM vision_templates ${where} ORDER BY created_at DESC`,
    values
  );
  return rows;
}

export async function activateTemplate (id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM vision_templates WHERE id = $1', [id]);
    const template = rows[0];
    if (!template) {
      throw new Error(`Template ${id} no existe`);
    }

    // VAI-002: la versión activa anterior de la misma combinación pasa a archived.
    await client.query(
      `UPDATE vision_templates SET status = 'archived'
       WHERE product_code = $1 AND operation_id = $2 AND station_id = $3 AND line_id = $4
         AND status = 'active' AND id != $5`,
      [template.product_code, template.operation_id, template.station_id, template.line_id, id]
    );

    const { rows: updated } = await client.query(
      `UPDATE vision_templates SET status = 'active', activated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );

    await client.query('COMMIT');
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function findActiveTemplate ({ productCode, operationId, stationId, lineId }) {
  const { rows } = await pool.query(
    `SELECT * FROM vision_templates
     WHERE product_code = $1 AND operation_id = $2 AND station_id = $3 AND line_id = $4
       AND status = 'active'
     LIMIT 1`,
    [productCode, operationId, stationId, lineId]
  );
  return rows[0] || null;
}
