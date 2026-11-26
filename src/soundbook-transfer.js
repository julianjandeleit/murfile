const MAGIC_V1 = new Uint8Array([0x53, 0x4e, 0x44, 0x42, 0x4f, 0x4f, 0x4b, 0x31]);
const MAGIC_V2 = new Uint8Array([0x53, 0x4e, 0x44, 0x42, 0x4f, 0x4f, 0x4b, 0x32]);
const MAGIC_V3 = new Uint8Array([0x53, 0x4e, 0x44, 0x42, 0x4f, 0x4f, 0x4b, 0x33]);
export const SOUNDBOOK_HEADER_LENGTH = 89;
export const SOUNDBOOK_SEGMENT_HEADER_LENGTH = 121;
export const SOUNDBOOK_CHUNK_HEADER_LENGTH = 121;
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
  output.set(MAGIC_V1, 0);
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

/** Create a fixed-size envelope containing one independently playable Ogg segment. */
export function createSoundbookSegmentEnvelope({
  bookId,
  pageIndex,
  pageCount,
  audioLength,
  segmentLength,
  segmentCapacity,
  durationMicros,
  audioSha256,
  segmentSha256,
  segment,
}) {
  if (!isInteger(pageIndex) || !isInteger(pageCount, 1) ||
      pageCount > MAX_SOUNDBOOK_PAGES || pageIndex >= pageCount) {
    throw new RangeError('Invalid Soundbook page index or count.');
  }
  if (!isInteger(audioLength, 1) || !isInteger(segmentCapacity, 1) ||
      !isInteger(segmentLength, 1) || segmentLength > segmentCapacity ||
      !isInteger(durationMicros, 1)) {
    throw new RangeError('Invalid Soundbook audio or segment metadata.');
  }
  if (!(segment instanceof Uint8Array) || segment.byteLength !== segmentCapacity) {
    throw new TypeError('segment must be a Uint8Array with segmentCapacity bytes.');
  }

  const id = hexToBytes(bookId, 16, 'bookId');
  const audioHash = hexToBytes(audioSha256, 32, 'audioSha256');
  const segmentHash = hexToBytes(segmentSha256, 32, 'segmentSha256');
  const output = new Uint8Array(SOUNDBOOK_SEGMENT_HEADER_LENGTH + segmentCapacity);
  output.set(MAGIC_V2, 0);
  output.set(id, 8);
  const view = new DataView(output.buffer);
  view.setUint32(24, pageIndex, false);
  view.setUint32(28, pageCount, false);
  view.setBigUint64(32, BigInt(audioLength), false);
  view.setUint32(40, segmentLength, false);
  view.setUint32(44, segmentCapacity, false);
  view.setBigUint64(48, BigInt(durationMicros), false);
  output[56] = 1;
  output.set(segmentHash, 57);
  output.set(audioHash, 89);
  output.set(segment, SOUNDBOOK_SEGMENT_HEADER_LENGTH);
  return output;
}

/** Create a fixed-size envelope for an unchanged byte range of the source Ogg Opus file. */
export function createSoundbookChunkEnvelope({
  bookId,
  pageIndex,
  pageCount,
  audioLength,
  chunkLength,
  chunkCapacity,
  durationMicros,
  audioSha256,
  chunkSha256,
  chunk,
}) {
  if (!isInteger(pageIndex) || !isInteger(pageCount, 1) ||
      pageCount > MAX_SOUNDBOOK_PAGES || pageIndex >= pageCount) {
    throw new RangeError('Invalid Soundbook page index or count.');
  }
  if (!isInteger(audioLength, 1) || !isInteger(chunkCapacity, 1) ||
      !isInteger(chunkLength, 1) || chunkLength > chunkCapacity ||
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
  const chunkHash = hexToBytes(chunkSha256, 32, 'chunkSha256');
  const audioHash = hexToBytes(audioSha256, 32, 'audioSha256');
  const output = new Uint8Array(SOUNDBOOK_CHUNK_HEADER_LENGTH + chunkCapacity);
  output.set(MAGIC_V3, 0);
  output.set(id, 8);
  const view = new DataView(output.buffer);
  view.setUint32(24, pageIndex, false);
  view.setUint32(28, pageCount, false);
  view.setBigUint64(32, BigInt(audioLength), false);
  view.setUint32(40, chunkLength, false);
  view.setUint32(44, chunkCapacity, false);
  view.setBigUint64(48, BigInt(durationMicros), false);
  output[56] = 1;
  output.set(chunkHash, 57);
  output.set(audioHash, 89);
  output.set(chunk, SOUNDBOOK_CHUNK_HEADER_LENGTH);
  return output;
}

function hasMagic(bytes, magic) {
  return bytes.byteLength >= magic.byteLength &&
    magic.every((byte, index) => bytes[index] === byte);
}

function parseSoundbookV1(bytes) {
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
    format: 'SOUNDBOOK-1',
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

function parseSoundbookV2(bytes) {
  if (bytes.byteLength < SOUNDBOOK_SEGMENT_HEADER_LENGTH) {
    throw new Error('Truncated Soundbook segment envelope.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pageIndex = view.getUint32(24, false);
  const pageCount = view.getUint32(28, false);
  const audioLengthBig = view.getBigUint64(32, false);
  const segmentLength = view.getUint32(40, false);
  const segmentCapacity = view.getUint32(44, false);
  const durationMicrosBig = view.getBigUint64(48, false);

  if (bytes[56] !== 1) throw new Error('Unsupported Soundbook audio codec.');
  if (audioLengthBig > BigInt(Number.MAX_SAFE_INTEGER) ||
      durationMicrosBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Soundbook audio metadata exceeds the safe integer range.');
  }
  const audioLength = Number(audioLengthBig);
  const durationMicros = Number(durationMicrosBig);
  if (pageCount < 1 || pageCount > MAX_SOUNDBOOK_PAGES ||
      pageIndex >= pageCount || audioLength < 1 ||
      segmentCapacity < 1 || segmentLength < 1 ||
      segmentLength > segmentCapacity ||
      bytes.byteLength !== SOUNDBOOK_SEGMENT_HEADER_LENGTH + segmentCapacity ||
      durationMicros < 1) {
    throw new Error('Invalid Soundbook segment metadata.');
  }

  const segmentPadded = bytes.subarray(SOUNDBOOK_SEGMENT_HEADER_LENGTH);
  for (let index = segmentLength; index < segmentPadded.byteLength; index += 1) {
    if (segmentPadded[index] !== 0) throw new Error('Soundbook segment padding is not zero-filled.');
  }
  return {
    format: 'SOUNDBOOK-2',
    bookId: bytesToHex(bytes.subarray(8, 24)),
    pageIndex,
    pageCount,
    audioLength,
    segmentLength,
    segmentCapacity,
    durationMicros,
    codec: 'ogg-opus',
    segmentSha256: bytesToHex(bytes.subarray(57, 89)),
    audioSha256: bytesToHex(bytes.subarray(89, 121)),
    segmentBytes: segmentPadded.slice(0, segmentLength),
  };
}

function parseSoundbookV3(bytes) {
  if (bytes.byteLength < SOUNDBOOK_CHUNK_HEADER_LENGTH) {
    throw new Error('Truncated Soundbook byte-chunk envelope.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pageIndex = view.getUint32(24, false);
  const pageCount = view.getUint32(28, false);
  const audioLengthBig = view.getBigUint64(32, false);
  const chunkLength = view.getUint32(40, false);
  const chunkCapacity = view.getUint32(44, false);
  const durationMicrosBig = view.getBigUint64(48, false);

  if (bytes[56] !== 1) throw new Error('Unsupported Soundbook source format.');
  if (audioLengthBig > BigInt(Number.MAX_SAFE_INTEGER) ||
      durationMicrosBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Soundbook audio metadata exceeds the safe integer range.');
  }
  const audioLength = Number(audioLengthBig);
  const durationMicros = Number(durationMicrosBig);
  if (pageCount < 1 || pageCount > MAX_SOUNDBOOK_PAGES ||
      pageIndex >= pageCount || audioLength < 1 ||
      chunkCapacity < 1 || chunkLength < 1 || chunkLength > chunkCapacity ||
      bytes.byteLength !== SOUNDBOOK_CHUNK_HEADER_LENGTH + chunkCapacity ||
      pageCount !== Math.ceil(audioLength / chunkCapacity) ||
      durationMicros < 1) {
    throw new Error('Invalid Soundbook byte-chunk metadata.');
  }
  const expectedChunkLength = Math.min(chunkCapacity, audioLength - pageIndex * chunkCapacity);
  if (chunkLength !== expectedChunkLength) {
    throw new Error('Soundbook chunk length does not match its page position.');
  }

  const paddedChunk = bytes.subarray(SOUNDBOOK_CHUNK_HEADER_LENGTH);
  for (let index = chunkLength; index < paddedChunk.byteLength; index += 1) {
    if (paddedChunk[index] !== 0) throw new Error('Soundbook chunk padding is not zero-filled.');
  }
  return {
    format: 'SOUNDBOOK-3',
    bookId: bytesToHex(bytes.subarray(8, 24)),
    pageIndex,
    pageCount,
    audioLength,
    chunkLength,
    chunkCapacity,
    durationMicros,
    codec: 'ogg-opus',
    chunkSha256: bytesToHex(bytes.subarray(57, 89)),
    audioSha256: bytesToHex(bytes.subarray(89, 121)),
    chunkBytes: paddedChunk.slice(0, chunkLength),
  };
}

/** Parse and validate a Soundbook page envelope, or return undefined for other UR payloads. */
export function parseSoundbookPageEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array)) return undefined;
  if (hasMagic(bytes, MAGIC_V3)) return parseSoundbookV3(bytes);
  if (hasMagic(bytes, MAGIC_V1)) return parseSoundbookV1(bytes);
  if (hasMagic(bytes, MAGIC_V2)) return parseSoundbookV2(bytes);
  return undefined;
}
