import test from 'node:test';
import assert from 'node:assert/strict';
import { completeOggPrefixLength, isOggOpus } from '../src/ogg-stream.js';

function makeOggPage(body) {
  const page = new Uint8Array(28 + body.byteLength);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[4] = 0;
  page[26] = 1;
  page[27] = body.byteLength;
  page.set(body, 28);
  return page;
}

test('Ogg prefix parser only returns complete pages', () => {
  const first = makeOggPage(new Uint8Array([79, 112, 117, 115, 72, 101, 97, 100]));
  const second = makeOggPage(new Uint8Array([1, 2, 3]));
  const bytes = new Uint8Array(first.byteLength + second.byteLength + 12);
  bytes.set(first);
  bytes.set(second, first.byteLength);
  bytes.set([79, 103, 103, 83, 0, 0], first.byteLength + second.byteLength);

  assert.equal(completeOggPrefixLength(bytes), first.byteLength + second.byteLength);
  assert.equal(isOggOpus(bytes), true);
});

test('Ogg prefix parser rejects invalid framing and identifies non-Opus streams', () => {
  assert.equal(isOggOpus(makeOggPage(new Uint8Array([1, 2, 3]))), false);
  assert.throws(() => completeOggPrefixLength(new Uint8Array(27)), /capture pattern/);
});
