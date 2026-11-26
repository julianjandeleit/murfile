const MAGIC = new Uint8Array([0x53, 0x4e, 0x44, 0x42, 0x4f, 0x4f, 0x4b, 0x31]);
export const SOUNDBOOK_HEADER_LENGTH = 89;
export const MAX_SOUNDBOOK_PAGES = 100_000;

function isInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function hexToBytes(value, length, label) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new TypeError(`${label} must contain exactly ${length * 2} hexadecimal characters.`);
  }
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Create a fixed-size page envelope for one compressed Ogg Opus book. */
export function createSoundbookPageEnvelope({
  bookId,
  pageIndex,
  pageCount,
  audioLength,
  chunkLength,
  chunkCapacity,
  durationMicros,
  audioSha256,
  chunk,
}) {
  if (!isInteger(pageIndex) || !isInteger(pageCount, 1) ||
      pageCount > MAX_SOUNDBOOK_PAGES || pageIndex >= pageCount) {
    throw new RangeError('Invalid Soundbook page index or count.');
  }
  if (!isInteger(audioLength, 1) || !isInteger(chunkCapacity, 1) ||
      !isInteger(chunkLength) || chunkLength > chunkCapacity ||
      !isInteger(durationMicros, 1)) {
    throw new RangeError('Invalid Soundbook audio or chunk metadata.');
  }
  if (!(chunk instanceof Uint8Array) || chunk.byteLength !== chunkCapacity) {
    throw new TypeError('chunk must be a Uint8Array with chunkCapacity bytes.');
  }
  if (pageCount !== Math.ceil(audioLength / chunkCapacity)) {
    throw new RangeError('Soundbook page count does not match the audio length.');
  }
  const expectedChunkLength = Math.min(chunkCapacity, audioLength - pageIndex * chunkCapacity);
  if (chunkLength !== expectedChunkLength) {
    throw new RangeError('Soundbook chunk length does not match its page position.');
  }

  const id = hexToBytes(bookId, 16, 'bookId');
  const hash = hexToBytes(audioSha256, 32, 'audioSha256');
  const output = new Uint8Array(SOUNDBOOK_HEADER_LENGTH + chunkCapacity);
  output.set(MAGIC, 0);
  output.set(id, 8);
  const view = new DataView(output.buffer);
  view.setUint32(24, pageIndex, false);
  view.setUint32(28, pageCount, false);
  view.setBigUint64(32, BigInt(audioLength), false);
  view.setUint32(40, chunkLength, false);
  view.setUint32(44, chunkCapacity, false);
  view.setBigUint64(48, BigInt(durationMicros), false);
  output[56] = 1;
  output.set(hash, 57);
  output.set(chunk, SOUNDBOOK_HEADER_LENGTH);
  return output;
}

/** Parse and validate a Soundbook page envelope, or return undefined for other UR payloads. */
export function parseSoundbookPageEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < MAGIC.byteLength) return undefined;
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) return undefined;
  }
  if (bytes.byteLength < SOUNDBOOK_HEADER_LENGTH) {
    throw new Error('Truncated Soundbook page envelope.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pageIndex = view.getUint32(24, false);
  const pageCount = view.getUint32(28, false);
  const audioLengthBig = view.getBigUint64(32, false);
  const chunkLength = view.getUint32(40, false);
  const chunkCapacity = view.getUint32(44, false);
  const durationMicrosBig = view.getBigUint64(48, false);

  if (bytes[56] !== 1) throw new Error('Unsupported Soundbook audio codec.');
  if (audioLengthBig > BigInt(Number.MAX_SAFE_INTEGER) ||
      durationMicrosBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Soundbook audio metadata exceeds the safe integer range.');
  }
  const audioLength = Number(audioLengthBig);
  const durationMicros = Number(durationMicrosBig);
  if (pageCount < 1 || pageCount > MAX_SOUNDBOOK_PAGES ||
      pageIndex >= pageCount || chunkCapacity < 1 ||
      chunkLength > chunkCapacity ||
      bytes.byteLength !== SOUNDBOOK_HEADER_LENGTH + chunkCapacity ||
      pageCount !== Math.ceil(audioLength / chunkCapacity) ||
      durationMicros < 1) {
    throw new Error('Invalid Soundbook page metadata.');
  }
  const expectedChunkLength = Math.min(chunkCapacity, audioLength - pageIndex * chunkCapacity);
  if (chunkLength !== expectedChunkLength) {
    throw new Error('Soundbook chunk length does not match its page position.');
  }

  const chunkBytes = bytes.subarray(SOUNDBOOK_HEADER_LENGTH);
  for (let index = chunkLength; index < chunkBytes.byteLength; index += 1) {
    if (chunkBytes[index] !== 0) throw new Error('Soundbook page padding is not zero-filled.');
  }

  return {
    bookId: bytesToHex(bytes.subarray(8, 24)),
    pageIndex,
    pageCount,
    audioLength,
    chunkLength,
    chunkCapacity,
    durationMicros,
    codec: 'ogg-opus',
    audioSha256: bytesToHex(bytes.subarray(57, 89)),
    chunk: chunkBytes.slice(0, chunkLength),
  };
}
