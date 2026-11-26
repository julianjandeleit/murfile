import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FileEncoder } from '../src/encoder.js';
import { parseMqrFrame } from '../src/index.js';
import { createSoundbookPagePlan, encodeSoundbookPage } from '../src/soundbook-encoder.js';
import { SoundbookDecoder as PublicSoundbookDecoder } from 'murfile/soundbook';
import { SoundbookDecoder } from '../src/soundbook-decoder.js';
import {
  MAX_SOUNDBOOK_PAGES,
  createSoundbookChunkEnvelope,
  createSoundbookPageEnvelope,
  createSoundbookSegmentEnvelope,
  parseSoundbookPageEnvelope,
} from '../src/soundbook-transfer.js';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makePage({ audio, pageIndex, pageCount, chunkCapacity, bookId, audioSha256 }) {
  const offset = pageIndex * chunkCapacity;
  const chunkLength = Math.min(chunkCapacity, audio.byteLength - offset);
  const chunk = new Uint8Array(chunkCapacity);
  chunk.set(audio.subarray(offset, offset + chunkLength));
  return createSoundbookPageEnvelope({
    bookId,
    pageIndex,
    pageCount,
    audioLength: audio.byteLength,
    chunkLength,
    chunkCapacity,
    durationMicros: 3_000_000,
    audioSha256,
    chunk,
  });
}

function makeChunkPage({ audio, pageIndex, pageCount, chunkCapacity, bookId, audioSha256 }) {
  const offset = pageIndex * chunkCapacity;
  const chunkLength = Math.min(chunkCapacity, audio.byteLength - offset);
  const chunk = new Uint8Array(chunkCapacity);
  chunk.set(audio.subarray(offset, offset + chunkLength));
  return createSoundbookChunkEnvelope({
    bookId,
    pageIndex,
    pageCount,
    audioLength: audio.byteLength,
    chunkLength,
    chunkCapacity,
    durationMicros: 3_000_000,
    audioSha256,
    chunkSha256: hash(chunk.subarray(0, chunkLength)),
    chunk,
  });
}

function makePageEncoder(envelope, repairSymbols = 2) {
  const symbolSize = 64;
  assert.equal(envelope.byteLength % symbolSize, 0);
  return new FileEncoder(envelope, {
    symbolSize,
    sourceSymbols: envelope.byteLength / symbolSize,
    repairSymbols,
  });
}

test('Soundbook page envelope validates metadata and strips fixed-size padding', () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5]);
  const envelope = makePage({
    audio,
    pageIndex: 1,
    pageCount: 2,
    chunkCapacity: 3,
    bookId: '0123456789abcdef0123456789abcdef',
    audioSha256: hash(audio),
  });
  const parsed = parseSoundbookPageEnvelope(envelope);
  assert.equal(parsed.pageIndex, 1);
  assert.equal(parsed.codec, 'ogg-opus');
  assert.deepEqual(parsed.chunk, new Uint8Array([4, 5]));
  envelope[envelope.length - 1] = 9;
  assert.throws(() => parseSoundbookPageEnvelope(envelope), /padding is not zero-filled/);
  assert.equal(new PublicSoundbookDecoder().complete, false);
  assert.throws(() => createSoundbookPageEnvelope({
    bookId: '0123456789abcdef0123456789abcdef',
    pageIndex: 0,
    pageCount: MAX_SOUNDBOOK_PAGES + 1,
    audioLength: MAX_SOUNDBOOK_PAGES + 1,
    chunkLength: 1,
    chunkCapacity: 1,
    durationMicros: 1,
    audioSha256: hash(new Uint8Array([0])),
    chunk: new Uint8Array([0]),
  }), /Invalid Soundbook page index or count/);
});

test('Soundbook segment envelope validates its own hash metadata and payload padding', () => {
  const segment = new Uint8Array([79, 103, 103, 83, 1, 2]);
  const paddedSegment = new Uint8Array(8);
  paddedSegment.set(segment);
  const audio = new Uint8Array([1, 2, 3]);
  const envelope = createSoundbookSegmentEnvelope({
    bookId: '0123456789abcdef0123456789abcdef',
    pageIndex: 0,
    pageCount: 2,
    audioLength: 11,
    segmentLength: segment.byteLength,
    segmentCapacity: paddedSegment.byteLength,
    durationMicros: 3_000_000,
    audioSha256: hash(new Uint8Array(11)),
    segmentSha256: hash(segment),
    segment: paddedSegment,
  });
  const parsed = parseSoundbookPageEnvelope(envelope);
  assert.equal(parsed.format, 'SOUNDBOOK-2');
  assert.deepEqual(parsed.segmentBytes, segment);
  envelope[envelope.length - 1] = 9;
  assert.throws(() => parseSoundbookPageEnvelope(envelope), /padding is not zero-filled/);
});

test('Soundbook byte-chunk envelope validates per-chunk hashes and strips padding', () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5]);
  const envelope = createSoundbookChunkEnvelope({
    bookId: '0123456789abcdef0123456789abcdef',
    pageIndex: 1,
    pageCount: 2,
    audioLength: audio.byteLength,
    chunkLength: 2,
    chunkCapacity: 3,
    durationMicros: 3_000_000,
    audioSha256: hash(audio),
    chunkSha256: hash(new Uint8Array([4, 5])),
    chunk: new Uint8Array([4, 5, 0]),
  });
  const parsed = parseSoundbookPageEnvelope(envelope);
  assert.equal(parsed.format, 'SOUNDBOOK-4');
  assert.equal(parsed.codec, 'ogg-opus');
  assert.deepEqual(parsed.chunkBytes, new Uint8Array([4, 5]));
  envelope[envelope.length - 1] = 9;
  assert.throws(() => parseSoundbookPageEnvelope(envelope), /padding is not zero-filled/);
});

test('Soundbook decoder accepts interleaved independent pages and verifies the complete book', async () => {
  const audio = new Uint8Array(randomBytes(750));
  const chunkCapacity = 391;
  const pageCount = Math.ceil(audio.byteLength / chunkCapacity);
  const bookId = randomBytes(16).toString('hex');
  const audioSha256 = hash(audio);
  const pageStreams = Array.from({ length: pageCount }, (_, pageIndex) => {
    const envelope = makeChunkPage({
      audio,
      pageIndex,
      pageCount,
      chunkCapacity,
      bookId,
      audioSha256,
    });
    const encoder = makePageEncoder(envelope);
    return encoder.take(encoder.frameCount);
  });

  const decoder = new SoundbookDecoder();
  let observedPartialBook = false;
  for (let frameIndex = 0; frameIndex < pageStreams[0].length; frameIndex += 1) {
    for (let pageIndex = 0; pageIndex < pageStreams.length; pageIndex += 1) {
      const result = await decoder.add(pageStreams[pageIndex][frameIndex]);
      if (!observedPartialBook && decoder.status.completedPages === 1) {
        assert.equal(result.kind, 'page-complete');
        assert.equal(decoder.status.missingPages.length, 1);
        assert.equal(decoder.status.audioAvailable, true);
        observedPartialBook = true;
      }
      if (decoder.complete) break;
    }
    if (decoder.complete) break;
  }

  assert.equal(observedPartialBook, true);
  assert.equal(decoder.complete, true);
  assert.deepEqual(decoder.result, audio);
  assert.equal(decoder.status.completedPages, 2);
  assert.equal(decoder.status.pageCount, 2);
  assert.deepEqual(decoder.status.missingPages, []);
});

test('Soundbook reconstructs byte-exact chunks across tested single-cell losses', async () => {
  const audio = new Uint8Array(randomBytes(28_000));
  const planOptions = {
    bookId: randomBytes(16).toString('hex'),
    audioSha256: hash(audio),
    durationMicros: 4_000_000,
  };
  const sizingPlan = createSoundbookPagePlan(audio, planOptions);
  const chunkHashes = Array.from({ length: sizingPlan.pageCount }, (_, index) => {
    const offset = index * sizingPlan.chunkCapacity;
    return hash(audio.subarray(offset, Math.min(offset + sizingPlan.chunkCapacity, audio.byteLength)));
  });
  const plan = createSoundbookPagePlan(audio, { ...planOptions, chunkHashes });
  assert.equal(plan.manifest.format, 'SOUNDBOOK-4');
  assert.equal(plan.manifest.transport, 'MQR1');
  assert.equal(plan.manifest.grid.pageCode, 'raptorq-rfc6330');
  assert.equal(plan.manifest.grid.recoveryModel, 'probabilistic');
  const pages = Array.from({ length: plan.pageCount }, (_, pageIndex) =>
    encodeSoundbookPage(audio, plan, pageIndex));
  assert.ok(pages[1].fragments.every((fragment) => fragment.startsWith('MQR1:')));
  const repairPositions = pages[1].fragments.flatMap((fragment, index) =>
    parseMqrFrame(fragment).encodingSymbolId >= plan.dataFramesPerPage ? [index] : []);
  assert.deepEqual(repairPositions, [5, 10]);

  for (let missingIndex = 0; missingIndex < plan.framesPerPage; missingIndex += 1) {
    const lossDecoder = new SoundbookDecoder();
    let recoveredPage;
    for (let index = 0; index < pages[1].fragments.length; index += 1) {
      if (index !== missingIndex) {
        recoveredPage = await lossDecoder.add(pages[1].fragments[index]);
        if (recoveredPage.kind === 'page-complete') break;
      }
    }
    assert.equal(recoveredPage.kind, 'page-complete', `failed when QR ${missingIndex + 1} was missing`);
    assert.deepEqual(recoveredPage.chunkBytes, audio.subarray(plan.chunkCapacity, plan.chunkCapacity * 2));
  }

  const decoder = new SoundbookDecoder();
  let result;
  for (const fragment of pages[1].fragments.slice(0, plan.dataFramesPerPage)) {
    result = await decoder.add(fragment);
  }
  assert.equal(result.kind, 'page-complete');
  assert.equal(result.playbackPageIndex, 1);
  assert.deepEqual(result.chunkBytes, audio.subarray(plan.chunkCapacity, plan.chunkCapacity * 2));
  assert.equal(decoder.complete, false);
  assert.deepEqual(decoder.status.availablePages, [1]);

  for (const fragment of pages[0].fragments.slice(0, plan.dataFramesPerPage)) {
    result = await decoder.add(fragment);
  }
  assert.equal(result.kind, 'page-complete');
  for (const fragment of pages[2].fragments.slice(0, plan.dataFramesPerPage)) {
    result = await decoder.add(fragment);
  }
  assert.equal(result.kind, 'book-complete');
  assert.deepEqual(result.chunkBytes, audio.subarray(plan.chunkCapacity * 2));
  assert.deepEqual(decoder.result, audio);
});

test('Soundbook decoder counts duplicate scans and rejects non-MQR text', async () => {
  const audio = new Uint8Array(randomBytes(100));
  const envelope = makeChunkPage({
    audio,
    pageIndex: 0,
    pageCount: 1,
    chunkCapacity: 135,
    bookId: randomBytes(16).toString('hex'),
    audioSha256: hash(audio),
  });
  const encoder = makePageEncoder(envelope);
  const first = encoder.nextFragment();
  const decoder = new SoundbookDecoder();
  assert.equal((await decoder.add(first)).kind, 'fragment');
  assert.equal((await decoder.add(first.toUpperCase())).kind, 'duplicate');
  assert.equal((await decoder.add('not an MQR1 frame')).kind, 'invalid');
  assert.equal(decoder.status.duplicatesIgnored, 1);
  assert.equal(decoder.status.invalidFrames, 1);
});

test('Soundbook decoder rejects a completed book whose audio hash does not match', async () => {
  const audio = new Uint8Array(randomBytes(200));
  const envelope = makeChunkPage({
    audio,
    pageIndex: 0,
    pageCount: 1,
    chunkCapacity: 263,
    bookId: randomBytes(16).toString('hex'),
    audioSha256: '00'.repeat(32),
  });
  const encoder = makePageEncoder(envelope);
  const decoder = new SoundbookDecoder();
  let result;
  for (const fragment of encoder.take(encoder.frameCount)) {
    result = await decoder.add(fragment);
    if (result.kind === 'invalid') break;
  }
  assert.equal(result.kind, 'invalid');
  assert.match(result.message, /SHA-256 integrity check failed/);
  assert.equal(decoder.complete, false);
});

test('Soundbook verifies each reconstructed byte chunk before exposing it', async () => {
  const audio = new Uint8Array(randomBytes(128));
  const chunk = new Uint8Array(135);
  chunk.set(audio);
  const envelope = createSoundbookChunkEnvelope({
    bookId: randomBytes(16).toString('hex'),
    pageIndex: 0,
    pageCount: 1,
    audioLength: audio.byteLength,
    chunkLength: audio.byteLength,
    chunkCapacity: chunk.byteLength,
    durationMicros: 1_000_000,
    audioSha256: hash(audio),
    chunkSha256: '00'.repeat(32),
    chunk,
  });
  const encoder = makePageEncoder(envelope);
  const decoder = new SoundbookDecoder();
  let result;
  for (const fragment of encoder.take(encoder.frameCount)) {
    result = await decoder.add(fragment);
    if (result.kind === 'invalid') break;
  }
  assert.equal(result.kind, 'invalid');
  assert.match(result.message, /chunk SHA-256 integrity check failed/);
  assert.deepEqual(decoder.status.availablePages, []);
});

test('default Soundbook page planning keeps a 250 kB source near 23 pages', () => {
  const source = new Uint8Array(250_000);
  const plan = createSoundbookPagePlan(source, {
    bookId: randomBytes(16).toString('hex'),
    audioSha256: hash(source),
    durationMicros: 30_000_000,
  });
  assert.ok(plan.chunkCapacity > 11_000);
  assert.equal(plan.pageCount, Math.ceil(source.byteLength / plan.chunkCapacity));
  assert.ok(plan.pageCount >= 22 && plan.pageCount <= 23, `${plan.pageCount} pages at ${plan.chunkCapacity} bytes/page`);
  assert.equal(plan.manifest.byteExact, true);
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

test('Soundbook CLI preserves the original Ogg Opus bytes and reconstructs them exactly', {
  skip: !ffmpegAvailable,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soundbook-cli-'));
  try {
    const sourcePath = join(directory, 'source.opus');
    const outputDirectory = join(directory, 'book');
    const generated = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=25',
      '-c:a', 'libopus', '-b:a', '8k', sourcePath,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(generated.status, 0, generated.stderr);
    const original = new Uint8Array(await readFile(sourcePath));

    const cliPath = new URL('../bin/soundbook.js', import.meta.url).pathname;
    const encoded = spawnSync(process.execPath, [
      cliPath,
      'encode',
      sourcePath,
      '--out',
      outputDirectory,
    ], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);

    const manifest = JSON.parse(await readFile(join(outputDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'SOUNDBOOK-4');
    assert.equal(manifest.byteExact, true);
    assert.equal(manifest.audioLength, original.byteLength);
    assert.equal(manifest.audioSha256, hash(original));
    assert.equal(manifest.bitrate, undefined);
    assert.equal(manifest.qr.version, 21);
    assert.equal(manifest.qr.correction, 'low');
    assert.deepEqual([manifest.grid.columns, manifest.grid.rows], [4, 4]);
    assert.equal(manifest.grid.sourceSymbols, 14);
    assert.equal(manifest.grid.repairSymbols, 2);
    assert.ok(
      manifest.pagePayloadBytes > 11_000,
      `measured QR version-20 low-ECC payload was ${manifest.pagePayloadBytes} bytes/page`,
    );

    const files = await readdir(outputDirectory);
    assert.ok(manifest.pageCount > 1, 'the source should span multiple page-sized byte chunks');
    assert.equal(files.filter((file) => /^page-\d+\.png$/.test(file)).length, manifest.pageCount);
    assert.equal(files.filter((file) => /^page-\d+-frame-\d+\.mqr\.txt$/.test(file)).length, manifest.frameCount);
    const decoder = new SoundbookDecoder();
    const fragmentFiles = files.filter((entry) => /\.mqr\.txt$/.test(entry)).sort();
    let firstPageResult;
    let nextFragmentIndex = 0;
    while (!firstPageResult && nextFragmentIndex < fragmentFiles.length) {
      const file = fragmentFiles[nextFragmentIndex++];
      const result = await decoder.add(await readFile(join(outputDirectory, file), 'utf8'));
      if (result.kind === 'page-complete') firstPageResult = result;
    }
    assert.ok(firstPageResult, 'the first byte chunk should decode independently');
    assert.equal(firstPageResult.pageIndex, 0);
    assert.equal(firstPageResult.status.complete, false);
    assert.equal(firstPageResult.status.completedPages, 1);
    let finalResult;
    for (; nextFragmentIndex < fragmentFiles.length; nextFragmentIndex += 1) {
      finalResult = await decoder.add(await readFile(join(outputDirectory, fragmentFiles[nextFragmentIndex]), 'utf8'));
      if (decoder.complete) break;
    }
    assert.equal(decoder.complete, true);
    assert.equal(hash(decoder.result), manifest.audioSha256);
    assert.equal(finalResult.kind, 'book-complete');
    assert.deepEqual(decoder.result, original);
    const decoded = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 'null', '-',
    ], { input: Buffer.from(decoder.result), encoding: 'utf8', timeout: 30_000 });
    assert.equal(decoded.status, 0, decoded.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
