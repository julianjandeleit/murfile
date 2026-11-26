import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { FileDecoder, FileEncoder } from '../src/index.js';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('2.1 MB application-size byte-exact MQR1 roundtrip', { timeout: 120_000 }, () => {
  const original = randomBytes(2_100_000);
  const encoder = new FileEncoder(original, {
    symbolSize: 512,
    sourceSymbols: 13,
    repairSymbols: 3,
  });
  const decoder = new FileDecoder();

  for (const fragment of encoder) {
    decoder.add(fragment);
    if (decoder.complete) break;
  }

  assert.equal(decoder.complete, true, `decoder progress was ${(decoder.progress * 100).toFixed(2)} %`);
  assert.equal(hash(decoder.result), hash(original));
  assert.deepEqual(Buffer.from(decoder.result), Buffer.from(original));
});

test('extra RaptorQ symbols are tolerated after completion', () => {
  const original = randomBytes(2048);
  const encoder = new FileEncoder(original, {
    symbolSize: 128,
    sourceSymbols: 13,
    repairSymbols: 3,
  });
  const decoder = new FileDecoder();

  for (const fragment of encoder) {
    decoder.add(fragment);
    if (decoder.complete) break;
  }

  assert.equal(decoder.complete, true);
  const expected = hash(original);
  assert.equal(hash(decoder.result), expected);
});
