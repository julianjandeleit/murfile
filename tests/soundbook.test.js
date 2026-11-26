import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FileEncoder } from '../src/encoder.js';
import { SoundbookDecoder as PublicSoundbookDecoder } from 'murfile/soundbook';
import { SoundbookDecoder } from '../src/soundbook-decoder.js';
import {
  MAX_SOUNDBOOK_PAGES,
  createSoundbookPageEnvelope,
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

test('Soundbook decoder accepts interleaved independent pages and verifies the complete book', async () => {
  const audio = new Uint8Array(randomBytes(750));
  const chunkCapacity = 380;
  const pageCount = Math.ceil(audio.byteLength / chunkCapacity);
  const bookId = randomBytes(16).toString('hex');
  const audioSha256 = hash(audio);
  const pageStreams = Array.from({ length: pageCount }, (_, pageIndex) => {
    const envelope = makePage({
      audio,
      pageIndex,
      pageCount,
      chunkCapacity,
      bookId,
      audioSha256,
    });
    const encoder = new FileEncoder(envelope, { maxFragmentLength: 160 });
    assert.equal(encoder.sourcePartCount, 3);
    return encoder.take(4);
  });

  const decoder = new SoundbookDecoder();
  let finalResult;
  for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
    for (let pageIndex = 0; pageIndex < pageStreams.length; pageIndex += 1) {
      finalResult = await decoder.add(pageStreams[pageIndex][frameIndex]);
      if (frameIndex === 2 && pageIndex === 0) {
        assert.equal(finalResult.kind, 'page-complete');
        assert.deepEqual(finalResult.status.missingPages, [1]);
        assert.equal(finalResult.status.audioAvailable, false);
      }
    }
  }

  assert.equal(finalResult.kind, 'book-complete');
  assert.deepEqual(decoder.result, audio);
  assert.equal(decoder.status.completedPages, 2);
  assert.equal(decoder.status.pageCount, 2);
  assert.deepEqual(decoder.status.missingPages, []);
});

test('Soundbook decoder counts duplicate scans and rejects non-MUR text', async () => {
  const audio = new Uint8Array(randomBytes(100));
  const envelope = makePage({
    audio,
    pageIndex: 0,
    pageCount: 1,
    chunkCapacity: 100,
    bookId: randomBytes(16).toString('hex'),
    audioSha256: hash(audio),
  });
  const encoder = new FileEncoder(envelope, { maxFragmentLength: 160 });
  const first = encoder.nextFragment();
  const decoder = new SoundbookDecoder();
  assert.equal((await decoder.add(first)).kind, 'fragment');
  assert.equal((await decoder.add(first.toUpperCase())).kind, 'duplicate');
  assert.equal((await decoder.add('not a QR UR')).kind, 'invalid');
  assert.equal(decoder.status.duplicatesIgnored, 1);
  assert.equal(decoder.status.invalidUris, 1);
});

test('Soundbook decoder rejects a completed book whose audio hash does not match', async () => {
  const audio = new Uint8Array(randomBytes(200));
  const envelope = makePage({
    audio,
    pageIndex: 0,
    pageCount: 1,
    chunkCapacity: audio.byteLength,
    bookId: randomBytes(16).toString('hex'),
    audioSha256: '00'.repeat(32),
  });
  const encoder = new FileEncoder(envelope, { maxFragmentLength: 160 });
  const decoder = new SoundbookDecoder();
  let result;
  for (const fragment of encoder.take(encoder.sourcePartCount + 2)) {
    result = await decoder.add(fragment);
    if (result.kind === 'invalid') break;
  }
  assert.equal(result.kind, 'invalid');
  assert.match(result.message, /SHA-256 integrity check failed/);
  assert.equal(decoder.complete, false);
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

test('Soundbook CLI compresses a complete recording and emits default 4x4 version-20 pages', {
  skip: !ffmpegAvailable,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soundbook-cli-'));
  try {
    const sourcePath = join(directory, 'source.wav');
    const outputDirectory = join(directory, 'book');
    const generated = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:a', 'pcm_s16le', sourcePath,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(generated.status, 0, generated.stderr);

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
    assert.equal(manifest.qr.version, 20);
    assert.equal(manifest.qr.correction, 'low');
    assert.deepEqual([manifest.grid.columns, manifest.grid.rows], [4, 4]);
    assert.equal(manifest.grid.redundancy, 'minimal');
    assert.equal(manifest.grid.dataFramesPerPage, 15);
    assert.equal(manifest.grid.repairFramesPerPage, 1);
    assert.ok(
      manifest.pagePayloadBytes > 7_200,
      `measured QR version-20 low-ECC payload was ${manifest.pagePayloadBytes} bytes/page`,
    );

    const files = await readdir(outputDirectory);
    assert.equal(files.filter((file) => /^page-\d+\.png$/.test(file)).length, manifest.pageCount);
    assert.equal(files.filter((file) => /^page-\d+-frame-\d+\.ur\.txt$/.test(file)).length, manifest.frameCount);
    const decoder = new SoundbookDecoder();
    for (const file of files.filter((entry) => /\.ur\.txt$/.test(entry)).sort()) {
      await decoder.add(await readFile(join(outputDirectory, file), 'utf8'));
      if (decoder.complete) break;
    }
    assert.equal(decoder.complete, true);
    assert.equal(hash(decoder.result), manifest.audioSha256);
    const probed = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=format_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      '-',
    ], { input: decoder.result, encoding: 'utf8', timeout: 30_000 });
    assert.equal(probed.status, 0, probed.stderr);
    assert.match(probed.stdout, /ogg/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
