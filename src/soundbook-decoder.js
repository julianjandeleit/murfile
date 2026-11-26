import { extractCbor } from '@blockchaincommons/dcbor';
import { UR } from '@blockchaincommons/uniform-resources';
import { decodeBytewords } from '@blockchaincommons/uniform-resources/bytewords';
import { decodeFountainPart } from '@blockchaincommons/uniform-resources/fountain';
import { parseSoundbookPageEnvelope } from './soundbook-transfer.js';
import { PageMultipartDecoder } from './page-fountain.js';

const MULTIPART_CANDIDATE = /^ur:[^/]+\/\+?[0-9]+-\+?[0-9]+\//;

function sessionKeyForUr(value) {
  const separator = value.lastIndexOf('/');
  if (separator === -1 || separator === value.length - 1) {
    throw new TypeError('Malformed multipart UR bytewords payload.');
  }
  const partBytes = decodeBytewords(value.slice(separator + 1), 'minimal');
  const part = decodeFountainPart(partBytes);
  const type = value.slice(3, value.indexOf('/')).toLowerCase();
  return `${type}:${part.seqLen}:${part.messageLen}:${part.checksum}:${part.data.byteLength}`;
}

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

function sameBookMetadata(a, b) {
  return a.bookId === b.bookId &&
    a.format === b.format &&
    a.pageCount === b.pageCount &&
    a.audioLength === b.audioLength &&
    (a.format === 'SOUNDBOOK-1' || a.format === 'SOUNDBOOK-3'
      ? a.chunkCapacity === b.chunkCapacity
      : a.segmentCapacity === b.segmentCapacity) &&
    a.durationMicros === b.durationMicros &&
    a.codec === b.codec &&
    a.audioSha256 === b.audioSha256;
}

function sameBytes(a, b) {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This environment does not provide Web Crypto for Soundbook integrity checks.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reconstructs one Soundbook audio book from independent page-coded sessions. */
export class SoundbookDecoder {
  #sessions = new Map();
  #completedSessions = new Set();
  #seen = new Set();
  #pages = new Map();
  #bookMetadata;
  #audioBytes;

  constructor() {
    this.reset();
  }

  reset() {
    this.#sessions = new Map();
    this.#completedSessions = new Set();
    this.#seen = new Set();
    this.#pages = new Map();
    this.#bookMetadata = undefined;
    this.#audioBytes = undefined;
    this.fragmentsReceived = 0;
    this.duplicatesIgnored = 0;
    this.redundantFragments = 0;
    this.invalidUris = 0;
  }

  get complete() {
    return this.#audioBytes !== undefined;
  }

  get result() {
    return this.#audioBytes === undefined ? undefined : new Uint8Array(this.#audioBytes);
  }

  get status() {
    const metadata = this.#bookMetadata;
    const missingPages = metadata
      ? Array.from({ length: metadata.pageCount }, (_, index) => index)
        .filter((index) => !this.#pages.has(index))
      : [];
    let contiguousPageCount = 0;
    while (this.#pages.has(contiguousPageCount)) contiguousPageCount += 1;
    return {
      format: metadata?.format ?? null,
      bookId: metadata?.bookId ?? null,
      pageCount: metadata?.pageCount ?? null,
      completedPages: this.#pages.size,
      contiguousPageCount,
      missingPages,
      availablePages: [...this.#pages.keys()].sort((a, b) => a - b),
      activeSessions: [...this.#sessions.entries()].map(([key, session]) => ({
        key,
        progress: session.decoder.progress,
        fragmentsReceived: session.fragmentsReceived,
      })),
      fragmentsReceived: this.fragmentsReceived,
      duplicatesIgnored: this.duplicatesIgnored,
      redundantFragments: this.redundantFragments,
      invalidUris: this.invalidUris,
      audioAvailable: metadata?.format === 'SOUNDBOOK-2' || metadata?.format === 'SOUNDBOOK-3'
        ? this.#pages.size > 0
        : this.complete,
      audioDurationMicros: metadata?.durationMicros ?? null,
      audioBytes: this.complete ? this.#audioBytes.byteLength : null,
      complete: this.complete,
    };
  }

  async #acceptPage(page) {
    if (page.format === 'SOUNDBOOK-2') return this.#acceptSegment(page);
    if (page.format === 'SOUNDBOOK-3') return this.#acceptChunk(page);
    return this.#acceptLegacyPage(page);
  }

  async #acceptChunk(page) {
    if (!this.#bookMetadata) {
      this.#bookMetadata = {
        format: page.format,
        bookId: page.bookId,
        pageCount: page.pageCount,
        audioLength: page.audioLength,
        chunkCapacity: page.chunkCapacity,
        durationMicros: page.durationMicros,
        codec: page.codec,
        audioSha256: page.audioSha256,
      };
    } else if (!sameBookMetadata(this.#bookMetadata, page)) {
      throw new Error('Page belongs to a different or inconsistent Soundbook.');
    }

    const existing = this.#pages.get(page.pageIndex);
    if (existing) {
      if (!sameBytes(existing, page.chunkBytes)) {
        throw new Error(`Conflicting data received for Soundbook page ${page.pageIndex + 1}.`);
      }
      this.duplicatesIgnored += 1;
      return { kind: 'duplicate-page', pageIndex: page.pageIndex, status: this.status };
    }

    if (await sha256Hex(page.chunkBytes) !== page.chunkSha256) {
      throw new Error(`Soundbook page ${page.pageIndex + 1} chunk SHA-256 integrity check failed.`);
    }

    if (this.#pages.size + 1 === page.pageCount) {
      const chunks = Array.from({ length: page.pageCount }, (_, index) =>
        index === page.pageIndex ? page.chunkBytes : this.#pages.get(index));
      if (chunks.some((chunk) => !chunk) ||
          chunks.reduce((total, chunk) => total + chunk.byteLength, 0) !== page.audioLength) {
        throw new Error('Soundbook chunks do not match the declared book length.');
      }
      const audio = new Uint8Array(page.audioLength);
      let offset = 0;
      for (const chunk of chunks) {
        audio.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (await sha256Hex(audio) !== page.audioSha256) {
        throw new Error('Soundbook audio SHA-256 integrity check failed; reset and scan the pages again.');
      }
      this.#pages.set(page.pageIndex, page.chunkBytes);
      this.#audioBytes = audio;
      return {
        kind: 'book-complete',
        audioBytes: this.result,
        chunkBytes: page.chunkBytes.slice(),
        playbackPageIndex: page.pageIndex,
        playbackPageCount: page.pageCount,
        pageIndex: page.pageIndex,
        status: this.status,
      };
    }

    this.#pages.set(page.pageIndex, page.chunkBytes);
    return {
      kind: 'page-complete',
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      chunkBytes: page.chunkBytes.slice(),
      playbackPageIndex: page.pageIndex,
      playbackPageCount: page.pageCount,
      status: this.status,
    };
  }

  async #acceptSegment(page) {
    if (!this.#bookMetadata) {
      this.#bookMetadata = {
        format: page.format,
        bookId: page.bookId,
        pageCount: page.pageCount,
        audioLength: page.audioLength,
        segmentCapacity: page.segmentCapacity,
        durationMicros: page.durationMicros,
        codec: page.codec,
        audioSha256: page.audioSha256,
      };
    } else if (!sameBookMetadata(this.#bookMetadata, page)) {
      throw new Error('Page belongs to a different or inconsistent Soundbook.');
    }

    const existing = this.#pages.get(page.pageIndex);
    if (existing) {
      if (!sameBytes(existing, page.segmentBytes)) {
        throw new Error(`Conflicting data received for Soundbook page ${page.pageIndex + 1}.`);
      }
      this.duplicatesIgnored += 1;
      return { kind: 'duplicate-page', pageIndex: page.pageIndex, status: this.status };
    }

    if (await sha256Hex(page.segmentBytes) !== page.segmentSha256) {
      throw new Error(`Soundbook page ${page.pageIndex + 1} segment SHA-256 integrity check failed.`);
    }

    if (this.#pages.size + 1 === page.pageCount) {
      const segments = Array.from({ length: page.pageCount }, (_, index) =>
        index === page.pageIndex ? page.segmentBytes : this.#pages.get(index));
      if (segments.some((segment) => !segment) ||
          segments.reduce((total, segment) => total + segment.byteLength, 0) !== page.audioLength) {
        throw new Error('Soundbook segments do not match the declared book length.');
      }
      const audio = new Uint8Array(page.audioLength);
      let offset = 0;
      for (const segment of segments) {
        audio.set(segment, offset);
        offset += segment.byteLength;
      }
      if (await sha256Hex(audio) !== page.audioSha256) {
        throw new Error('Soundbook audio SHA-256 integrity check failed; reset and scan the pages again.');
      }
      this.#pages.set(page.pageIndex, page.segmentBytes);
      this.#audioBytes = audio;
      return {
        kind: 'book-complete',
        audioBytes: this.result,
        segmentBytes: page.segmentBytes.slice(),
        playbackPageIndex: page.pageIndex,
        playbackPageCount: page.pageCount,
        pageIndex: page.pageIndex,
        status: this.status,
      };
    }

    this.#pages.set(page.pageIndex, page.segmentBytes);
    return {
      kind: 'page-complete',
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      segmentBytes: page.segmentBytes.slice(),
      playbackPageIndex: page.pageIndex,
      playbackPageCount: page.pageCount,
      status: this.status,
    };
  }

  async #acceptLegacyPage(page) {
    if (!this.#bookMetadata) {
      this.#bookMetadata = {
        format: page.format,
        bookId: page.bookId,
        pageCount: page.pageCount,
        audioLength: page.audioLength,
        chunkCapacity: page.chunkCapacity,
        durationMicros: page.durationMicros,
        codec: page.codec,
        audioSha256: page.audioSha256,
      };
    } else if (!sameBookMetadata(this.#bookMetadata, page)) {
      throw new Error('Page belongs to a different or inconsistent Soundbook.');
    }

    const existing = this.#pages.get(page.pageIndex);
    if (existing) {
      if (!sameBytes(existing, page.chunk)) {
        throw new Error(`Conflicting data received for Soundbook page ${page.pageIndex + 1}.`);
      }
      this.duplicatesIgnored += 1;
      return { kind: 'duplicate-page', pageIndex: page.pageIndex, status: this.status };
    }

    if (this.#pages.size + 1 === page.pageCount) {
      const audio = new Uint8Array(page.audioLength);
      for (let index = 0; index < page.pageCount; index += 1) {
        const chunk = index === page.pageIndex ? page.chunk : this.#pages.get(index);
        if (!chunk) throw new Error(`Soundbook page ${index + 1} is missing.`);
        audio.set(chunk, index * page.chunkCapacity);
      }
      if (await sha256Hex(audio) !== page.audioSha256) {
        throw new Error('Soundbook audio SHA-256 integrity check failed; reset and scan the pages again.');
      }
      this.#pages.set(page.pageIndex, page.chunk);
      this.#audioBytes = audio;
      return {
        kind: 'book-complete',
        audioBytes: this.result,
        segmentBytes: this.result,
        playbackPageIndex: 0,
        playbackPageCount: 1,
        pageIndex: page.pageIndex,
        status: this.status,
      };
    }

    this.#pages.set(page.pageIndex, page.chunk);
    return {
      kind: 'page-complete',
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      status: this.status,
    };
  }

  async add(fragment) {
    const normalized = String(fragment ?? '').trim().toLowerCase();
    if (!MULTIPART_CANDIDATE.test(normalized)) {
      this.invalidUris += 1;
      return {
        kind: 'invalid',
        message: 'Soundbook requires a multipart UR page fragment.',
        status: this.status,
      };
    }
    if (this.complete) return { kind: 'book-complete', audioBytes: this.result, status: this.status };
    if (this.#seen.has(normalized)) {
      this.duplicatesIgnored += 1;
      return { kind: 'duplicate', status: this.status };
    }

    try {
      const sessionKey = sessionKeyForUr(normalized);
      this.#seen.add(normalized);
      if (this.#completedSessions.has(sessionKey)) {
        this.duplicatesIgnored += 1;
        return { kind: 'redundant', status: this.status };
      }

      let session = this.#sessions.get(sessionKey);
      if (!session) {
        session = { decoder: new PageMultipartDecoder(), fragmentsReceived: 0 };
        this.#sessions.set(sessionKey, session);
      }
      const addedInformation = session.decoder.add(normalized);
      session.fragmentsReceived += 1;
      this.fragmentsReceived += 1;
      if (!addedInformation) this.redundantFragments += 1;

      if (!session.decoder.done) {
        return {
          kind: addedInformation ? 'fragment' : 'redundant',
          status: this.status,
        };
      }

      const ur = session.decoder.result;
      if (!ur) throw new Error('MUR decoder completed without returning a UR.');
      const page = parseSoundbookPageEnvelope(bytesFromUr(ur));
      if (!page) throw new Error('Completed MUR session is not a Soundbook page.');
      this.#sessions.delete(sessionKey);
      this.#completedSessions.add(sessionKey);
      return await this.#acceptPage(page);
    } catch (error) {
      this.invalidUris += 1;
      return {
        kind: 'invalid',
        message: error instanceof Error ? error.message : String(error),
        status: this.status,
      };
    }
  }
}
