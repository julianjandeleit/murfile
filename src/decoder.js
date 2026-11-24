import { extractCbor } from '@blockchaincommons/dcbor';
import { MultipartDecoder, UR } from '@blockchaincommons/uniform-resources';

// BCR MUR parts have: ur:<type>/<seqNum>-<seqLen>/<bytewords>.
// The official decoder performs the authoritative validation of both u16 fields.
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

export function isMultipartUrCandidate(value) {
  return MULTIPART_CANDIDATE.test(String(value ?? '').trim().toLowerCase());
}

/**
 * Stateful file decoder. Feed it complete UR strings from any transport
 * (camera, text file, serial port, network, etc.). All protocol work is done
 * by Blockchain Commons' MultipartDecoder / UR parser.
 */
export class FileDecoder {
  #decoder;
  #seen = new Set();
  #mode = 'waiting';
  #result = undefined;

  constructor() {
    this.reset();
  }

  reset() {
    this.#decoder = new MultipartDecoder();
    this.#seen = new Set();
    this.#mode = 'waiting';
    this.#result = undefined;
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

  /** True decoder progress supplied by the official fountain decoder, 0..1. */
  get progress() {
    if (this.#mode === 'single') return 1;
    if (this.#mode === 'multipart') return this.#decoder.progress;
    return 0;
  }

  get status() {
    return {
      mode: this.#mode,
      complete: this.complete,
      progress: this.progress,
      fragmentsReceived: this.fragmentsReceived,
      duplicatesIgnored: this.duplicatesIgnored,
      redundantFragments: this.redundantFragments,
      invalidUris: this.invalidUris,
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

        const addedInformation = this.#decoder.add(normalized);
        this.#seen.add(normalized);
        this.#mode = 'multipart';
        this.fragmentsReceived += 1;

        if (!addedInformation) {
          this.redundantFragments += 1;
        }

        if (this.#decoder.done) {
          const ur = this.#decoder.result;
          if (!ur) throw new Error('MUR decoder completed without returning a UR.');
          this.#result = bytesFromUr(ur);
          return { kind: 'complete', bytes: this.result, status: this.status };
        }

        return {
          kind: addedInformation ? 'fragment' : 'redundant',
          status: this.status,
        };
      }

      if (this.#mode === 'multipart') {
        throw new Error('Cannot mix single-part and multipart URs in one decoder session.');
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
