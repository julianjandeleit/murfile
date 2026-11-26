import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGrid as parsePublicGrid } from 'murfile/qr-grid';
import { FileEncoder } from '../src/encoder.js';
import {
  chooseSymbolSize,
  composeGridPage,
  parseGrid,
  qrModulesForFragment,
  renderQrFragment,
} from '../src/qr-grid.js';

test('parseGrid preserves columns-by-rows semantics and rejects malformed dimensions', () => {
  assert.deepEqual(parseGrid('4x3'), { columns: 4, rows: 3 });
  assert.deepEqual(parsePublicGrid('4x3'), { columns: 4, rows: 3 });
  assert.throws(() => parseGrid('0x3'), /positive safe integer/);
  assert.throws(() => parseGrid('4 by 3'), /form NxM/);
});

test('composeGridPage places images row-major and leaves gaps and padding white', () => {
  const black = { width: 2, height: 2, pixels: new Uint8Array(16).fill(0) };
  const page = composeGridPage([black, black], {
    size: 2,
    columns: 2,
    rows: 1,
    gap: 1,
    padding: 1,
  });

  assert.equal(page.width, 7);
  assert.equal(page.height, 4);
  const pixel = (x, y) => Array.from(page.pixels.slice((y * page.width + x) * 4, (y * page.width + x) * 4 + 4));
  assert.deepEqual(pixel(0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixel(1, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixel(3, 1), [255, 255, 255, 255]);
  assert.deepEqual(pixel(4, 1), [0, 0, 0, 0]);
});

test('shared renderer enforces the requested fixed QR version', () => {
  const symbolSize = chooseSymbolSize('low', 21);
  const fragment = new FileEncoder(new Uint8Array(13 * symbolSize), {
    symbolSize,
    sourceSymbols: 13,
    repairSymbols: 3,
  }).nextFragment();
  assert.equal(qrModulesForFragment(fragment, 'low', 21), 101);
  const image = renderQrFragment(fragment, { size: 512, correction: 'low', version: 21 });
  assert.equal(image.width, 512);
  assert.equal(image.height, 512);
});

test('QR capacity helper chooses an aligned RaptorQ symbol size for the requested version', () => {
  const symbolSize = chooseSymbolSize('low', 10);
  const encoder = new FileEncoder(new Uint8Array(13 * symbolSize), {
    symbolSize,
    sourceSymbols: 13,
    repairSymbols: 3,
  });
  const fragment = encoder.nextFragment();
  assert.equal(qrModulesForFragment(fragment, 'low', 10), 57);
});
