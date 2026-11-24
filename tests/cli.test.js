import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { FileEncoder } from '../src/index.js';
import { renderUrQr } from '@blockchaincommons/multipart-ur';

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
