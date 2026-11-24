import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const generatedPath = resolve(dirname(fileURLToPath(import.meta.url)), 'qr-fixed.generated.js');

try {
  await access(generatedPath);
} catch {
  await import('../../scripts/build-fixed-qr.js');
  await access(generatedPath);
}

const generated = await import(pathToFileURL(generatedPath).href);
export const encodeQr = generated.encodeQr;
