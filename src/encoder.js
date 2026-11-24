import { cbor } from '@blockchaincommons/dcbor';
import { MultipartEncoder, UR } from '@blockchaincommons/uniform-resources';

/** Create the standard UR representation used by this project: a CBOR byte string. */
export function createBytesUr(data) {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError('data must be a Uint8Array or Buffer');
  }
  return UR.from('bytes', cbor(new Uint8Array(data)));
}

/**
 * File-oriented facade around Blockchain Commons' MultipartEncoder.
 * The underlying fountain encoder is intentionally infinite; this wrapper
 * exposes a finite `take()` operation for exports such as printed books.
 */
export class FileEncoder {
  #encoder;
  #iterator;
  #singleFragment;
  #singleEmitted = false;
  #index = 0;

  constructor(data, { maxFragmentLength = 100 } = {}) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError('data must be a Uint8Array or Buffer');
    }
    if (!Number.isSafeInteger(maxFragmentLength) || maxFragmentLength < 1) {
      throw new RangeError('maxFragmentLength must be a positive safe integer');
    }

    this.ur = createBytesUr(data);
    this.maxFragmentLength = maxFragmentLength;

    // A one-fragment payload should be sent as an ordinary single-part UR.
    // MUR is used only when the CBOR payload exceeds the selected fragment size.
    if (this.ur.cbor.toData().byteLength <= maxFragmentLength) {
      this.#singleFragment = this.ur.toString();
      this.sourcePartCount = 1;
      this.isSinglePart = true;
      return;
    }

    this.#encoder = new MultipartEncoder(this.ur, maxFragmentLength);
    this.#iterator = this.#encoder[Symbol.iterator]();
    this.sourcePartCount = this.#encoder.partCount;
    this.isSinglePart = false;
  }

  /** Number of source fragments before fountain repair fragments are added. */
  /** Number of fragments emitted by this wrapper so far. */
  get emittedCount() {
    return this.#index;
  }

  /** Return the next complete MUR string. */
  nextFragment() {
    if (this.isSinglePart) {
      if (this.#singleEmitted) return undefined;
      this.#singleEmitted = true;
      this.#index += 1;
      return this.#singleFragment;
    }

    const next = this.#iterator.next();
    if (next.done) return undefined;
    this.#index += 1;
    return next.value;
  }

  /** Return exactly `count` consecutive fountain fragments. */
  take(count) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError('count must be a positive safe integer');
    }
    const fragments = [];
    for (let index = 0; index < count; index += 1) {
      const fragment = this.nextFragment();
      if (fragment === undefined) break;
      fragments.push(fragment);
    }
    return fragments;
  }

  *[Symbol.iterator]() {
    while (true) {
      const fragment = this.nextFragment();
      if (fragment === undefined) return;
      yield fragment;
    }
  }
}
