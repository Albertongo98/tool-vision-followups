// src/tools/inspect_product_quality.js
// Inspección de calidad de producto físico (ISO 8.6). isoEvent (catálogo ISO,
// NO es el evento del bus): "product_quality_inspection".
// Implementa spec-driven-design/001-vision-aio-template-inspection.
import { v4 as uuidv4 } from 'uuid';
import { findActiveTemplate } from '../services/visionTemplateService.js';
import { compare } from '../services/imageSimilarityService.js';
import { saveInspectionResult } from '../services/visionInspectionService.js';
import { writeBuffer, exists } from '../services/storageRefService.js';

export const meta = {
  id: 'inspect_product_quality',
  name: 'Inspección de Calidad de Producto',
  version: '1.1.0',
  category: 'quality',
  description: 'Compara un frame de producción contra el template activo y decide aceptado/rechazado por similitud de imagen (ISO 9001 §8.6).',
  consumes: ['FRAME_CAPTURED'],
  produces: ['DEFECT_FOUND', 'PRODUCT_INSPECTION_PASSED', 'INSPECTION_TEMPLATE_MISSING', 'INSPECTION_IMAGE_UNAVAILABLE']
};

const DEFAULT_THRESHOLDS = {
  similarityMin: 0.94,
  defectConfidenceMin: 0.85,
  maxDiffAreaRatio: 0.03
};

export async function handler (event) {
  const input = event.data || {};
  const { productCode, operationId, stationId, lineId, partId, batchId, frameId, imageRef } = input;
  const inspectionId = uuidv4();

  const template = await findActiveTemplate({ productCode, operationId, stationId, lineId });
  if (!template) {
    return {
      event: { type: 'INSPECTION_TEMPLATE_MISSING', category: 'quality', severity: 'high' },
      asset: event.asset,
      data: {
        inspection_id: inspectionId,
        product_code: productCode,
        operation_id: operationId,
        station_id: stationId,
        line_id: lineId,
        frame_id: frameId,
        iso_clause: '8.6'
      }
    };
  }

  if (!exists(imageRef)) {
    return {
      event: { type: 'INSPECTION_IMAGE_UNAVAILABLE', category: 'quality', severity: 'medium' },
      asset: event.asset,
      data: {
        inspection_id: inspectionId,
        template_id: template.id,
        frame_id: frameId,
        image_ref: imageRef,
        iso_clause: '8.6'
      }
    };
  }

  const thresholds = { ...DEFAULT_THRESHOLDS, ...(template.thresholds || {}) };
  const { similarityScore, diffAreaRatio, boundingBox, evidenceBuffer } = await compare({
    templateRef: template.image_ref,
    frameRef: imageRef,
    maskRef: template.mask_ref
  });

  const passed = similarityScore >= thresholds.similarityMin && diffAreaRatio <= thresholds.maxDiffAreaRatio;

  let evidenceRef = null;
  if (evidenceBuffer) {
    evidenceRef = `storage://vision/evidence/${inspectionId}-diff.png`;
    await writeBuffer(evidenceRef, evidenceBuffer);
  }

  await saveInspectionResult({
    eventId: event.event_id,
    templateId: template.id,
    partId,
    batchId,
    frameId,
    similarityScore,
    diffAreaRatio,
    result: passed ? 'accepted' : 'rejected',
    evidenceRef,
    rawResult: { boundingBox, thresholds }
  });

  if (passed) {
    return {
      event: { type: 'PRODUCT_INSPECTION_PASSED', category: 'quality', severity: 'low' },
      asset: event.asset,
      data: {
        inspection_id: inspectionId,
        part_id: partId,
        batch_id: batchId,
        template_id: template.id,
        template_version: template.version,
        similarity_score: similarityScore,
        inspection_result: 'accepted',
        iso_clause: '8.6'
      }
    };
  }

  const confidence = Number((1 - similarityScore).toFixed(4));
  return {
    event: { type: 'DEFECT_FOUND', category: 'quality', severity: diffAreaRatio > thresholds.maxDiffAreaRatio * 2 ? 'high' : 'medium' },
    asset: event.asset,
    data: {
      inspection_id: inspectionId,
      part_id: partId,
      batch_id: batchId,
      frame_id: frameId,
      product_code: productCode,
      station_id: stationId,
      template_id: template.id,
      template_version: template.version,
      // defectFound se queda en camelCase a propósito: rule-vision-004 y
      // rule-pkg-001 (communication-rules.json, en la plataforma) evalúan
      // literalmente `defectFound == true`. Ya no tenemos forma de tocar ese
      // archivo (tool externa, sin push a IsoTools) — renombrarlo aquí sin
      // que alguien actualice esas 2 reglas del otro lado apaga la cadena
      // completa (manage_nonconformances / analyze_visual_patterns) en silencio.
      defectFound: true,
      defect_type: 'template_mismatch',
      defect_severity: diffAreaRatio > thresholds.maxDiffAreaRatio * 2 ? 'high' : 'medium',
      confidence,
      similarity_score: similarityScore,
      diff_area_ratio: diffAreaRatio,
      bounding_box: boundingBox,
      image_ref: imageRef,
      evidence_ref: evidenceRef,
      inspection_result: 'rejected',
      iso_clause: '8.6'
    }
  };
}
