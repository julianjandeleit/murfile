import { FileDecoder, isMqrCandidate } from './decoder.js';
import { mqrTransferId } from './mqr-protocol.js';
import { parseSoundbookPageEnvelope } from './soundbook-transfer.js';

function sameBookMetadata(a, b) {
  return a.bookId === b.bookId &&
    a.format === b.format &&
    a.pageCount === b.pageCount &&
    a.audioLength === b.audioLength &&
    a.chunkCapacity === b.chunkCapacity &&
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

/** Reconstructs an Ogg Opus book from independent RaptorQ-coded MQR1 pages. */
export class SoundbookDecoder {
  #sessions = new Map();
  #completedTransfers = new Set();
  #seenFrames = new Set();
  #pages = new Map();
  #bookMetadata;
  #audioBytes;

  constructor() {
    this.reset();
  }

  reset() {
    for (const session of this.#sessions.values()) session.decoder.reset();
    this.#sessions.clear();
    this.#completedTransfers.clear();
    this.#seenFrames.clear();
    this.#pages.clear();
    this.#bookMetadata = undefined;
    this.#audioBytes = undefined;
    this.fragmentsReceived = 0;
    this.duplicatesIgnored = 0;
    this.redundantFragments = 0;
    this.invalidFrames = 0;
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
    const activeSessions = [...this.#sessions.entries()].map(([key, session]) => ({
      key,
      progress: session.decoder.progress,
      fragmentsReceived: session.decoder.status.fragmentsReceived,
    }));
    return {
      format: metadata?.format ?? null,
      bookId: metadata?.bookId ?? null,
      pageCount: metadata?.pageCount ?? null,
      completedPages: this.#pages.size,
      contiguousPageCount,
      missingPages,
      availablePages: [...this.#pages.keys()].sort((a, b) => a - b),
      activeSessions,
      fragmentsReceived: this.fragmentsReceived,
      duplicatesIgnored: this.duplicatesIgnored,
      redundantFragments: this.redundantFragments,
      invalidFrames: this.invalidFrames,
      audioAvailable: (metadata?.format === 'SOUNDBOOK-3' || metadata?.format === 'SOUNDBOOK-4') &&
        this.#pages.size > 0,
      audioDurationMicros: metadata?.durationMicros ?? null,
      audioBytes: this.complete ? this.#audioBytes.byteLength : null,
      complete: this.complete,
    };
  }

  async #acceptChunk(page) {
    if (page.format !== 'SOUNDBOOK-3' && page.format !== 'SOUNDBOOK-4') {
      throw new Error('MQR frame payload is not a supported Soundbook byte chunk.');
    }
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

  async add(fragment) {
    const text = String(fragment ?? '').replace(/\r?\n$/, '');
    if (!isMqrCandidate(text)) {
      this.invalidFrames += 1;
      return { kind: 'invalid', message: 'Soundbook requires an MQR1 frame.', status: this.status };
    }
    if (this.complete) return { kind: 'book-complete', audioBytes: this.result, status: this.status };

    try {
      const transferId = mqrTransferId(text);
      if (this.#seenFrames.has(text)) {
        this.duplicatesIgnored += 1;
        return { kind: 'duplicate', status: this.status };
      }
      this.#seenFrames.add(text);
      if (this.#completedTransfers.has(transferId)) {
        this.redundantFragments += 1;
        return { kind: 'redundant', status: this.status };
      }

      let session = this.#sessions.get(transferId);
      if (!session) {
        session = { decoder: new FileDecoder() };
        this.#sessions.set(transferId, session);
      }
      const result = session.decoder.add(text);
      if (result.kind === 'invalid') {
        this.invalidFrames += 1;
        return { kind: 'invalid', message: result.message, status: this.status };
      }
      if (result.kind === 'duplicate' || result.kind === 'redundant') {
        this.redundantFragments += 1;
        return { kind: 'redundant', status: this.status };
      }
      this.fragmentsReceived += 1;
      if (!session.decoder.complete) return { kind: 'fragment', status: this.status };

      const payload = session.decoder.result;
      session.decoder.reset();
      this.#sessions.delete(transferId);
      this.#completedTransfers.add(transferId);
      const page = parseSoundbookPageEnvelope(payload);
      if (!page) throw new Error('Completed MQR block is not a Soundbook byte chunk.');
      return await this.#acceptChunk(page);
    } catch (error) {
      this.invalidFrames += 1;
      return {
        kind: 'invalid',
        message: error instanceof Error ? error.message : String(error),
        status: this.status,
      };
    }
  }
}
