import { RenderedImage, qrModuleCount, renderUrQr } from '@blockchaincommons/multipart-ur';
import { encodeQr as encodeFixedQr } from './vendor/qr-fixed.js';
import { createBytesUr, FileEncoder } from './encoder.js';

const AUTO_FRAME_REDUNDANCY = 0.10;
const QR_EC_LEVELS = { low: 'L', medium: 'M', quartile: 'Q', high: 'H' };

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return number;
}

export function parseGrid(value) {
  const match = /^(\d+)x(\d+)$/i.exec(String(value));
  if (!match) throw new Error('--grid must have the form NxM, e.g. 3x3.');
  const columns = positiveInteger(match[1], '--grid columns');
  const rows = positiveInteger(match[2], '--grid rows');
  if (!Number.isSafeInteger(columns * rows)) {
    throw new Error('--grid dimensions are too large.');
  }
  return { columns, rows };
}

/** Compose QR images into a white, row-major grid page. */
export function composeGridPage(images, { size, columns, rows, gap, padding }) {
  const pageWidth = columns * size + (columns - 1) * gap + 2 * padding;
  const pageHeight = rows * size + (rows - 1) * gap + 2 * padding;
  const pixelLength = pageWidth * pageHeight * 4;
  if (!Number.isSafeInteger(pixelLength)) {
    throw new Error('Grid page dimensions are too large.');
  }
  if (images.length > columns * rows) {
    throw new Error('Too many QR images for one grid page.');
  }

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
      pixels.set(
        image.pixels.subarray(sourceStart, sourceStart + rowBytes),
        destinationStart,
      );
    }
  }

  return new RenderedImage({ width: pageWidth, height: pageHeight, pixels });
}

export function qrModulesForFragment(fragment, correction, requestedVersion) {
  const bytes = new TextEncoder().encode(fragment.toUpperCase());
  if (requestedVersion !== undefined) {
    return encodeFixedQr(bytes, QR_EC_LEVELS[correction], requestedVersion).width;
  }
  return qrModuleCount(bytes, correction);
}

function renderFixedUrQr(fragment, { size, correction, version }) {
  const bytes = new TextEncoder().encode(fragment.toUpperCase());
  const symbol = encodeFixedQr(bytes, QR_EC_LEVELS[correction], version);
  const quietZone = 1;
  const totalModules = symbol.width + quietZone * 2;
  const pixelsPerModule = Math.max(1, Math.floor(size / totalModules));
  const rasterSize = totalModules * pixelsPerModule;
  const raster = new Uint8Array(rasterSize * rasterSize * 4);
  raster.fill(255);

  for (let row = 0; row < symbol.width; row += 1) {
    for (let column = 0; column < symbol.width; column += 1) {
      if (symbol.modules[row * symbol.width + column] === 0) continue;
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
      const targetOffset = (y * size + x) * 4;
      pixels.set(raster.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }

  return new RenderedImage({ width: size, height: size, pixels });
}

function candidateFragmentsFitQrVersion(
  data,
  fragmentLength,
  correction,
  requestedVersion,
  requestedFrameCount,
  requestedSourcePartCount,
) {
  let testData = data;
  if (requestedSourcePartCount !== undefined) {
    const targetCborLength = fragmentLength * requestedSourcePartCount;
    const headerLength = targetCborLength < 24 ? 1
      : targetCborLength <= 0xff ? 2
        : targetCborLength <= 0xffff ? 3
          : targetCborLength <= 0xffffffff ? 5 : 9;
    testData = new Uint8Array(Math.max(0, targetCborLength - headerLength));
  }
  const encoder = new FileEncoder(testData, { maxFragmentLength: fragmentLength });
  if (requestedSourcePartCount !== undefined &&
      encoder.sourcePartCount !== requestedSourcePartCount) {
    return false;
  }
  if (encoder.isSinglePart) {
    try {
      qrModulesForFragment(encoder.nextFragment(), correction, requestedVersion);
      return true;
    } catch {
      return false;
    }
  }

  const frameCount = requestedFrameCount
    ?? Math.ceil(encoder.sourcePartCount * (1 + AUTO_FRAME_REDUNDANCY));
  const testCount = Math.max(frameCount, encoder.sourcePartCount);
  let firstFragment;
  let lastFragment;

  for (let index = 0; index < testCount; index += 1) {
    const fragment = encoder.nextFragment();
    if (fragment === undefined) return false;
    if (index === 0) firstFragment = fragment;
    if (index === testCount - 1) lastFragment = fragment;
  }

  try {
    qrModulesForFragment(firstFragment, correction, requestedVersion);
    if (lastFragment !== firstFragment) {
      qrModulesForFragment(lastFragment, correction, requestedVersion);
    }
    return true;
  } catch {
    return false;
  }
}

/** Find the largest fragment payload fitting the automatic or requested QR version. */
export function chooseMaxFragmentLength(
  data,
  correction,
  requestedVersion,
  requestedFrameCount,
  requestedSourcePartCount,
) {
  const bytes = new Uint8Array(data);
  const payloadLength = createBytesUr(bytes).cbor.toData().byteLength;
  let lowerBound = 1;
  let upperBound = payloadLength;
  let best = 0;

  while (lowerBound <= upperBound) {
    const candidate = Math.floor((lowerBound + upperBound) / 2);
    if (candidateFragmentsFitQrVersion(
      bytes,
      candidate,
      correction,
      requestedVersion,
      requestedFrameCount,
      requestedSourcePartCount,
    )) {
      best = candidate;
      lowerBound = candidate + 1;
    } else {
      upperBound = candidate - 1;
    }
  }

  if (best === 0) {
    const target = requestedVersion === undefined
      ? 'the maximum supported QR version'
      : `QR version ${requestedVersion}`;
    throw new Error(`No UR fragment fits ${target} with correction level ${correction}.`);
  }

  return best;
}

export function renderQrFragment(fragment, { size, correction, version }) {
  return version === undefined
    ? renderUrQr(fragment, { size, correction })
    : renderFixedUrQr(fragment, { size, correction, version });
}
