import { FileEncoder } from './encoder.js';
import {
  chooseSymbolSize,
  composeGridPage,
  qrModulesForFragment,
  renderQrFragment,
} from './qr-grid.js';
import {
  createSoundbookChunkEnvelope,
  MAX_SOUNDBOOK_PAGES,
  SOUNDBOOK_CHUNK_HEADER_LENGTH,
} from './soundbook-transfer.js';

function repairSymbolCount(framesPerPage, profile, requestedRepairSymbols) {
  if (requestedRepairSymbols !== undefined) {
    if (!Number.isSafeInteger(requestedRepairSymbols) ||
        requestedRepairSymbols < 1 || requestedRepairSymbols >= framesPerPage) {
      throw new RangeError('repairSymbols must be less than the number of grid cells.');
    }
    return requestedRepairSymbols;
  }
  if (profile === 'minimal') return 1;
  if (profile === 'low') return Math.max(1, Math.ceil(framesPerPage / 4));
  if (profile === 'default') return Math.max(1, Math.round(framesPerPage * 2 / 16));
  throw new Error('RaptorQ redundancy must be minimal, low or default.');
}

/** Calculate transport settings for exact, contiguous chunks of an Ogg Opus source. */
export function createSoundbookPagePlan(audioBytes, {
  bookId,
  audioSha256,
  durationMicros,
  columns = 4,
  rows = 4,
  size = 512,
  correction = 'low',
  qrVersion = 21,
  gap = 24,
  padding = 48,
  redundancy = 'default',
  repairSymbols: requestedRepairSymbols,
  chunkHashes,
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
  if (!Number.isSafeInteger(framesPerPage) || framesPerPage > 255) {
    throw new RangeError('Soundbook grids support at most 255 QR cells.');
  }
  const repairFramesPerPage = repairSymbolCount(framesPerPage, redundancy, requestedRepairSymbols);
  const dataFramesPerPage = framesPerPage - repairFramesPerPage;
  if (dataFramesPerPage < 2) {
    throw new Error('The Soundbook grid must leave at least two data frames per page.');
  }

  const symbolSize = chooseSymbolSize(correction, qrVersion);
  const blockCapacity = dataFramesPerPage * symbolSize;
  const chunkCapacity = blockCapacity - SOUNDBOOK_CHUNK_HEADER_LENGTH;
  if (chunkCapacity < 1) throw new Error('QR capacity is too small for the Soundbook page envelope.');
  const pageCount = Math.max(1, Math.ceil(audioBytes.byteLength / chunkCapacity));
  if (pageCount > MAX_SOUNDBOOK_PAGES) {
    throw new Error(`Soundbook page count exceeds the limit of ${MAX_SOUNDBOOK_PAGES}.`);
  }
  if (chunkHashes !== undefined &&
      (!Array.isArray(chunkHashes) || chunkHashes.length !== pageCount ||
        chunkHashes.some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)))) {
    throw new TypeError('Each Soundbook byte chunk must have a SHA-256 hash.');
  }

  return {
    bookId,
    audioSha256,
    audioLength: audioBytes.byteLength,
    durationMicros,
    chunkHashes,
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
    symbolSize,
    chunkCapacity,
    pageCount,
    manifest: {
      format: 'SOUNDBOOK-4',
      transport: 'MQR1',
      bookId,
      codec: 'ogg-opus',
      audioLength: audioBytes.byteLength,
      audioSha256,
      durationMicros,
      pageCount,
      frameCount: pageCount * framesPerPage,
      sourceSymbolCount: pageCount * dataFramesPerPage,
      symbolSize,
      pagePayloadBytes: chunkCapacity,
      byteExact: true,
      qr: { version: qrVersion, correction, size },
      grid: {
        columns,
        rows,
        framesPerPage,
        sourceSymbols: dataFramesPerPage,
        repairSymbols: repairFramesPerPage,
        pageCode: 'raptorq-rfc6330',
        recoveryModel: 'probabilistic',
        gap,
        padding,
        ordering: 'row-major',
      },
      generatedBy: 'soundbook/0.1.0',
    },
  };
}

/** Render and RaptorQ-encode one contiguous byte chunk from the original audio. */
export function encodeSoundbookPage(audioBytes, plan, pageIndex) {
  if (!(audioBytes instanceof Uint8Array) || audioBytes.byteLength !== plan.audioLength) {
    throw new TypeError('audioBytes do not match the Soundbook page plan.');
  }
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= plan.pageCount) {
    throw new RangeError('Soundbook page index is outside the page plan.');
  }

  if (!plan.chunkHashes) {
    throw new Error('Soundbook pages require per-chunk SHA-256 hashes.');
  }
  const offset = pageIndex * plan.chunkCapacity;
  const chunkLength = Math.min(plan.chunkCapacity, plan.audioLength - offset);
  const chunk = new Uint8Array(plan.chunkCapacity);
  chunk.set(audioBytes.subarray(offset, offset + chunkLength));
  const envelope = createSoundbookChunkEnvelope({
    bookId: plan.bookId,
    pageIndex,
    pageCount: plan.pageCount,
    audioLength: plan.audioLength,
    chunkLength,
    chunkCapacity: plan.chunkCapacity,
    durationMicros: plan.durationMicros,
    audioSha256: plan.audioSha256,
    chunkSha256: plan.chunkHashes[pageIndex],
    chunk,
  });
  const pageEncoder = new FileEncoder(envelope, {
    symbolSize: plan.symbolSize,
    sourceSymbols: plan.dataFramesPerPage,
    repairSymbols: plan.repairFramesPerPage,
  });
  if (pageEncoder.pageCount !== 1) throw new Error('Soundbook chunk exceeded its RaptorQ page capacity.');
  const fragments = pageEncoder.take(plan.framesPerPage);
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

