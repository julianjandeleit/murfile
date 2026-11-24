import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { FileDecoder, FileEncoder } from '../src/index.js';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('2.1 MB application-size roundtrip through the official MUR implementation', { timeout: 120_000 }, () => {
  const original = randomBytes(2_100_000);
  const encoder = new FileEncoder(original, { maxFragmentLength: 500 });
  const decoder = new FileDecoder();
  const hardLimit = encoder.sourcePartCount + 300;

  for (let index = 0; index < hardLimit && !decoder.complete; index += 1) {
    decoder.add(encoder.nextFragment());
  }

  assert.equal(decoder.complete, true, `decoder progress was ${(decoder.progress * 100).toFixed(2)} %`);
  assert.equal(hash(decoder.result), hash(original));
  assert.deepEqual(decoder.result, original);
});

test('extra fountain fragments are tolerated after completion', () => {
  const original = randomBytes(2048);
  const encoder = new FileEncoder(original, { maxFragmentLength: 128 });
  const decoder = new FileDecoder();

  for (const fragment of encoder) {
    decoder.add(fragment);
    if (decoder.complete) break;
  }

  assert.equal(decoder.complete, true);
  const expected = hash(original);
  assert.equal(hash(decoder.result), expected);
});
