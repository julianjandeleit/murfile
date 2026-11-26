import { sha256 } from '@noble/hashes/sha2.js';
import { Decoder as RaptorQDecoder, Encoder as RaptorQEncoder, EncodingPacket } from 'murfile/raptorq';

export const MQR_PREFIX = 'MQR1:';
export const MQR_HEADER_LENGTH = 76;
export const MQR_BINARY_OVERHEAD = MQR_HEADER_LENGTH + 4 + 4;
const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const BASE45_VALUES = new Map(Array.from(BASE45_ALPHABET, (character, index) => [character, index]));

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
});

export function encodeBase45(bytes) {
  const output = [];
  for (let index = 0; index < bytes.length; index += 2) {
    if (index + 1 < bytes.length) {
      let value = bytes[index] * 256 + bytes[index + 1];
      const c = value % 45;
      value = Math.floor(value / 45);
      const d = value % 45;
      const e = Math.floor(value / 45);
      output.push(BASE45_ALPHABET[c], BASE45_ALPHABET[d], BASE45_ALPHABET[e]);
    } else {
      const value = bytes[index];
      output.push(BASE45_ALPHABET[value % 45], BASE45_ALPHABET[Math.floor(value / 45)]);
    }
  }
  return output.join('');
}

export function decodeBase45(text) {
  if (typeof text !== 'string' || text.length % 3 === 1) {
    throw new TypeError('Invalid Base45 length.');
  }
  const output = [];
  for (let index = 0; index < text.length;) {
    const remaining = text.length - index;
    if (remaining >= 3) {
      const c = BASE45_VALUES.get(text[index]);
      const d = BASE45_VALUES.get(text[index + 1]);
      const e = BASE45_VALUES.get(text[index + 2]);
      if (c === undefined || d === undefined || e === undefined) {
        throw new TypeError('Invalid Base45 character.');
      }
      const value = c + 45 * d + 2025 * e;
      if (value > 0xffff) throw new TypeError('Base45 group exceeds 16-bit range.');
      output.push(value >>> 8, value & 0xff);
      index += 3;
    } else {
      const c = BASE45_VALUES.get(text[index]);
      const d = BASE45_VALUES.get(text[index + 1]);
      if (c === undefined || d === undefined) throw new TypeError('Invalid Base45 character.');
      const value = c + 45 * d;
      if (value > 0xff) throw new TypeError('Base45 group exceeds 8-bit range.');
      output.push(value);
      index += 2;
    }
  }
  return Uint8Array.from(output);
}

export function base45Length(byteLength) {
  return Math.floor(byteLength / 2) * 3 + (byteLength % 2 ? 2 : 0);
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value, length, label) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new TypeError(`${label} must contain exactly ${length * 2} hexadecimal characters.`);
  }
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

function randomTransferId() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random values are unavailable.');
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
}

function makeFrame({
  transferId,
  fileLength,
  fileSha256,
  pageIndex,
  pageCount,
  chunkLength,
  chunkCapacity,
  symbolSize,
  repairSymbols,
  packet,
}) {
  const header = new Uint8Array(MQR_HEADER_LENGTH);
  header.set(transferId, 0);
  const view = new DataView(header.buffer);
  view.setBigUint64(16, BigInt(fileLength), false);
  header.set(fileSha256, 24);
  view.setUint32(56, pageIndex, false);
  view.setUint32(60, pageCount, false);
  view.setUint32(64, chunkLength, false);
  view.setUint32(68, chunkCapacity, false);
  view.setUint16(72, symbolSize, false);
  view.setUint16(74, repairSymbols, false);

  const body = new Uint8Array(header.length + packet.length + 4);
  body.set(header);
  body.set(packet, header.length);
  new DataView(body.buffer).setUint32(body.length - 4, crc32(body.subarray(0, body.length - 4)), false);
  return `${MQR_PREFIX}${encodeBase45(body)}`;
}

function distributePackets(packets, sourceSymbols, repairSymbols) {
  const sourcePackets = [];
  const repairPackets = [];
  for (const packet of packets) {
    const symbolId = EncodingPacket.deserialize(packet).encoding_symbol_id();
    (symbolId < sourceSymbols ? sourcePackets : repairPackets).push(packet);
  }
  if (sourcePackets.length !== sourceSymbols || repairPackets.length !== repairSymbols) {
    throw new Error('RaptorQ returned an unexpected number of source or repair symbols.');
  }

  const repairPositions = new Set(
    Array.from(
      { length: repairSymbols },
      (_, index) => Math.floor(((index + 1) * packets.length) / (repairSymbols + 1)),
    ),
  );
  const arranged = new Array(packets.length);
  let sourceIndex = 0;
  let repairIndex = 0;
  for (let position = 0; position < arranged.length; position += 1) {
    arranged[position] = repairPositions.has(position)
      ? repairPackets[repairIndex++]
      : sourcePackets[sourceIndex++];
  }
  return arranged;
}

export function parseMqrFrame(value) {
  if (typeof value !== 'string' || !value.startsWith(MQR_PREFIX)) {
    throw new TypeError('Frame does not use the MQR1 protocol.');
  }
  const bytes = decodeBase45(value.slice(MQR_PREFIX.length));
  if (bytes.length < MQR_BINARY_OVERHEAD) throw new TypeError('MQR frame is truncated.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const symbolSize = view.getUint16(72, false);
  const packetLength = symbolSize + 4;
  if (symbolSize < 64 || bytes.length !== MQR_HEADER_LENGTH + packetLength + 4) {
    throw new TypeError('MQR frame has an invalid symbol size.');
  }
  const expectedCrc = view.getUint32(bytes.length - 4, false);
  if (crc32(bytes.subarray(0, bytes.length - 4)) !== expectedCrc) {
    throw new TypeError('MQR frame checksum failed.');
  }

  const fileLengthBig = view.getBigUint64(16, false);
  if (fileLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('MQR file length exceeds the safe integer range.');
  }
  const fileLength = Number(fileLengthBig);
  const pageIndex = view.getUint32(56, false);
  const pageCount = view.getUint32(60, false);
  const chunkLength = view.getUint32(64, false);
  const chunkCapacity = view.getUint32(68, false);
  const repairSymbols = view.getUint16(74, false);
  const sourceSymbols = chunkCapacity / symbolSize;
  if (!Number.isInteger(sourceSymbols) || sourceSymbols < 1 || sourceSymbols > 564 ||
      repairSymbols < 1 || pageCount < 1 || pageIndex >= pageCount ||
      chunkLength > chunkCapacity ||
      pageCount !== Math.max(1, Math.ceil(fileLength / chunkCapacity)) ||
      chunkLength !== Math.min(chunkCapacity, Math.max(0, fileLength - pageIndex * chunkCapacity))) {
    throw new TypeError('MQR frame metadata is inconsistent.');
  }

  const packet = bytes.slice(MQR_HEADER_LENGTH, MQR_HEADER_LENGTH + packetLength);
  const parsedPacket = EncodingPacket.deserialize(packet);
  if (parsedPacket.source_block_number() !== 0 ||
      parsedPacket.data().byteLength !== symbolSize) {
    throw new TypeError('MQR RaptorQ packet does not match the frame metadata.');
  }

  return {
    transferId: bytesToHex(bytes.subarray(0, 16)),
    fileLength,
    fileSha256: bytesToHex(bytes.subarray(24, 56)),
    pageIndex,
    pageCount,
    chunkLength,
    chunkCapacity,
    symbolSize,
    sourceSymbols,
    repairSymbols,
    packet,
    encodingSymbolId: parsedPacket.encoding_symbol_id(),
  };
}

export class FileEncoder {
  #frames;
  #nextFrame = 0;
  #nextPage = 0;

  constructor(data, {
    symbolSize = 512,
    sourceSymbols = 14,
    repairSymbols = 2,
    transferId,
  } = {}) {
    if (!(data instanceof Uint8Array)) throw new TypeError('data must be a Uint8Array or Buffer.');
    if (!Number.isSafeInteger(symbolSize) || symbolSize < 64 || symbolSize > 0xffff || symbolSize % 8) {
      throw new RangeError('symbolSize must be a multiple of 8 between 64 and 65535.');
    }
    if (!Number.isSafeInteger(sourceSymbols) || sourceSymbols < 1 || sourceSymbols > 564 ||
        !Number.isSafeInteger(repairSymbols) || repairSymbols < 1 || repairSymbols > 0xffff) {
      throw new RangeError('Invalid RaptorQ source or repair symbol count.');
    }

    this.symbolSize = symbolSize;
    this.sourceSymbols = sourceSymbols;
    this.repairSymbols = repairSymbols;
    this.chunkCapacity = sourceSymbols * symbolSize;
    this.pageCount = Math.max(1, Math.ceil(data.byteLength / this.chunkCapacity));
    if (this.pageCount > 0xffffffff) throw new RangeError('File requires too many MQR pages.');
    this.fileLength = data.byteLength;
    const fileSha256Bytes = sha256(data);
    this.fileSha256 = bytesToHex(fileSha256Bytes);
    if (transferId === undefined) {
      this.transferId = bytesToHex(randomTransferId());
    } else if (typeof transferId === 'string') {
      hexToBytes(transferId, 16, 'transferId');
      this.transferId = transferId.toLowerCase();
    } else if (transferId instanceof Uint8Array && transferId.byteLength === 16) {
      this.transferId = bytesToHex(transferId);
    } else {
      throw new TypeError('transferId must be 16 bytes or 32 hexadecimal characters.');
    }
    const transferIdBytes = hexToBytes(this.transferId, 16, 'transferId');
    this.#frames = [];
    for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex += 1) {
      const start = pageIndex * this.chunkCapacity;
      const chunkLength = Math.max(0, Math.min(this.chunkCapacity, data.byteLength - start));
      const paddedChunk = new Uint8Array(this.chunkCapacity);
      paddedChunk.set(data.subarray(start, start + chunkLength));
      const encoder = RaptorQEncoder.with_defaults(paddedChunk, symbolSize);
      try {
        const packets = encoder.encode(repairSymbols);
        if (packets.length !== sourceSymbols + repairSymbols) {
          throw new Error(
            `RaptorQ produced ${packets.length} symbols; expected ${sourceSymbols + repairSymbols}.`,
          );
        }
        this.#frames.push(distributePackets(packets, sourceSymbols, repairSymbols).map((packet) => makeFrame({
          transferId: transferIdBytes,
          fileLength: data.byteLength,
          fileSha256: fileSha256Bytes,
          pageIndex,
          pageCount: this.pageCount,
          chunkLength,
          chunkCapacity: this.chunkCapacity,
          symbolSize,
          repairSymbols,
          packet,
        })));
      } finally {
        encoder.free();
      }
    }
    this.frameCount = this.pageCount * (sourceSymbols + repairSymbols);
    this.sourceSymbolCount = this.pageCount * sourceSymbols;
  }

  get emittedCount() {
    return this.#nextFrame;
  }

  nextFragment() {
    if (this.#nextFrame >= this.frameCount) return undefined;
    const pageIndex = Math.floor(this.#nextFrame / (this.sourceSymbols + this.repairSymbols));
    const frameIndex = this.#nextFrame % (this.sourceSymbols + this.repairSymbols);
    this.#nextFrame += 1;
    return this.#frames[pageIndex][frameIndex];
  }

  nextPage() {
    if (this.#nextPage >= this.pageCount) return undefined;
    const page = this.#frames[this.#nextPage];
    this.#nextPage += 1;
    this.#nextFrame = Math.max(this.#nextFrame, this.#nextPage * (this.sourceSymbols + this.repairSymbols));
    return [...page];
  }

  take(count) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError('count must be a positive safe integer.');
    }
    const frames = [];
    for (let index = 0; index < count; index += 1) {
      const frame = this.nextFragment();
      if (frame === undefined) break;
      frames.push(frame);
    }
    return frames;
  }

  *[Symbol.iterator]() {
    while (true) {
      const frame = this.nextFragment();
      if (frame === undefined) return;
      yield frame;
    }
  }
}

function sameTransfer(a, b) {
  return a.transferId === b.transferId &&
    a.fileLength === b.fileLength &&
    a.fileSha256 === b.fileSha256 &&
    a.pageCount === b.pageCount &&
    a.chunkCapacity === b.chunkCapacity &&
    a.symbolSize === b.symbolSize &&
    a.sourceSymbols === b.sourceSymbols &&
    a.repairSymbols === b.repairSymbols;
}

export class FileDecoder {
  #transfer;
  #pages = new Map();
  #blocks = new Map();
  #seen = new Set();
  #result;

  constructor() {
    this.reset();
  }

  reset() {
    for (const block of this.#blocks.values()) block.decoder.free();
    this.#transfer = undefined;
    this.#pages.clear();
    this.#blocks.clear();
    this.#seen.clear();
    this.#result = undefined;
    this.fragmentsReceived = 0;
    this.duplicatesIgnored = 0;
    this.redundantFragments = 0;
    this.invalidFrames = 0;
  }

  get complete() {
    return this.#result !== undefined;
  }

  get result() {
    return this.#result === undefined ? undefined : new Uint8Array(this.#result);
  }

  get progress() {
    if (this.complete) return 1;
    if (!this.#transfer) return 0;
    let activeProgress = 0;
    for (const block of this.#blocks.values()) {
      activeProgress += Math.min(1, block.seen.size / this.#transfer.sourceSymbols);
    }
    return Math.min(1, (this.#pages.size + activeProgress) / this.#transfer.pageCount);
  }

  get status() {
    const pageCount = this.#transfer?.pageCount ?? null;
    const completedPages = this.#pages.size;
    const missingPages = pageCount === null
      ? []
      : Array.from({ length: pageCount }, (_, index) => index).filter((index) => !this.#pages.has(index));
    return {
      mode: this.#transfer ? 'mqr1' : 'waiting',
      complete: this.complete,
      progress: this.progress,
      fragmentsReceived: this.fragmentsReceived,
      duplicatesIgnored: this.duplicatesIgnored,
      redundantFragments: this.redundantFragments,
      invalidFrames: this.invalidFrames,
      completedPages,
      pageCount,
      missingPages,
      activeSessions: this.#blocks.size,
      expectedSha256: this.#transfer?.fileSha256 ?? null,
    };
  }

  #acceptPage(frame, chunk) {
    if (chunk.length !== frame.chunkCapacity) {
      throw new Error(`RaptorQ returned an invalid length for page ${frame.pageIndex + 1}.`);
    }
    for (let index = frame.chunkLength; index < chunk.length; index += 1) {
      if (chunk[index] !== 0) throw new Error(`Page ${frame.pageIndex + 1} has invalid zero padding.`);
    }
    const page = chunk.slice(0, frame.chunkLength);
    if (this.#pages.size + 1 !== frame.pageCount) {
      this.#pages.set(frame.pageIndex, page);
      return {
        kind: 'page-complete',
        pageIndex: frame.pageIndex,
        pageCount: frame.pageCount,
        status: this.status,
      };
    }

    const output = new Uint8Array(frame.fileLength);
    for (let pageIndex = 0; pageIndex < frame.pageCount; pageIndex += 1) {
      const pageBytes = pageIndex === frame.pageIndex ? page : this.#pages.get(pageIndex);
      if (!pageBytes) throw new Error(`MQR page ${pageIndex + 1} is missing.`);
      output.set(pageBytes, pageIndex * frame.chunkCapacity);
    }
    if (bytesToHex(sha256(output)) !== frame.fileSha256) {
      throw new Error('MQR file SHA-256 integrity check failed.');
    }
    this.#pages.set(frame.pageIndex, page);
    this.#result = output;
    return { kind: 'complete', bytes: this.result, pageIndex: frame.pageIndex, pageCount: frame.pageCount, status: this.status };
  }

  add(value) {
    const text = String(value ?? '').replace(/\r?\n$/, '');
    if (!text.startsWith(MQR_PREFIX)) return { kind: 'ignored', status: this.status };

    try {
      const frame = parseMqrFrame(text);
      if (this.complete) return { kind: 'complete', bytes: this.result, status: this.status };
      if (this.#pages.has(frame.pageIndex)) {
        this.redundantFragments += 1;
        return { kind: 'redundant', status: this.status };
      }
      if (this.#transfer && !sameTransfer(this.#transfer, frame)) {
        throw new Error('Frame belongs to a different MQR transfer.');
      }
      const frameKey = `${frame.transferId}:${frame.pageIndex}:${frame.encodingSymbolId}`;
      if (this.#seen.has(frameKey)) {
        this.duplicatesIgnored += 1;
        return { kind: 'duplicate', status: this.status };
      }
      this.#seen.add(frameKey);
      this.#transfer ??= frame;
      let block = this.#blocks.get(frame.pageIndex);
      if (!block) {
        block = {
          decoder: RaptorQDecoder.with_defaults(BigInt(frame.chunkCapacity), frame.symbolSize),
          seen: new Set(),
        };
        this.#blocks.set(frame.pageIndex, block);
      }
      block.seen.add(frame.encodingSymbolId);
      this.fragmentsReceived += 1;
      const recovered = block.decoder.add(frame.packet);
      if (!recovered) return { kind: 'fragment', status: this.status };

      block.decoder.free();
      this.#blocks.delete(frame.pageIndex);
      const result = this.#acceptPage(frame, recovered);
      return { ...result, status: this.status };
    } catch (error) {
      this.invalidFrames += 1;
      return {
        kind: 'invalid',
        message: error instanceof Error ? error.message : String(error),
        status: this.status,
      };
    }
  }

  addMany(frames) {
    const results = [];
    for (const frame of frames) {
      results.push(this.add(frame));
      if (this.complete) break;
    }
    return results;
  }
}

export function isMqrCandidate(value) {
  return typeof value === 'string' && value.startsWith(MQR_PREFIX);
}

export function mqrTransferId(value) {
  return parseMqrFrame(value).transferId;
}

