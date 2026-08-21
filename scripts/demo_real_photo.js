// scripts/demo_real_photo.js
// Demo con fotos reales (no sintéticas): registra la primera imagen como
// template activo y corre el handler real de inspect_product_quality contra
// cada imagen siguiente. Pensado para cámara fija (ver nota en
// imageSimilarityService.js) — todas las fotos deben tener el mismo encuadre.
//
// Uso: node scripts/demo_real_photo.js <template.jpg> <frame1.jpg> [frame2.jpg ...]
// Requiere Postgres propio arriba (docker compose up -d).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createTemplate, activateTemplate } from '../src/services/visionTemplateService.js';
import { writeBuffer } from '../src/services/storageRefService.js';
import { handler } from '../src/tools/inspect_product_quality.js';
import pool from '../src/db/index.js';

const [templatePath, ...framePaths] = process.argv.slice(2);

if (!templatePath || framePaths.length === 0) {
  console.error('Uso: node scripts/demo_real_photo.js <template.jpg> <frame1.jpg> [frame2.jpg ...]');
  process.exit(1);
}

const PRODUCT_CODE = 'DEMO';
const OPERATION_ID = 'OP-DEMO';
const STATION_ID = 'AOI-DEMO';
const LINE_ID = 'LINE-DEMO';

function frameEvent (imageRef, frameId) {
  return {
    event_id: randomUUID(),
    event: { type: 'FRAME_CAPTURED', category: 'quality', severity: 'low' },
    asset: { asset_id: STATION_ID, asset_type: 'inspection_station' },
    data: {
      productCode: PRODUCT_CODE,
      operationId: OPERATION_ID,
      stationId: STATION_ID,
      lineId: LINE_ID,
      partId: `PART-${frameId}`,
      batchId: 'BATCH-DEMO',
      frameId,
      imageRef
    }
  };
}

async function main () {
  const templateRef = `storage://vision/templates/demo-${randomUUID()}${path.extname(templatePath)}`;
  await writeBuffer(templateRef, await fs.promises.readFile(templatePath));

  const template = await createTemplate({
    productCode: PRODUCT_CODE,
    operationId: OPERATION_ID,
    stationId: STATION_ID,
    lineId: LINE_ID,
    imageRef: templateRef,
    thresholds: {
      similarityMin: Number(process.env.SIMILARITY_MIN || 0.94),
      maxDiffAreaRatio: Number(process.env.MAX_DIFF_AREA_RATIO || 0.03)
    }
  });
  await activateTemplate(template.id);
  console.log(`Template activo: ${template.id} (${templatePath})\n`);

  for (const framePath of framePaths) {
    const frameId = `FRAME-${randomUUID()}`;
    const frameRef = `storage://vision/frames/demo-${frameId}${path.extname(framePath)}`;
    await writeBuffer(frameRef, await fs.promises.readFile(framePath));

    const result = await handler(frameEvent(frameRef, frameId));
    console.log(`${path.basename(framePath)} -> ${result.event.type}`);
    console.log(`  similarity_score=${result.data.similarity_score ?? '-'} diff_area_ratio=${result.data.diff_area_ratio ?? '-'}`);
    if (result.data.evidence_ref) console.log(`  evidencia: ${result.data.evidence_ref}`);
    console.log('');
  }

  console.log('Corre "npm run view" y abre http://localhost:3300 para verlo con imágenes.');
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
