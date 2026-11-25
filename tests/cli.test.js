import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { FileEncoder } from '../src/index.js';
import { renderUrQr } from '@blockchaincommons/multipart-ur';
import { encodeQr as encodeFixedQr } from '../src/vendor/qr-fixed.js';

const cliPath = new URL('../bin/murfile.js', import.meta.url);

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  });
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('CLI encode/decode roundtrip using exported UR text files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'murfile-cli-'));
  try {
    const sourcePath = join(directory, 'sample.bin');
    const framesDirectory = join(directory, 'frames');
    const outputPath = join(directory, 'recovered.bin');
    const original = randomBytes(1200);
    await writeFile(sourcePath, original);

    const encoded = runCli([
      'encode', sourcePath,
      '--out', framesDirectory,
      '--frames', '80',
      '--max-fragment-length', '96',
      '--format', 'ur',
    ]);
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);

    const decoded = runCli(['decode', framesDirectory, '--out', outputPath]);
    assert.equal(decoded.status, 0, decoded.stderr || decoded.stdout);
    const recovered = await readFile(outputPath);
    assert.equal(hash(recovered), hash(original));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI automatically selects QR-fitting fragments and adds frame redundancy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'murfile-auto-'));
  try {
    const sourcePath = join(directory, 'sample.bin');
    const framesDirectory = join(directory, 'frames');
    const outputPath = join(directory, 'recovered.bin');
    const original = randomBytes(24_000);
    await writeFile(sourcePath, original);

    const encoded = runCli([
      'encode', sourcePath,
      '--out', framesDirectory,
      '--format', 'ur',
    ]);
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);

    const manifest = JSON.parse(await readFile(join(framesDirectory, 'manifest.json'), 'utf8'));
    assert.ok(manifest.maxFragmentLength > 100);
    assert.ok(manifest.sourcePartCount > 1);
    assert.equal(manifest.frameCount, Math.ceil(manifest.sourcePartCount * 1.1));

    const firstStem = `frame-${String(1).padStart(String(manifest.frameCount).length, '0')}`;
    const firstFragment = (await readFile(join(framesDirectory, `${firstStem}.ur.txt`), 'utf8')).trim();
    assert.doesNotThrow(() => renderUrQr(firstFragment, { size: 256, correction: 'medium' }));

    const decoded = runCli(['decode', framesDirectory, '--out', outputPath]);
    assert.equal(decoded.status, 0, decoded.stderr || decoded.stdout);
    assert.equal(hash(await readFile(outputPath)), hash(original));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI forces every emitted QR to the requested matrix version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'murfile-fixed-version-'));
  try {
    const sourcePath = join(directory, 'sample.bin');
    const framesDirectory = join(directory, 'frames');
    const original = randomBytes(8000);
    const targetVersion = 10;
    const expectedModules = 17 + 4 * targetVersion;
    await writeFile(sourcePath, original);

    const encoded = runCli([
      'encode', sourcePath,
      '--out', framesDirectory,
      '--qr-version', String(targetVersion),
      '--format', 'both',
    ]);
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);

    const manifest = JSON.parse(await readFile(join(framesDirectory, 'manifest.json'), 'utf8'));
    assert.ok(manifest.sourcePartCount > 1);
    assert.equal(manifest.qr.version, targetVersion);
    assert.equal(manifest.qr.modules, expectedModules);

    const frameDigits = String(manifest.frameCount).length;
    for (let index = 1; index <= manifest.frameCount; index += 1) {
      const stem = `frame-${String(index).padStart(frameDigits, '0')}`;
      const fragment = (await readFile(join(framesDirectory, `${stem}.ur.txt`), 'utf8')).trim();
      const symbol = encodeFixedQr(new TextEncoder().encode(fragment.toUpperCase()), 'M', targetVersion);
      assert.equal(symbol.width, expectedModules, `${stem} should use QR version ${targetVersion}`);
    }

    const firstStem = `frame-${String(1).padStart(frameDigits, '0')}`;
    const png = await readFile(join(framesDirectory, `${firstStem}.png`));
    assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI exports QR frames as row-major grid PNG pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'murfile-grid-'));
  try {
    const sourcePath = join(directory, 'sample.bin');
    const framesDirectory = join(directory, 'frames');
    const outputPath = join(directory, 'recovered.bin');
    const original = randomBytes(4000);
    const targetVersion = 15;
    const size = 128;
    const columns = 2;
    const rows = 2;
    const gap = 7;
    const padding = 13;
    await writeFile(sourcePath, original);

    const encoded = runCli([
      'encode', sourcePath,
      '--out', framesDirectory,
      '--qr-version', String(targetVersion),
      '--max-fragment-length', '100',
      '--size', String(size),
      '--grid', `${columns}x${rows}`,
      '--grid-gap', String(gap),
      '--grid-padding', String(padding),
      '--format', 'both',
    ]);
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);

    const manifest = JSON.parse(await readFile(join(framesDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.fountainScope, 'page');
    assert.equal(manifest.grid.fountainScope, 'page');
    assert.equal(manifest.grid.columns, columns);
    assert.equal(manifest.grid.rows, rows);
    assert.equal(manifest.grid.gap, gap);
    assert.equal(manifest.grid.padding, padding);
    assert.equal(manifest.grid.framesPerPage, columns * rows);
    assert.equal(manifest.grid.pageCount, Math.ceil(manifest.frameCount / (columns * rows)));
    assert.equal(manifest.grid.dataFramesPerPage, 3);
    assert.equal(manifest.grid.repairFramesPerPage, 1);
    assert.equal(manifest.grid.ordering, 'row-major');
    assert.equal(manifest.qr.version, targetVersion);

    const files = await readdir(framesDirectory);
    const pageFiles = files.filter((file) => /^page-\d+\.png$/.test(file)).sort();
    const urFiles = files.filter((file) => /^page-\d+-frame-\d+\.ur\.txt$/.test(file));
    const individualPngFiles = files.filter((file) => /^frame-\d+\.png$/.test(file));
    assert.equal(pageFiles.length, manifest.grid.pageCount);
    assert.equal(urFiles.length, manifest.frameCount);
    assert.equal(individualPngFiles.length, 0);

    const expectedWidth = columns * size + (columns - 1) * gap + 2 * padding;
    const expectedHeight = rows * size + (rows - 1) * gap + 2 * padding;
    for (const pageFile of pageFiles) {
      const png = await readFile(join(framesDirectory, pageFile));
      assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), expectedWidth);
      assert.equal(png.readUInt32BE(20), expectedHeight);
    }

    const decoded = runCli(['decode', framesDirectory, '--out', outputPath]);
    assert.equal(decoded.status, 0, decoded.stderr || decoded.stdout);
    assert.equal(hash(await readFile(outputPath)), hash(original));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI inspect emits JSON status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'murfile-inspect-'));
  try {
    const inputPath = join(directory, 'sample.bin');
    const framesDirectory = join(directory, 'frames');
    await writeFile(inputPath, randomBytes(600));
    const encoded = runCli([
      'encode', inputPath,
      '--out', framesDirectory,
      '--frames', '12',
      '--max-fragment-length', '100',
      '--format', 'ur',
    ]);
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);

    const inspected = runCli(['inspect', framesDirectory, '--json']);
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    const report = JSON.parse(inspected.stdout);
    assert.equal(report.urStringsRead, 12);
    assert.equal(report.mode, 'multipart');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('Blockchain Commons QR renderer creates a PNG for an emitted MUR fragment', () => {
  const encoder = new FileEncoder(randomBytes(2048), { maxFragmentLength: 100 });
  const fragment = encoder.nextFragment();
  const png = renderUrQr(fragment, { size: 256, correction: 'medium' }).toPng();
  assert.ok(png instanceof Uint8Array);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
});
