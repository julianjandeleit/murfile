import { MultipartDecoder } from '@blockchaincommons/uniform-resources';
import { decodeBytewords, encodeBytewords } from '@blockchaincommons/uniform-resources/bytewords';
import {
  decodeFountainPart,
  encodeFountainPart,
  FountainEncoder,
} from '@blockchaincommons/uniform-resources/fountain';
import { createBytesUr } from './encoder.js';

const PAGE_UR_TYPE = 'murpage';
const MAX_CODE_SYMBOLS = 255;

function multiply(a, b) {
  let product = 0;
  while (b > 0) {
    if (b & 1) product ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
    b >>>= 1;
  }
  return product;
}

function power(value, exponent) {
  let result = 1;
  while (exponent > 0) {
    if (exponent & 1) result = multiply(result, value);
    value = multiply(value, value);
    exponent >>>= 1;
  }
  return result;
}

function inverse(value) {
  if (value === 0) throw new Error('Cannot invert zero in the page erasure code.');
  return power(value, 254);
}

function invertMatrix(matrix) {
  const size = matrix.length;
  const rows = matrix.map((row, index) => [
    ...row,
    ...Array.from({ length: size }, (_, column) => Number(index === column)),
  ]);

  for (let column = 0; column < size; column += 1) {
    const pivot = rows.findIndex((row, index) => index >= column && row[column] !== 0);
    if (pivot === -1) throw new Error('Page erasure-code symbols are not independent.');
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];

    const scale = inverse(rows[column][column]);
    for (let index = 0; index < size * 2; index += 1) {
      rows[column][index] = multiply(rows[column][index], scale);
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column || rows[row][column] === 0) continue;
      const factor = rows[row][column];
      for (let index = 0; index < size * 2; index += 1) {
        rows[row][index] ^= multiply(factor, rows[column][index]);
      }
    }
  }

  return rows.map((row) => row.slice(size));
}

function coefficientRow(index, sourcePartCount) {
  const x = index + 1;
  return Array.from({ length: sourcePartCount }, (_, powerIndex) => power(x, powerIndex));
}

function partFromUr(value) {
  const separator = value.lastIndexOf('/');
  if (separator === -1 || separator === value.length - 1) {
    throw new TypeError('Malformed multipart UR bytewords payload.');
  }
  return decodeFountainPart(decodeBytewords(value.slice(separator + 1), 'minimal'));
}

function urFromPart(part, type = 'bytes') {
  const bytewords = encodeBytewords(encodeFountainPart(part), 'minimal');
  return `ur:${type}/${part.seqNum}-${part.seqLen}/${bytewords}`;
}

function samePartMetadata(a, b) {
  return a.seqLen === b.seqLen &&
    a.messageLen === b.messageLen &&
    a.checksum === b.checksum &&
    a.data.byteLength === b.data.byteLength;
}

/** Encode every page QR as a mixed symbol from a Vandermonde MDS erasure code. */
export function encodePageFragments(data, maxFragmentLength, frameCount) {
  if (!(data instanceof Uint8Array)) throw new TypeError('data must be a Uint8Array.');
  if (!Number.isSafeInteger(frameCount) || frameCount < 2 || frameCount > MAX_CODE_SYMBOLS) {
    throw new RangeError(`A page must contain 2-${MAX_CODE_SYMBOLS} QR fragments.`);
  }

  const payload = createBytesUr(data).cbor.toData();
  const fountain = new FountainEncoder(payload, maxFragmentLength);
  const sourcePartCount = fountain.partCount;
  if (sourcePartCount >= frameCount) {
    throw new RangeError('A page needs at least one erasure-recovery fragment.');
  }

  const sourceParts = Array.from({ length: sourcePartCount }, () => fountain.nextPart());
  const fragments = [];
  for (let symbolIndex = 0; symbolIndex < frameCount; symbolIndex += 1) {
    const coefficients = coefficientRow(symbolIndex, sourcePartCount);
    const codedData = new Uint8Array(sourceParts[0].data.byteLength);
    for (let sourceIndex = 0; sourceIndex < sourcePartCount; sourceIndex += 1) {
      const sourceData = sourceParts[sourceIndex].data;
      for (let byteIndex = 0; byteIndex < codedData.byteLength; byteIndex += 1) {
        codedData[byteIndex] ^= multiply(coefficients[sourceIndex], sourceData[byteIndex]);
      }
    }
    fragments.push(urFromPart({
      ...sourceParts[0],
      seqNum: symbolIndex + 1,
      data: codedData,
    }, PAGE_UR_TYPE));
  }

  return { fragments, sourcePartCount };
}

/** Decodes page-coded MDS symbols and continues to support legacy standard MUR pages. */
export class PageMultipartDecoder {
  #decoder = new MultipartDecoder();
  #pageParts = new Map();
  #pageMetadata;

  get done() {
    return this.#decoder.done;
  }

  get result() {
    return this.#decoder.result;
  }

  get progress() {
    if (this.#decoder.done) return 1;
    if (!this.#pageMetadata) return this.#decoder.progress;
    return Math.min(1, this.#pageParts.size / this.#pageMetadata.seqLen);
  }

  add(value) {
    const type = /^ur:([^/]+)\//i.exec(value)?.[1]?.toLowerCase();
    if (type !== PAGE_UR_TYPE) return this.#decoder.add(value);

    const part = partFromUr(value);
    if (part.seqLen < 1 || part.seqLen > MAX_CODE_SYMBOLS ||
        part.seqNum < 1 || part.seqNum > MAX_CODE_SYMBOLS) {
      throw new Error('Invalid page erasure-code symbol index.');
    }
    if (this.#pageMetadata && !samePartMetadata(this.#pageMetadata, part)) {
      throw new Error('Page erasure-code symbol is inconsistent with previous symbols.');
    }
    this.#pageMetadata ??= part;

    const existing = this.#pageParts.get(part.seqNum);
    if (existing) {
      if (existing.some((byte, index) => byte !== part.data[index])) {
        throw new Error('Conflicting data received for a page erasure-code symbol.');
      }
      return false;
    }
    this.#pageParts.set(part.seqNum, part.data);

    if (this.#pageParts.size >= part.seqLen) this.#reconstruct(part);
    return true;
  }

  #reconstruct(metadata) {
    const symbols = [...this.#pageParts.entries()]
      .slice(0, metadata.seqLen);
    const matrix = symbols.map(([symbolIndex]) =>
      coefficientRow(symbolIndex - 1, metadata.seqLen));
    const decodingMatrix = invertMatrix(matrix);
    const sourceParts = Array.from(
      { length: metadata.seqLen },
      () => new Uint8Array(metadata.data.byteLength),
    );

    for (let sourceIndex = 0; sourceIndex < metadata.seqLen; sourceIndex += 1) {
      for (let symbolIndex = 0; symbolIndex < metadata.seqLen; symbolIndex += 1) {
        const codedData = symbols[symbolIndex][1];
        const coefficient = decodingMatrix[sourceIndex][symbolIndex];
        for (let byteIndex = 0; byteIndex < codedData.byteLength; byteIndex += 1) {
          sourceParts[sourceIndex][byteIndex] ^= multiply(coefficient, codedData[byteIndex]);
        }
      }
    }

    for (let sourceIndex = 0; sourceIndex < sourceParts.length; sourceIndex += 1) {
      this.#decoder.add(urFromPart({
        ...metadata,
        seqNum: sourceIndex + 1,
        seqLen: metadata.seqLen,
        data: sourceParts[sourceIndex],
      }));
    }
    if (!this.#decoder.done) {
      throw new Error('Page erasure-code reconstruction did not complete its MUR payload.');
    }
  }
}
