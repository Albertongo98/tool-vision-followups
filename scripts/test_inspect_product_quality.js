// scripts/test_inspect_product_quality.js
// ─────────────────────────────────────────────────────────────────────────────
// Self-check de spec-driven-design/001-vision-aio-template-inspection.
// No usa HTTP: genera imágenes sintéticas, registra un template, lo activa y
// llama directo al handler de inspect_product_quality para verificar los 4
// caminos de la spec (accepted, rejected, template missing, image unavailable).
//
// Requiere Postgres propio de esta tool arriba y migrado (docker compose up -d,
// el esquema lo aplica db/init.sql).
//
// Uso: node scripts/test_inspect_product_quality.js
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import assert from 'assert';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { createTemplate, activateTemplate } from '../src/services/visionTemplateService.js';
import { writeBuffer } from '../src/services/storageRefService.js';
import { handler } from '../src/tools/inspect_product_quality.js';
import pool from '../src/db/index.js';

const SIZE = 256;

async function solidImage (gray) {
  return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: gray, g: gray, b: gray } } })
    .png()
    .toBuffer();
}

async function imageWithBox (baseGray, boxGray) {
  const base = sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: baseGray, g: baseGray, b: baseGray } } });
  const box = await sharp({ create: { width: 60, height: 60, channels: 3, background: { r: boxGray, g: boxGray, b: boxGray } } }).png().toBuffer();
  return base.composite([{ input: box, top: 100, left: 100 }]).png().toBuffer();
}

function frameEvent (overrides) {
  return {
    event_id: randomUUID(),
    event: { type: 'FRAME_CAPTURED', category: 'quality', severity: 'low' },
    asset: { asset_id: 'AOI-01', asset_type: 'inspection_station' },
    data: {
      productCode: 'KIT-TEST',
      operationId: 'OP-TEST',
      stationId: 'AOI-TEST',
      lineId: 'LINE-TEST',
      partId: 'PART-TEST-0001',
      batchId: 'BATCH-TEST-A',
      frameId: `FRAME-${randomUUID()}`,
      ...overrides
    }
  };
}

async function main () {
  const templateRef = `storage://vision/templates/test-${randomUUID()}.png`;
  await writeBuffer(templateRef, await solidImage(128));

  const template = await createTemplate({
    productCode: 'KIT-TEST',
    operationId: 'OP-TEST',
    stationId: 'AOI-TEST',
    lineId: 'LINE-TEST',
    imageRef: templateRef,
    thresholds: { similarityMin: 0.94, maxDiffAreaRatio: 0.03 }
  });
  await activateTemplate(template.id);
  console.log('✓ template creado y activado:', template.id);

  // 1) Frame idéntico al template → aceptado
  const goodFrameRef = `storage://vision/frames/test-good-${randomUUID()}.png`;
  await writeBuffer(goodFrameRef, await solidImage(128));
  const passEvent = await handler(frameEvent({ imageRef: goodFrameRef }));
  assert.strictEqual(passEvent.event.type, 'PRODUCT_INSPECTION_PASSED', 'frame idéntico debe aceptar');
  assert.ok(passEvent.data.similarity_score >= 0.94);
  console.log('✓ PRODUCT_INSPECTION_PASSED con similarity_score', passEvent.data.similarity_score);

  // 2) Frame con defecto (recuadro muy distinto) → rechazado
  const badFrameRef = `storage://vision/frames/test-bad-${randomUUID()}.png`;
  await writeBuffer(badFrameRef, await imageWithBox(128, 255));
  const defectEvent = await handler(frameEvent({ imageRef: badFrameRef }));
  assert.strictEqual(defectEvent.event.type, 'DEFECT_FOUND', 'frame con defecto debe rechazar');
  assert.strictEqual(defectEvent.data.defectFound, true); // sigue en camelCase a propósito, ver comentario en el handler
  assert.ok(defectEvent.data.evidence_ref, 'debe generar evidencia de diff');
  console.log('✓ DEFECT_FOUND con diff_area_ratio', defectEvent.data.diff_area_ratio, 'evidencia:', defectEvent.data.evidence_ref);

  // 3) Sin template activo para la combinación → INSPECTION_TEMPLATE_MISSING
  const missingTemplateEvent = await handler(frameEvent({ imageRef: goodFrameRef, productCode: 'KIT-NO-TEMPLATE' }));
  assert.strictEqual(missingTemplateEvent.event.type, 'INSPECTION_TEMPLATE_MISSING');
  console.log('✓ INSPECTION_TEMPLATE_MISSING cuando no hay template activo');

  // 4) Imagen inexistente → INSPECTION_IMAGE_UNAVAILABLE
  const unavailableEvent = await handler(frameEvent({ imageRef: 'storage://vision/frames/no-existe.png' }));
  assert.strictEqual(unavailableEvent.event.type, 'INSPECTION_IMAGE_UNAVAILABLE');
  console.log('✓ INSPECTION_IMAGE_UNAVAILABLE cuando la imagen no existe');

  console.log('\nTodos los checks de inspect_product_quality pasaron.');
  await pool.end();
}

main().catch((err) => {
  console.error('✗ self-check falló:', err);
  process.exit(1);
});
