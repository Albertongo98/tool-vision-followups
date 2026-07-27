// src/services/storageRefService.js
// Resuelve referencias `storage://...` a rutas de disco local. MVP: el storage
// real (S3/MinIO) puede sustituir este módulo después sin tocar a los
// llamadores, ya que solo exponen resolvePath/writeBuffer.
import fs from 'fs';
import path from 'path';

const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage');

export function resolvePath (storageRef) {
  if (!storageRef || !storageRef.startsWith('storage://')) {
    throw new Error(`storageRef inválido: ${storageRef}`);
  }
  const relative = storageRef.replace('storage://', '');
  return path.join(STORAGE_ROOT, relative);
}

export function exists (storageRef) {
  try {
    return fs.existsSync(resolvePath(storageRef));
  } catch {
    return false;
  }
}

export async function writeBuffer (storageRef, buffer) {
  const filePath = resolvePath(storageRef);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  return storageRef;
}

export async function readBuffer (storageRef) {
  return fs.promises.readFile(resolvePath(storageRef));
}
