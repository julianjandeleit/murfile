import { extractCbor } from '@blockchaincommons/dcbor';
import { UR } from '@blockchaincommons/uniform-resources';
import { decodeBytewords } from '@blockchaincommons/uniform-resources/bytewords';
import { decodeFountainPart } from '@blockchaincommons/uniform-resources/fountain';
import { parsePageEnvelope } from './page-transfer.js';
import { PageMultipartDecoder } from './page-fountain.js';

// BCR MUR parts have: ur:<type>/<seqNum>-<seqLen>/<bytewords>.
const MULTIPART_CANDIDATE = /^ur:[^/]+\/\+?[0-9]+-\+?[0-9]+\//;

function bytesFromUr(ur) {
  if (!ur.isType('bytes')) {
    throw new TypeError(`Unsupported UR type "${ur.type.name}"; expected "bytes".`);
  }
  const value = extractCbor(ur.cbor);
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('The CBOR payload of ur:bytes is not a CBOR byte string.');
  }
  return new Uint8Array(value);
}

function sessionKeyForUr(value) {
  const normalized = String(value).trim().toLowerCase();
  const separator = normalized.lastIndexOf('/');
  if (separator === -1 || separator === normalized.length - 1) {
    throw new TypeError('Malformed multipart UR bytewords payload.');
  }
  const partBytes = decodeBytewords(normalized.slice(separator + 1), 'minimal');
  const part = decodeFountainPart(partBytes);
  const type = normalized.slice(3, normalized.indexOf('/')).toLowerCase();
  return `${type}:${part.seqLen}:${part.messageLen}:${part.checksum}:${part.data.byteLength}`;
}

function samePageMetadata(a, b) {
  return a.pageCount === b.pageCount &&
    a.originalSize === b.originalSize &&
    a.chunkCapacity === b.chunkCapacity &&
    a.fileSha256 === b.fileSha256;
}

export function isMultipartUrCandidate(value) {
  return MULTIPART_CANDIDATE.test(String(value ?? '').trim().toLowerCase());
}

/**
 * Decoder for ordinary global MUR sessions and independent page-coded sessions.
 * Page-coded MDS symbols and legacy standard Fountain pages are both accepted.
 */
export class FileDecoder {
  #sessions = new Map();
  #completedSessions = new Set();
  #seen = new Set();
  #mode = 'waiting';
  #result;
  #pageMetadata;
  #pages = new Map();

  constructor() {
    this.reset();
  }

  reset() {
    this.#sessions = new Map();
    this.#completedSessions = new Set();
    this.#seen = new Set();
    this.#mode = 'waiting';
    this.#result = undefined;
    this.#pageMetadata = undefined;
    this.#pages = new Map();
    this.fragmentsReceived = 0;
    this.duplicatesIgnored = 0;
    this.redundantFragments = 0;
    this.invalidUris = 0;
  }

  get complete() {
    return this.#result !== undefined;
  }

  get result() {
    return this.#result === undefined ? undefined : new Uint8Array(this.#result);
  }

  get expectedSha256() {
    return this.#pageMetadata?.fileSha256;
  }

  get progress() {
    if (this.complete || this.#mode === 'single') return 1;
    const active = [...this.#sessions.values()].reduce((sum, session) => sum + session.decoder.progress, 0);
    if (this.#pageMetadata) {
      return Math.min(1, (this.#pages.size + active) / this.#pageMetadata.pageCount);
    }
    if (this.#sessions.size > 0) return active / this.#sessions.size;
    return 0;
  }

  get status() {
    const pageCount = this.#pageMetadata?.pageCount ?? null;
    const completedPages = this.#pages.size;
    const missingPages = pageCount === null
      ? []
      : Array.from({ length: pageCount }, (_, index) => index).filter((index) => !this.#pages.has(index));
    return {
      mode: this.#mode,
      complete: this.complete,
      progress: this.progress,
      fragmentsReceived: this.fragmentsReceived,
      duplicatesIgnored: this.duplicatesIgnored,
      redundantFragments: this.redundantFragments,
      invalidUris: this.invalidUris,
      completedPages,
      pageCount,
      missingPages,
      activeSessions: this.#sessions.size,
      expectedSha256: this.expectedSha256 ?? null,
    };
  }

  #acceptPage(page, sessionKey) {
    if (this.#mode === 'single') {
      throw new Error('Cannot mix page-scoped MUR sessions with a single-part UR.');
    }
    if (!this.#pageMetadata) {
      this.#pageMetadata = {
        pageCount: page.pageCount,
        originalSize: page.originalSize,
        chunkCapacity: page.chunkCapacity,
        fileSha256: page.fileSha256,
      };
    } else if (!samePageMetadata(this.#pageMetadata, page)) {
      throw new Error('Page belongs to a different file-transfer session.');
    }

    const existing = this.#pages.get(page.pageIndex);
    if (existing) {
      if (existing.byteLength !== page.chunk.byteLength ||
          existing.some((byte, index) => byte !== page.chunk[index])) {
        throw new Error(`Conflicting data received for page ${page.pageIndex + 1}.`);
      }
      return { kind: 'duplicate-page', pageIndex: page.pageIndex, pageCount: page.pageCount, status: this.status };
    }

    this.#pages.set(page.pageIndex, page.chunk);
    this.#mode = 'pages';

    if (this.#pages.size === this.#pageMetadata.pageCount) {
      const { pageCount, originalSize, chunkCapacity } = this.#pageMetadata;
      const expectedPageCount = Math.max(1, Math.ceil(originalSize / chunkCapacity));
      if (pageCount !== expectedPageCount) {
        throw new Error('Page count does not match the original file size.');
      }
      const output = new Uint8Array(originalSize);
      for (let index = 0; index < pageCount; index += 1) {
        const chunk = this.#pages.get(index);
        const expectedLength = index === pageCount - 1
          ? originalSize - index * chunkCapacity
          : chunkCapacity;
        if (!chunk || chunk.byteLength !== expectedLength) {
          throw new Error(`Page ${index + 1} is missing or has an invalid chunk length.`);
        }
        output.set(chunk, index * chunkCapacity);
      }
      this.#result = output;
      this.#mode = 'pages';
      return {
        kind: 'complete',
        bytes: this.result,
        pageIndex: page.pageIndex,
        pageCount,
        status: this.status,
      };
    }

    return {
      kind: 'page-complete',
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      status: this.status,
    };
  }

  add(fragment) {
    const normalized = String(fragment ?? '').trim().toLowerCase();
    if (!normalized.startsWith('ur:')) return { kind: 'ignored', status: this.status };
    if (this.complete) return { kind: 'complete', bytes: this.result, status: this.status };

    if (this.#seen.has(normalized)) {
      this.duplicatesIgnored += 1;
      return { kind: 'duplicate', status: this.status };
    }

    try {
      if (isMultipartUrCandidate(normalized)) {
        if (this.#mode === 'single') {
          throw new Error('Cannot mix single-part and multipart URs in one decoder session.');
        }

        const sessionKey = sessionKeyForUr(normalized);
        this.#seen.add(normalized);
        if (this.#completedSessions.has(sessionKey)) {
          this.duplicatesIgnored += 1;
          return { kind: 'redundant', status: this.status };
        }

        let session = this.#sessions.get(sessionKey);
        if (!session) {
          session = { decoder: new PageMultipartDecoder() };
          this.#sessions.set(sessionKey, session);
        }
        const addedInformation = session.decoder.add(normalized);
        this.fragmentsReceived += 1;
        if (!addedInformation) this.redundantFragments += 1;

        if (session.decoder.done) {
          const ur = session.decoder.result;
          if (!ur) throw new Error('MUR decoder completed without returning a UR.');
          const page = parsePageEnvelope(bytesFromUr(ur));
          this.#sessions.delete(sessionKey);
          this.#completedSessions.add(sessionKey);
          if (page) return this.#acceptPage(page, sessionKey);

          if (this.#pageMetadata || this.#sessions.size > 0) {
            throw new Error('A completed MUR session did not contain a valid page-transfer envelope.');
          }
          this.#mode = 'multipart';
          this.#result = bytesFromUr(ur);
          return { kind: 'complete', bytes: this.result, status: this.status };
        }

        return {
          kind: addedInformation ? 'fragment' : 'redundant',
          status: this.status,
        };
      }

      if (this.#mode === 'multipart' || this.#mode === 'pages' || this.#sessions.size > 0) {
        throw new Error('Cannot mix single-part URs with multipart sessions.');
      }

      const ur = UR.parse(normalized);
      const bytes = bytesFromUr(ur);
      this.#seen.add(normalized);
      this.#mode = 'single';
      this.fragmentsReceived = 1;
      this.#result = bytes;
      return { kind: 'complete', bytes: this.result, status: this.status };
    } catch (error) {
      this.invalidUris += 1;
      return {
        kind: 'invalid',
        message: error instanceof Error ? error.message : String(error),
        status: this.status,
      };
    }
  }

  addMany(fragments) {
    const results = [];
    for (const fragment of fragments) {
      results.push(this.add(fragment));
      if (this.complete) break;
    }
    return results;
  }
}
