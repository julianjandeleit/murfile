const OGG_CAPTURE_PATTERN = [0x4f, 0x67, 0x67, 0x53];

/** Return the byte offset after the last complete Ogg page in a byte prefix. */
export function completeOggPrefixLength(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Ogg input must be a Uint8Array.');
  }

  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 27) break;
    if (!OGG_CAPTURE_PATTERN.every((byte, index) => bytes[offset + index] === byte)) {
      throw new Error(`Invalid Ogg capture pattern at byte ${offset}.`);
    }
    if (bytes[offset + 4] !== 0) throw new Error(`Unsupported Ogg page version at byte ${offset}.`);

    const segmentCount = bytes[offset + 26];
    const lacingOffset = offset + 27;
    const bodyOffset = lacingOffset + segmentCount;
    if (bodyOffset > bytes.byteLength) break;

    let bodyLength = 0;
    for (let index = lacingOffset; index < bodyOffset; index += 1) {
      bodyLength += bytes[index];
    }
    const pageEnd = bodyOffset + bodyLength;
    if (pageEnd > bytes.byteLength) break;
    offset = pageEnd;
  }
  return offset;
}

/** Check the Ogg framing and Opus identification header used by Soundbook input files. */
export function isOggOpus(bytes) {
  if (!(bytes instanceof Uint8Array) ||
      bytes.byteLength < 4 ||
      !OGG_CAPTURE_PATTERN.every((byte, index) => bytes[index] === byte)) {
    return false;
  }
  const firstPageLength = completeOggPrefixLength(bytes);
  if (firstPageLength === 0) return false;
  const opusHead = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];
  const searchLimit = Math.min(firstPageLength, 64 * 1024);
  for (let offset = 0; offset + opusHead.length <= searchLimit; offset += 1) {
    if (opusHead.every((byte, index) => bytes[offset + index] === byte)) return true;
  }
  return false;
}
