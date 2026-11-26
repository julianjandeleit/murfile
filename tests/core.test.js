import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FileDecoder, FileEncoder, decodeBase45, encodeBase45, parseMqrFrame } from '../src/index.js';

function equalBytes(actual, expected) {
  assert.deepEqual(Buffer.from(actual), Buffer.from(expected));
}

function makeEncoder(bytes, options = {}) {
  return new FileEncoder(bytes, {
    symbolSize: 64,
    sourceSymbols: 13,
    repairSymbols: 3,
    transferId: '0123456789abcdef0123456789abcdef',
    ...options,
  });
}

test('Base45 preserves binary data and spaces', () => {
  const original = Uint8Array.from([0, 44, 255, 255, 0, 1, 128]);
  const encoded = encodeBase45(original);
  equalBytes(decodeBase45(encoded), original);
  assert.equal(encodeBase45(Uint8Array.from([36])).includes(' '), true);
});

test('MQR frame parsing validates the transport checksum', () => {
  const frame = makeEncoder(randomBytes(128)).nextFragment();
  const parsed = parseMqrFrame(frame);
  assert.equal(parsed.transferId, '0123456789abcdef0123456789abcdef');
  assert.equal(parsed.symbolSize, 64);

  const last = frame.at(-1);
  const corrupted = `${frame.slice(0, -1)}${last === '0' ? '1' : '0'}`;
  assert.throws(() => parseMqrFrame(corrupted), /checksum|Base45/);
});

test('FileDecoder reconstructs a file with any one grid symbol missing', () => {
  const original = randomBytes(700);
  const frames = makeEncoder(original).nextPage();
  assert.equal(frames.length, 16);

  for (let missingIndex = 0; missingIndex < frames.length; missingIndex += 1) {
    const decoder = new FileDecoder();
    for (let index = 0; index < frames.length; index += 1) {
      if (index !== missingIndex) decoder.add(frames[index]);
    }
    assert.equal(decoder.complete, true, `failed when QR ${missingIndex + 1} was missing`);
    equalBytes(decoder.result, original);
  }
});

test('FileDecoder reconstructs interleaved pages in any arrival order', () => {
  const original = randomBytes(1600);
  const encoder = makeEncoder(original);
  const pages = Array.from({ length: encoder.pageCount }, () => encoder.nextPage());
  assert.equal(pages.length, 2);

  const decoder = new FileDecoder();
  for (let index = 0; index < 16 && !decoder.complete; index += 1) {
    for (const page of pages) {
      decoder.add(page[index]);
      if (decoder.complete) break;
    }
  }
  assert.equal(decoder.complete, true);
  equalBytes(decoder.result, original);
  assert.deepEqual(decoder.status.missingPages, []);
});

test('FileDecoder counts duplicate and invalid MQR frames', () => {
  const frame = makeEncoder(randomBytes(64)).nextFragment();
  const decoder = new FileDecoder();
  assert.equal(decoder.add(frame).kind, 'fragment');
  assert.equal(decoder.add(frame).kind, 'duplicate');
  assert.equal(decoder.add('MQR1:not a frame').kind, 'invalid');
  assert.equal(decoder.status.duplicatesIgnored, 1);
  assert.equal(decoder.status.invalidFrames, 1);
});
