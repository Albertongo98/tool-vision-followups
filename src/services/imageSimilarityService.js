// src/services/imageSimilarityService.js
// Compara un frame de producción contra un template de referencia (ISO 8.6).
// MVP: similitud por diferencia de píxeles en escala de grises. Tolera que la
// pieza esté desplazada (traslación en x/y) y/o rotada unos grados (no quedó
// perfectamente centrada/orientada en el fixture): prueba un puñado de
// ángulos de rotación y, para cada uno, busca el mejor corrimiento, antes de
// comparar. No tolera rotaciones grandes (pieza "de cabeza" o en cualquier
// orientación) ni cambios de perspectiva — eso sí necesitaría alineación por
// features (ORB/SIFT) en vez de esta búsqueda por fuerza bruta.
import sharp from 'sharp';
import { readBuffer } from './storageRefService.js';

const SIZE = 256; // lado del cuadrado de comparación
const PIXEL_DIFF_THRESHOLD = 30; // 0-255: a partir de aquí un píxel se considera "distinto"
const DEFAULT_MAX_SHIFT = 10; // px de tolerancia de desplazamiento buscados (en la grilla 256x256)
const DEFAULT_MAX_ROTATION_DEG = 8; // grados de tolerancia de rotación buscados, en cada sentido
const DEFAULT_ROTATION_STEP_DEG = 2; // resolución de la búsqueda de ángulo

async function loadGray (storageRef, rotateDeg = 0) {
  const buffer = await readBuffer(storageRef);
  // Primero cuadra a SIZE x SIZE (mismo tratamiento sea cual sea el tamaño
  // original), y solo entonces rota. `rotate()` expande el lienzo para no
  // recortar esquinas — si después se volviera a encajar con resize(fit:fill)
  // eso ESTIRARÍA el contenido (lo encogería) en vez de solo rotarlo, lo que
  // arruina la comparación. Por eso se recorta (extract) de vuelta al centro
  // en vez de re-escalar.
  let squared = await sharp(buffer).resize(SIZE, SIZE, { fit: 'fill' }).toBuffer();
  if (rotateDeg) {
    const rotated = await sharp(squared).rotate(rotateDeg, { background: { r: 128, g: 128, b: 128 } }).toBuffer();
    const { width, height } = await sharp(rotated).metadata();
    squared = await sharp(rotated)
      .extract({ left: Math.round((width - SIZE) / 2), top: Math.round((height - SIZE) / 2), width: SIZE, height: SIZE })
      .toBuffer();
  }
  const { data } = await sharp(squared)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data; // Buffer de SIZE*SIZE bytes (1 canal)
}

async function loadMask (storageRef) {
  if (!storageRef) return null;
  const buffer = await readBuffer(storageRef);
  const { data } = await sharp(buffer)
    .resize(SIZE, SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data; // píxel > 127 = región a comparar; <= 127 = ignorar
}

function boundingBoxOf (diffMask) {
  let minX = SIZE;
  let minY = SIZE;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (diffMask[(y * SIZE) + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: (maxX - minX) + 1, h: (maxY - minY) + 1 };
}

// Diferencia promedio si el frame se compara corrido (dx,dy) respecto al
// template, considerando solo la zona donde ambos se solapan tras el corrimiento.
function avgDiffAtShift (templateGray, frameGray, dx, dy) {
  const xStart = Math.max(0, -dx);
  const xEnd = Math.min(SIZE, SIZE - dx);
  const yStart = Math.max(0, -dy);
  const yEnd = Math.min(SIZE, SIZE - dy);
  if (xEnd <= xStart || yEnd <= yStart) return Infinity;

  let sum = 0;
  let count = 0;
  for (let y = yStart; y < yEnd; y++) {
    const templateRow = y * SIZE;
    const frameRow = (y + dy) * SIZE;
    for (let x = xStart; x < xEnd; x++) {
      sum += Math.abs(templateGray[templateRow + x] - frameGray[frameRow + x + dx]);
      count++;
    }
  }
  return sum / count;
}

// Búsqueda por fuerza bruta del corrimiento (dx,dy) que mejor alinea frame
// contra template, dentro de +-maxShift px. O(maxShift² * SIZE²): a 256x256
// con maxShift=10 son ~26M operaciones (~cientos de ms) — sobra para un
// evento de inspección cada pocos segundos.
function findBestShift (templateGray, frameGray, maxShift) {
  let best = { dx: 0, dy: 0, avgDiff: avgDiffAtShift(templateGray, frameGray, 0, 0) };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      if (dx === 0 && dy === 0) continue;
      const avgDiff = avgDiffAtShift(templateGray, frameGray, dx, dy);
      if (avgDiff < best.avgDiff) best = { dx, dy, avgDiff };
    }
  }
  return best;
}

// Prueba un puñado de ángulos de rotación del frame (-maxRotationDeg a
// +maxRotationDeg, cada rotationStepDeg) y, para cada uno, el mejor
// corrimiento — se queda con la combinación (ángulo, dx, dy) de menor
// diferencia promedio. Re-decodifica/rota el frame por cada ángulo probado
// (más caro que el shift search puro): con el default (8°, paso 2° = 9
// ángulos) son ~9 pasadas de findBestShift, del orden de 1-2s por inspección.
// ponytail: fuerza bruta sobre un rango acotado de rotación (piensa "la pieza
// quedó unos grados chueca en el fixture", no "la pieza puede llegar en
// cualquier orientación"). Si en Heyco las piezas llegan giradas más allá de
// maxRotationDeg, o volteadas, esto no alcanza — ahí sí hace falta alineación
// por features (ORB/SIFT), que es una dependencia nueva y más pesada.
async function findBestAlignment (templateGray, frameRef, maxShift, maxRotationDeg, rotationStepDeg) {
  let best = null;
  for (let angle = -maxRotationDeg; angle <= maxRotationDeg; angle += rotationStepDeg) {
    const frameGray = await loadGray(frameRef, angle);
    const shift = findBestShift(templateGray, frameGray, maxShift);
    if (!best || shift.avgDiff < best.shift.avgDiff) {
      best = { angle, shift, frameGray };
    }
  }
  return best;
}

async function buildEvidenceBuffer (frameGray, diffMask) {
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = frameGray[i];
    if (diffMask[i]) {
      rgb[(i * 3) + 0] = 255; // resalta en rojo las zonas distintas
      rgb[(i * 3) + 1] = 0;
      rgb[(i * 3) + 2] = 0;
    } else {
      rgb[(i * 3) + 0] = v;
      rgb[(i * 3) + 1] = v;
      rgb[(i * 3) + 2] = v;
    }
  }
  return sharp(rgb, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
}

// Compara templateRef vs frameRef, tolerando que frameRef esté desplazado
// hasta maxShift px y/o rotado hasta maxRotationDeg grados respecto al
// template (busca la mejor combinación ángulo+corrimiento antes de
// comparar). Devuelve similarityScore (0-1), diffAreaRatio (0-1) y
// boundingBox de la zona más diferente (en el espacio del frame ya rotado al
// mejor ángulo encontrado), más el buffer de evidencia (PNG) si hay diferencia.
export async function compare ({
  templateRef, frameRef, maskRef,
  maxShift = DEFAULT_MAX_SHIFT,
  maxRotationDeg = DEFAULT_MAX_ROTATION_DEG,
  rotationStepDeg = DEFAULT_ROTATION_STEP_DEG
}) {
  const [templateGray, mask] = await Promise.all([
    loadGray(templateRef),
    loadMask(maskRef)
  ]);

  const { angle, shift, frameGray } = await findBestAlignment(templateGray, frameRef, maxShift, maxRotationDeg, rotationStepDeg);
  const { dx, dy } = shift;

  const diffMask = new Uint8Array(SIZE * SIZE);
  let activePixels = 0;
  let diffPixels = 0;
  let diffSum = 0;

  // Recorre en coordenadas del FRAME (no del template) para que boundingBox y
  // evidencia queden sobre la foto tal como se capturó, no sobre una versión
  // desplazada. Por cada pixel del frame, busca su correspondiente en el
  // template restando el corrimiento (dx,dy) encontrado.
  for (let fy = 0; fy < SIZE; fy++) {
    const ty = fy - dy;
    if (ty < 0 || ty >= SIZE) continue; // fuera del solape tras alinear
    for (let fx = 0; fx < SIZE; fx++) {
      const tx = fx - dx;
      if (tx < 0 || tx >= SIZE) continue;

      const idxFrame = (fy * SIZE) + fx;
      const idxTemplate = (ty * SIZE) + tx;

      const active = !mask || mask[idxTemplate] > 127;
      if (!active) continue;

      activePixels++;
      const diff = Math.abs(templateGray[idxTemplate] - frameGray[idxFrame]);
      diffSum += diff;
      if (diff > PIXEL_DIFF_THRESHOLD) {
        diffMask[idxFrame] = 1;
        diffPixels++;
      }
    }
  }

  if (activePixels === 0) activePixels = 1; // evita división por cero si la máscara está vacía

  const similarityScore = Math.max(0, 1 - (diffSum / activePixels / 255));
  const diffAreaRatio = diffPixels / activePixels;
  const boundingBox = boundingBoxOf(diffMask);

  let evidenceBuffer = null;
  if (diffPixels > 0) {
    evidenceBuffer = await buildEvidenceBuffer(frameGray, diffMask);
  }

  return {
    similarityScore: Number(similarityScore.toFixed(4)),
    diffAreaRatio: Number(diffAreaRatio.toFixed(4)),
    boundingBox,
    evidenceBuffer,
    alignment: { dx, dy, rotationDeg: angle }
  };
}
