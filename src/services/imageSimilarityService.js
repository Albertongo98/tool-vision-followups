// src/services/imageSimilarityService.js
// Compara un frame de producción contra un template de referencia (ISO 8.6).
// MVP: similitud por diferencia de píxeles en escala de grises, sin alineación
// geométrica avanzada (asume cámara fija). Si se necesita alineación por
// features (ORB/SIFT) más adelante, sustituir solo `loadGray`.
import sharp from 'sharp';
import { readBuffer } from './storageRefService.js';

const SIZE = 256; // lado del cuadrado de comparación
const PIXEL_DIFF_THRESHOLD = 30; // 0-255: a partir de aquí un píxel se considera "distinto"

async function loadGray (storageRef) {
  const buffer = await readBuffer(storageRef);
  const { data } = await sharp(buffer)
    .resize(SIZE, SIZE, { fit: 'fill' })
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

// Compara templateRef vs frameRef. Devuelve similarityScore (0-1),
// diffAreaRatio (0-1) y boundingBox de la zona más diferente (espacio
// normalizado SIZE x SIZE), más el buffer de evidencia (PNG) si hay diferencia.
export async function compare ({ templateRef, frameRef, maskRef }) {
  const [templateGray, frameGray, mask] = await Promise.all([
    loadGray(templateRef),
    loadGray(frameRef),
    loadMask(maskRef)
  ]);

  const diffMask = new Uint8Array(SIZE * SIZE);
  let activePixels = 0;
  let diffPixels = 0;
  let diffSum = 0;

  for (let i = 0; i < SIZE * SIZE; i++) {
    const active = !mask || mask[i] > 127;
    if (!active) continue;
    activePixels++;
    const diff = Math.abs(templateGray[i] - frameGray[i]);
    diffSum += diff;
    if (diff > PIXEL_DIFF_THRESHOLD) {
      diffMask[i] = 1;
      diffPixels++;
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
    evidenceBuffer
  };
}
