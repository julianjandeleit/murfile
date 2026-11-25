const MAGIC = new Uint8Array([0x4d, 0x55, 0x52, 0x50, 0x41, 0x47, 0x45, 0x31]);
export const PAGE_ENVELOPE_HEADER_LENGTH = 60;

function isInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function hexToBytes(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new TypeError('fileSha256 must contain exactly 64 hexadecimal characters.');
  }
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Create a fixed-size page payload carried inside a standard ur:bytes resource. */
export function createPageEnvelope({
  pageIndex,
  pageCount,
  originalSize,
  chunkLength,
  chunk,
  fileSha256,
}) {
  if (!isInteger(pageIndex) || !isInteger(pageCount, 1) || pageIndex >= pageCount) {
    throw new RangeError('Invalid page index or page count.');
  }
  if (!isInteger(originalSize) || !isInteger(chunkLength)) {
    throw new RangeError('Invalid original or chunk length.');
  }
  if (!(chunk instanceof Uint8Array) || chunkLength > chunk.byteLength) {
    throw new TypeError('chunk must be a Uint8Array containing chunkLength bytes.');
  }

  const hash = hexToBytes(fileSha256);
  const output = new Uint8Array(PAGE_ENVELOPE_HEADER_LENGTH + chunk.byteLength);
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint32(8, pageIndex, false);
  view.setUint32(12, pageCount, false);
  view.setBigUint64(16, BigInt(originalSize), false);
  view.setUint32(24, chunkLength, false);
  output.set(hash, 28);
  output.set(chunk, PAGE_ENVELOPE_HEADER_LENGTH);
  return output;
}

/** Return page metadata and its unpadded chunk, or undefined for an ordinary file payload. */
export function parsePageEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < MAGIC.byteLength) return undefined;
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) return undefined;
  }
  if (bytes.byteLength < PAGE_ENVELOPE_HEADER_LENGTH) {
    throw new Error('Truncated page-transfer envelope.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pageIndex = view.getUint32(8, false);
  const pageCount = view.getUint32(12, false);
  const originalSizeBig = view.getBigUint64(16, false);
  const chunkLength = view.getUint32(24, false);
  const chunkCapacity = bytes.byteLength - PAGE_ENVELOPE_HEADER_LENGTH;

  if (originalSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Page-transfer file size exceeds the safe integer range.');
  }
  const originalSize = Number(originalSizeBig);
  if (pageCount < 1 || pageIndex >= pageCount || chunkLength > chunkCapacity) {
    throw new Error('Invalid page-transfer envelope metadata.');
  }
  if (pageCount !== Math.max(1, Math.ceil(originalSize / chunkCapacity))) {
    throw new Error('Inconsistent page count in page-transfer envelope.');
  }

  return {
    pageIndex,
    pageCount,
    originalSize,
    chunkLength,
    chunkCapacity,
    fileSha256: bytesToHex(bytes.subarray(28, 60)),
    chunk: bytes.slice(PAGE_ENVELOPE_HEADER_LENGTH, PAGE_ENVELOPE_HEADER_LENGTH + chunkLength),
  };
}
