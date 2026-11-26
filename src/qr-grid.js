import { encode } from 'fast-png';
import QRCode from 'qrcode';
import { base45Length, MQR_BINARY_OVERHEAD, MQR_PREFIX } from './mqr-protocol.js';

const QR_EC_LEVELS = { low: 'L', medium: 'M', quartile: 'Q', high: 'H' };

function isQrCapacityError(error) {
  return error?.message?.includes('The chosen QR Code version cannot contain this amount of data') ||
    error?.message === 'The amount of data is too big to be stored in a QR Code';
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return number;
}

export function parseGrid(value) {
  const match = /^(\d+)x(\d+)$/i.exec(String(value));
  if (!match) throw new Error('--grid must have the form NxM, e.g. 4x4.');
  const columns = positiveInteger(match[1], '--grid columns');
  const rows = positiveInteger(match[2], '--grid rows');
  if (!Number.isSafeInteger(columns * rows)) throw new Error('--grid dimensions are too large.');
  return { columns, rows };
}

export class RenderedImage {
  constructor({ width, height, pixels }) {
    this.width = width;
    this.height = height;
    this.pixels = pixels;
  }

  toPng() {
    return encode({
      width: this.width,
      height: this.height,
      data: this.pixels,
      channels: 4,
      depth: 8,
    });
  }
}

/** Compose QR images into a white, row-major grid page. */
export function composeGridPage(images, { size, columns, rows, gap, padding }) {
  const pageWidth = columns * size + (columns - 1) * gap + 2 * padding;
  const pageHeight = rows * size + (rows - 1) * gap + 2 * padding;
  const pixelLength = pageWidth * pageHeight * 4;
  if (!Number.isSafeInteger(pixelLength)) throw new Error('Grid page dimensions are too large.');
  if (images.length > columns * rows) throw new Error('Too many QR images for one grid page.');

  const pixels = new Uint8Array(pixelLength);
  pixels.fill(255);
  const rowBytes = size * 4;
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (image.width !== size || image.height !== size) {
      throw new Error('All QR images in a grid must have the configured size.');
    }
    const column = index % columns;
    const row = Math.floor(index / columns);
    const destinationX = padding + column * (size + gap);
    const destinationY = padding + row * (size + gap);
    for (let y = 0; y < size; y += 1) {
      const sourceStart = y * rowBytes;
      const destinationStart = ((destinationY + y) * pageWidth + destinationX) * 4;
      pixels.set(image.pixels.subarray(sourceStart, sourceStart + rowBytes), destinationStart);
    }
  }
  return new RenderedImage({ width: pageWidth, height: pageHeight, pixels });
}

export function qrModulesForFragment(fragment, correction, requestedVersion) {
  const symbol = QRCode.create(fragment, {
    errorCorrectionLevel: QR_EC_LEVELS[correction],
    version: requestedVersion,
  });
  return symbol.modules.size;
}

function renderQrSymbol(symbol, size) {
  const quietZone = 4;
  const modules = symbol.modules.size;
  const totalModules = modules + quietZone * 2;
  const pixelsPerModule = Math.max(1, Math.floor(size / totalModules));
  const rasterSize = totalModules * pixelsPerModule;
  const raster = new Uint8Array(rasterSize * rasterSize * 4);
  raster.fill(255);

  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (symbol.modules.data[row * modules + column] === 0) continue;
      const x0 = (column + quietZone) * pixelsPerModule;
      const y0 = (row + quietZone) * pixelsPerModule;
      for (let y = y0; y < y0 + pixelsPerModule; y += 1) {
        for (let x = x0; x < x0 + pixelsPerModule; x += 1) {
          const offset = (y * rasterSize + x) * 4;
          raster[offset] = 0;
          raster[offset + 1] = 0;
          raster[offset + 2] = 0;
        }
      }
    }
  }

  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(Math.floor((y * rasterSize) / size), rasterSize - 1);
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(Math.floor((x * rasterSize) / size), rasterSize - 1);
      const sourceOffset = (sourceY * rasterSize + sourceX) * 4;
      pixels.set(raster.subarray(sourceOffset, sourceOffset + 4), (y * size + x) * 4);
    }
  }
  return new RenderedImage({ width: size, height: size, pixels });
}

/** Find the largest RaptorQ symbol (8-byte aligned) fitting the selected QR version. */
export function chooseSymbolSize(correction, requestedVersion) {
  if (!QR_EC_LEVELS[correction]) throw new Error(`Unknown QR correction level: ${correction}.`);
  if (requestedVersion !== undefined &&
      (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1 || requestedVersion > 40)) {
    throw new RangeError('QR version must be between 1 and 40.');
  }

  let low = 64;
  let high = Math.floor(0xffff / 8) * 8;
  let best = 0;
  while (low <= high) {
    const candidate = Math.floor(((low + high) / 2) / 8) * 8;
    const textLength = MQR_PREFIX.length + base45Length(MQR_BINARY_OVERHEAD + candidate);
    const probe = `${MQR_PREFIX}${'A'.repeat(textLength - MQR_PREFIX.length)}`;
    try {
      qrModulesForFragment(probe, correction, requestedVersion);
      best = candidate;
      low = candidate + 8;
    } catch (error) {
      if (!isQrCapacityError(error)) throw error;
      high = candidate - 8;
    }
  }
  if (best < 64) throw new Error('No RaptorQ symbol fits the selected QR correction and version.');
  return best;
}

export function renderQrFragment(fragment, { size, correction, version }) {
  const symbol = QRCode.create(fragment, {
    errorCorrectionLevel: QR_EC_LEVELS[correction],
    version,
  });
  return renderQrSymbol(symbol, size);
}
