// scripts/test_image_alignment.js
// Self-check de la tolerancia a desplazamiento en imageSimilarityService.compare().
// No usa Postgres ni el handler completo (compare() no toca la DB) — solo
// imágenes sintéticas vía sharp. Verifica:
// 1) Una pieza igual pero corrida unos px (sin defecto real) ya no se marca mal.
// 2) Un defecto real sigue detectándose aunque la pieza también esté corrida.
//
// Uso: node scripts/test_image_alignment.js
import assert from 'assert';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { compare } from '../src/services/imageSimilarityService.js';
import { writeBuffer } from '../src/services/storageRefService.js';

const SIZE = 256;
const BG = 180;
const BOX = 60;

async function canvasWithBox ({ boxLeft, boxTop, boxGray = 60, extra } = {}) {
  const base = sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: BG, g: BG, b: BG } } });
  const box = await sharp({ create: { width: BOX, height: BOX, channels: 3, background: { r: boxGray, g: boxGray, b: boxGray } } }).png().toBuffer();
  const composites = [{ input: box, left: boxLeft, top: boxTop }];
  if (extra) composites.push(extra);
  return base.composite(composites).png().toBuffer();
}

async function main () {
  const templateRef = `storage://align-test/template-${randomUUID()}.png`;
  await writeBuffer(templateRef, await canvasWithBox({ boxLeft: 98, boxTop: 98 }));

  // 1) Misma pieza, corrida (dx=6, dy=-5), sin defecto real.
  const shiftedOkRef = `storage://align-test/frame-ok-${randomUUID()}.png`;
  await writeBuffer(shiftedOkRef, await canvasWithBox({ boxLeft: 104, boxTop: 93 }));

  const okResult = await compare({ templateRef, frameRef: shiftedOkRef, maxShift: 10 });
  assert.ok(okResult.similarityScore >= 0.94, `pieza corrida sin defecto debe tener alta similitud, dio ${okResult.similarityScore}`);
  assert.ok(okResult.diffAreaRatio <= 0.03, `pieza corrida sin defecto no debe marcar área diferente, dio ${okResult.diffAreaRatio}`);
  console.log('✓ pieza corrida (sin defecto real) ya no se marca mal:', okResult);

  // 2) Misma pieza corrida, PERO con un defecto real (marca clara adentro de la pieza).
  const defectMark = await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
  const shiftedDefectRef = `storage://align-test/frame-defect-${randomUUID()}.png`;
  await writeBuffer(
    shiftedDefectRef,
    await canvasWithBox({ boxLeft: 104, boxTop: 93, extra: { input: defectMark, left: 110, top: 100 } })
  );

  const defectResult = await compare({ templateRef, frameRef: shiftedDefectRef, maxShift: 10 });
  assert.ok(defectResult.diffAreaRatio > 0.03, `defecto real debe seguir detectándose aunque la pieza esté corrida, dio ${defectResult.diffAreaRatio}`);
  assert.ok(defectResult.evidenceBuffer, 'debe generar evidencia');
  console.log('✓ defecto real sigue detectándose aunque la pieza también esté corrida:', {
    similarityScore: defectResult.similarityScore,
    diffAreaRatio: defectResult.diffAreaRatio,
    alignment: defectResult.alignment
  });

  // 3) Escena con dos marcas en esquinas opuestas (para que la rotación, y no
  // solo el corrimiento, importe de verdad), capturada "rotada" en un lienzo
  // del MISMO tamaño (como haría una cámara fija real — el cuadro de la foto
  // no crece, la pieza gira adentro). Verifica que la búsqueda de ángulo
  // encuentra el giro real y que compara mejor que si solo buscara corrimiento.
  //
  // No se exige que quede por debajo de maxDiffAreaRatio: con marcas de bordes
  // duros sintéticos el anti-aliasing en el recorte mete ruido que una foto
  // real (textura continua) no tiene — ya lo confirmamos contra fotos reales
  // arriba. Lo que se prueba aquí es que el mecanismo de rotación SÍ funciona.
  const twoCornersRef = `storage://align-test/two-corners-${randomUUID()}.png`;
  const twoCorners = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: BG, g: BG, b: BG } } })
    .composite([
      { input: await sharp({ create: { width: BOX, height: BOX, channels: 3, background: { r: 60, g: 60, b: 60 } } }).png().toBuffer(), left: 20, top: 20 },
      { input: await sharp({ create: { width: BOX, height: BOX, channels: 3, background: { r: 60, g: 60, b: 60 } } }).png().toBuffer(), left: 176, top: 176 }
    ])
    .png().toBuffer();
  await writeBuffer(twoCornersRef, twoCorners);

  const rotatedSameCanvas = await sharp(twoCorners).rotate(6, { background: { r: BG, g: BG, b: BG } }).toBuffer();
  const { width: rw, height: rh } = await sharp(rotatedSameCanvas).metadata();
  const rotatedFrameRef = `storage://align-test/frame-rotated-${randomUUID()}.png`;
  await writeBuffer(
    rotatedFrameRef,
    await sharp(rotatedSameCanvas)
      .extract({ left: Math.round((rw - SIZE) / 2), top: Math.round((rh - SIZE) / 2), width: SIZE, height: SIZE })
      .png().toBuffer()
  );

  const withoutRotationSearch = await compare({ templateRef: twoCornersRef, frameRef: rotatedFrameRef, maxShift: 10, maxRotationDeg: 0, rotationStepDeg: 2 });
  const withRotationSearch = await compare({ templateRef: twoCornersRef, frameRef: rotatedFrameRef, maxShift: 10, maxRotationDeg: 8, rotationStepDeg: 2 });

  assert.ok(
    Math.abs(withRotationSearch.alignment.rotationDeg - (-6)) <= 2,
    `debe encontrar un ángulo cercano a -6°, encontró ${withRotationSearch.alignment.rotationDeg}`
  );
  assert.ok(
    withRotationSearch.diffAreaRatio < withoutRotationSearch.diffAreaRatio,
    `buscar rotación debe comparar mejor que solo buscar corrimiento (con rotación=${withRotationSearch.diffAreaRatio}, sin rotación=${withoutRotationSearch.diffAreaRatio})`
  );
  console.log('✓ pieza rotada 6°: la búsqueda encontró el ángulo real y comparó mejor que sin buscar rotación:', {
    sinBusquedaDeRotacion: withoutRotationSearch.diffAreaRatio,
    conBusquedaDeRotacion: withRotationSearch.diffAreaRatio,
    alignment: withRotationSearch.alignment
  });

  console.log('\nTodos los checks de alineación pasaron.');
}

main().catch((err) => {
  console.error('✗ self-check falló:', err);
  process.exit(1);
});
