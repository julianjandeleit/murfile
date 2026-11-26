import { FileEncoder } from './encoder.js';
import {
  chooseMaxFragmentLength,
  composeGridPage,
  qrModulesForFragment,
  renderQrFragment,
} from './qr-grid.js';
import {
  createSoundbookPageEnvelope,
  MAX_SOUNDBOOK_PAGES,
  SOUNDBOOK_HEADER_LENGTH,
} from './soundbook-transfer.js';

function cborByteStringHeaderLength(length) {
  if (length < 24) return 1;
  if (length <= 0xff) return 2;
  if (length <= 0xffff) return 3;
  if (length <= 0xffffffff) return 5;
  return 9;
}

function calculateChunkCapacity(maxFragmentLength, dataFramesPerPage) {
  const targetLength = maxFragmentLength * dataFramesPerPage;
  if (!Number.isSafeInteger(targetLength)) throw new Error('Soundbook page capacity is too large.');
  let chunkCapacity = targetLength - SOUNDBOOK_HEADER_LENGTH - 9;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const envelopeLength = SOUNDBOOK_HEADER_LENGTH + chunkCapacity;
    const next = targetLength - SOUNDBOOK_HEADER_LENGTH - cborByteStringHeaderLength(envelopeLength);
    if (next === chunkCapacity) break;
    chunkCapacity = next;
  }
  const envelopeLength = SOUNDBOOK_HEADER_LENGTH + chunkCapacity;
  if (chunkCapacity < 1 ||
      envelopeLength + cborByteStringHeaderLength(envelopeLength) !== targetLength) {
    throw new Error('Could not calculate a valid Soundbook page payload size.');
  }
  return chunkCapacity;
}

function repairFrameCount(framesPerPage, profile) {
  if (profile === 'minimal') return 1;
  if (profile === 'low') return Math.max(1, Math.ceil(framesPerPage / 4));
  if (profile === 'default') return Math.max(1, Math.round(framesPerPage / 3));
  throw new Error('Fountain redundancy must be minimal, low or default.');
}

/** Calculate the fixed transport settings for a complete compressed recording. */
export function createSoundbookPagePlan(audioBytes, {
  bookId,
  audioSha256,
  durationMicros,
  columns = 4,
  rows = 4,
  size = 512,
  correction = 'low',
  qrVersion = 20,
  gap = 24,
  padding = 48,
  redundancy = 'minimal',
} = {}) {
  if (!(audioBytes instanceof Uint8Array) || audioBytes.byteLength === 0) {
    throw new TypeError('audioBytes must be a non-empty Uint8Array.');
  }
  if (!Number.isSafeInteger(columns) || columns < 1 ||
      !Number.isSafeInteger(rows) || rows < 1 ||
      !Number.isSafeInteger(size) || size < 1 ||
      !Number.isSafeInteger(qrVersion) || qrVersion < 1 || qrVersion > 40 ||
      !Number.isSafeInteger(gap) || gap < 0 ||
      !Number.isSafeInteger(padding) || padding < 0 ||
      !Number.isSafeInteger(durationMicros) || durationMicros < 1) {
    throw new RangeError('Invalid Soundbook grid, QR, size, or duration settings.');
  }

  const framesPerPage = columns * rows;
  const repairFramesPerPage = repairFrameCount(framesPerPage, redundancy);
  const dataFramesPerPage = framesPerPage - repairFramesPerPage;
  if (dataFramesPerPage < 2) {
    throw new Error('The Soundbook grid must leave at least two data frames per page.');
  }

  const maxFragmentLength = chooseMaxFragmentLength(
    new Uint8Array(4096),
    correction,
    qrVersion,
    framesPerPage,
    dataFramesPerPage,
  );
  const chunkCapacity = calculateChunkCapacity(maxFragmentLength, dataFramesPerPage);
  const pageCount = Math.max(1, Math.ceil(audioBytes.byteLength / chunkCapacity));
  if (pageCount > MAX_SOUNDBOOK_PAGES) {
    throw new Error(`Soundbook page count exceeds the limit of ${MAX_SOUNDBOOK_PAGES}.`);
  }

  return {
    bookId,
    audioSha256,
    audioLength: audioBytes.byteLength,
    durationMicros,
    columns,
    rows,
    size,
    correction,
    qrVersion,
    gap,
    padding,
    redundancy,
    framesPerPage,
    repairFramesPerPage,
    dataFramesPerPage,
    maxFragmentLength,
    chunkCapacity,
    pageCount,
    manifest: {
      format: 'SOUNDBOOK-1',
      bookId,
      codec: 'ogg-opus',
      audioLength: audioBytes.byteLength,
      audioSha256,
      durationMicros,
      pageCount,
      frameCount: pageCount * framesPerPage,
      sourcePartCount: pageCount * dataFramesPerPage,
      maxFragmentLength,
      pagePayloadBytes: chunkCapacity,
      qr: { version: qrVersion, correction, size },
      grid: {
        columns,
        rows,
        framesPerPage,
        dataFramesPerPage,
        repairFramesPerPage,
        redundancy,
        gap,
        padding,
        ordering: 'row-major',
      },
      generatedBy: 'soundbook/0.1.0',
    },
  };
}

/** Render and fountain-encode exactly one grid page from a complete recording. */
export function encodeSoundbookPage(audioBytes, plan, pageIndex) {
  if (!(audioBytes instanceof Uint8Array) || audioBytes.byteLength !== plan.audioLength) {
    throw new TypeError('audioBytes do not match the Soundbook page plan.');
  }
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= plan.pageCount) {
    throw new RangeError('Soundbook page index is outside the page plan.');
  }

  const offset = pageIndex * plan.chunkCapacity;
  const chunkLength = Math.min(plan.chunkCapacity, audioBytes.byteLength - offset);
  const chunk = new Uint8Array(plan.chunkCapacity);
  chunk.set(audioBytes.subarray(offset, offset + chunkLength));
  const envelope = createSoundbookPageEnvelope({
    bookId: plan.bookId,
    pageIndex,
    pageCount: plan.pageCount,
    audioLength: plan.audioLength,
    chunkLength,
    chunkCapacity: plan.chunkCapacity,
    durationMicros: plan.durationMicros,
    audioSha256: plan.audioSha256,
    chunk,
  });
  const encoder = new FileEncoder(envelope, { maxFragmentLength: plan.maxFragmentLength });
  if (encoder.isSinglePart || encoder.sourcePartCount !== plan.dataFramesPerPage) {
    throw new Error(
      `Soundbook page sizing error: expected ${plan.dataFramesPerPage} source fragments, ` +
      `got ${encoder.sourcePartCount}.`,
    );
  }

  const fragments = encoder.take(plan.framesPerPage);
  if (fragments.length !== plan.framesPerPage) {
    throw new Error(`Soundbook page ${pageIndex + 1} did not produce ${plan.framesPerPage} fragments.`);
  }
  const images = fragments.map((fragment) => {
    const modules = qrModulesForFragment(fragment, plan.correction, plan.qrVersion);
    if (modules !== 17 + 4 * plan.qrVersion) {
      throw new Error(`Soundbook fragment does not fit QR version ${plan.qrVersion}.`);
    }
    return renderQrFragment(fragment, {
      size: plan.size,
      correction: plan.correction,
      version: plan.qrVersion,
    });
  });
  const gridImage = composeGridPage(images, {
    size: plan.size,
    columns: plan.columns,
    rows: plan.rows,
    gap: plan.gap,
    padding: plan.padding,
  });
  return { pageIndex, fragments, png: gridImage.toPng() };
}

/** Convenience API for callers that want all rendered page data in memory. */
export function encodeSoundbookPages(audioBytes, options) {
  const plan = createSoundbookPagePlan(audioBytes, options);
  const pages = Array.from({ length: plan.pageCount }, (_, index) =>
    encodeSoundbookPage(audioBytes, plan, index));
  return { pages, manifest: plan.manifest };
}

