import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { parseMqrFrame } from '../src/index.js';
import { qrModulesForFragment } from '../src/qr-grid.js';

const cliPath = new URL('../bin/murfile.js', import.meta.url);

function runCli(args) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('CLI defaults to MQR1, QR21-L, and a 4x4 grid and roundtrips bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'murfile-cli-'));
  try {
    const sourcePath = join(directory, 'sample.bin');
    const framesDirectory = join(directory, 'frames');
    const outputPath = join(directory, 'recovered.bin');
    const original = randomBytes(1800);
    await writeFile(sourcePath, original);

    const encoded = runCli(['encode', sourcePath, '--out', framesDirectory]);
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);

    const manifest = JSON.parse(await readFile(join(framesDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'MQR1');
    assert.equal(manifest.originalSize, original.byteLength);
    assert.equal(manifest.sha256, hash(original));
    assert.deepEqual(
      [manifest.qr.version, manifest.qr.correction, manifest.grid.columns, manifest.grid.rows],
      [21, 'low', 4, 4],
    );
    assert.equal(manifest.grid.framesPerPage, 16);
    assert.equal(manifest.grid.sourceSymbols, 14);
    assert.equal(manifest.grid.repairSymbols, 2);

    const files = await readdir(framesDirectory);
    const frameFiles = files.filter((file) => /\.mqr\.txt$/.test(file)).sort();
    assert.equal(frameFiles.length, manifest.frameCount);
    assert.equal(files.filter((file) => /\.png$/.test(file)).length, manifest.pageCount);
    const repairPositions = frameFiles.flatMap((file, index) => {
      const frame = readFileSync(join(framesDirectory, file), 'utf8').replace(/\r?\n$/, '');
      return parseMqrFrame(frame).encodingSymbolId >= manifest.grid.sourceSymbols ? [index] : [];
    });
    assert.deepEqual(repairPositions, [5, 10]);
    const firstFrame = (await readFile(join(framesDirectory, frameFiles[0]), 'utf8')).replace(/\r?\n$/, '');
    assert.equal(firstFrame.startsWith('MQR1:'), true);
    assert.equal(qrModulesForFragment(firstFrame, 'low', 21), 101);

    const decoded = runCli(['decode', framesDirectory, '--out', outputPath]);
    assert.equal(decoded.status, 0, decoded.stderr || decoded.stdout);
    assert.equal(hash(await readFile(outputPath)), hash(original));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI respects custom grid, QR version, and error correction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'murfile-profile-'));
  try {
    const sourcePath = join(directory, 'sample.bin');
    const framesDirectory = join(directory, 'frames');
    await writeFile(sourcePath, randomBytes(400));

    const encoded = runCli([
      'encode', sourcePath,
      '--out', framesDirectory,
      '--grid', '2x2',
      '--qr-version', '15',
      '--correction', 'medium',
      '--repair-symbols', '1',
    ]);
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);

    const manifest = JSON.parse(await readFile(join(framesDirectory, 'manifest.json'), 'utf8'));
    assert.deepEqual(
      [manifest.qr.version, manifest.qr.correction, manifest.grid.columns, manifest.grid.rows],
      [15, 'medium', 2, 2],
    );
    assert.equal(manifest.grid.sourceSymbols, 3);
    assert.equal(manifest.grid.repairSymbols, 1);
    const frameFile = (await readdir(framesDirectory)).find((file) => /\.mqr\.txt$/.test(file));
    const frame = (await readFile(join(framesDirectory, frameFile), 'utf8')).replace(/\r?\n$/, '');
    assert.equal(qrModulesForFragment(frame, 'medium', 15), 77);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
