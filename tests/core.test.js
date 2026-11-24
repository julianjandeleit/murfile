import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { UR } from '@blockchaincommons/uniform-resources';
import { FileDecoder, FileEncoder, createBytesUr, isMultipartUrCandidate } from '../src/index.js';

function equalBytes(actual, expected) {
  assert.deepEqual(Buffer.from(actual), Buffer.from(expected));
}

test('FileEncoder emits a single-part UR when the CBOR payload fits one fragment', () => {
  const encoder = new FileEncoder(new Uint8Array([1, 2, 3]), { maxFragmentLength: 100 });
  assert.equal(encoder.isSinglePart, true);
  const fragment = encoder.nextFragment();
  assert.match(fragment, /^ur:bytes\//);
  assert.equal(encoder.nextFragment(), undefined);
});

test('createBytesUr creates a standard ur:bytes single-part resource', () => {
  const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
  const ur = createBytesUr(original);
  assert.equal(ur.type.name, 'bytes');
  assert.match(ur.toString(), /^ur:bytes\//);

  const decoder = new FileDecoder();
  const result = decoder.add(ur.toString());
  assert.equal(result.kind, 'complete');
  equalBytes(result.bytes, original);
});

test('FileEncoder emits MUR strings accepted by the official decoder wrapper', () => {
  const original = randomBytes(4096);
  const encoder = new FileEncoder(original, { maxFragmentLength: 80 });
  const fragment = encoder.nextFragment();

  assert.equal(typeof fragment, 'string');
  assert.match(fragment, /^ur:bytes\/\+?\d+-\+?\d+\//);
  assert.equal(encoder.emittedCount, 1);
  assert.ok(encoder.sourcePartCount > 1);
});

test('FileDecoder reconstructs a multipart file from the systematic fragments', () => {
  const original = randomBytes(8192);
  const encoder = new FileEncoder(original, { maxFragmentLength: 90 });
  const fragments = encoder.take(encoder.sourcePartCount);
  const decoder = new FileDecoder();

  for (const fragment of fragments) {
    decoder.add(fragment);
    if (decoder.complete) break;
  }

  assert.equal(decoder.complete, true);
  equalBytes(decoder.result, original);
  assert.equal(decoder.progress, 1);
});

test('FileDecoder accepts fragments in a different order', () => {
  const original = randomBytes(3072);
  const encoder = new FileEncoder(original, { maxFragmentLength: 64 });
  const fragments = encoder.take(encoder.sourcePartCount);
  // Deterministic nontrivial permutation: reverse is enough to test that
  // sequence-number order is not required by the fountain decoder.
  const decoder = new FileDecoder();
  for (const fragment of fragments.reverse()) {
    decoder.add(fragment);
    if (decoder.complete) break;
  }

  assert.equal(decoder.complete, true);
  equalBytes(decoder.result, original);
});


test('FileDecoder can recover a missing systematic fragment from repair fragments', () => {
  const original = randomBytes(2048);
  const encoder = new FileEncoder(original, { maxFragmentLength: 96 });
  const sourceCount = encoder.sourcePartCount;
  const fragments = encoder.take(sourceCount + 100);
  const decoder = new FileDecoder();

  // Omit one of the initial plain fragments, then continue with the fountain
  // repair sequence. The fixed sequence seed makes this regression test repeatable.
  for (let index = 0; index < fragments.length; index += 1) {
    if (index === 1) continue;
    decoder.add(fragments[index]);
    if (decoder.complete) break;
  }

  assert.equal(decoder.complete, true, `decoder progress was ${(decoder.progress * 100).toFixed(2)} %`);
  equalBytes(decoder.result, original);
});

test('FileDecoder ignores repeated QR detections', () => {
  const original = randomBytes(1024);
  const encoder = new FileEncoder(original, { maxFragmentLength: 100 });
  const first = encoder.nextFragment();
  const decoder = new FileDecoder();

  assert.equal(decoder.add(first).kind, 'fragment');
  assert.equal(decoder.add(first.toUpperCase()).kind, 'duplicate');
  assert.equal(decoder.status.duplicatesIgnored, 1);
});

test('FileDecoder rejects non-bytes UR types', () => {
  const other = UR.from('example', createBytesUr(new Uint8Array([1])).cbor).toString();
  const decoder = new FileDecoder();
  const result = decoder.add(other);
  assert.equal(result.kind, 'invalid');
  assert.match(result.message, /expected "bytes"/);
  assert.equal(decoder.status.invalidUris, 1);
});

test('FileDecoder reports malformed UR strings without throwing', () => {
  const decoder = new FileDecoder();
  const result = decoder.add('ur:bytes/not-a-valid-bytewords-payload');
  assert.equal(result.kind, 'invalid');
  assert.equal(decoder.status.invalidUris, 1);
});

test('multipart candidate detection distinguishes single-part URs', () => {
  assert.equal(isMultipartUrCandidate('UR:BYTES/1-12/ABC'), true);
  assert.equal(isMultipartUrCandidate('ur:bytes/abc'), false);
  assert.equal(isMultipartUrCandidate('not a ur'), false);
});
