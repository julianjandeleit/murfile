import test from 'node:test';
import assert from 'node:assert/strict';
import { decode } from 'fast-png';
import { FileEncoder } from '../src/encoder.js';
import { composeGridPage, chooseSymbolSize, renderQrFragment } from '../src/qr-grid.js';
import { scanImageDataWithoutCache } from '../src/browser/zbar-scanner.js';

test('repeated scans keep returning every QR code from a static grid', async () => {
  const symbolSize = chooseSymbolSize('low', 21);
  const encoder = new FileEncoder(new Uint8Array(14 * symbolSize), {
    symbolSize,
    sourceSymbols: 14,
    repairSymbols: 2,
    transferId: '0123456789abcdef0123456789abcdef',
  });
  const images = encoder.take(16).map((fragment) =>
    renderQrFragment(fragment, { size: 512, correction: 'low', version: 21 }));
  const grid = composeGridPage(images, {
    size: 512,
    columns: 4,
    rows: 4,
    gap: 24,
    padding: 48,
  });
  const { width, height, data } = decode(grid.toPng());
  const imageData = { width, height, data };

  for (let scan = 0; scan < 6; scan += 1) {
    const symbols = await scanImageDataWithoutCache(imageData);
    assert.equal(
      symbols.filter((symbol) => /qr/i.test(symbol.typeName || '')).length,
      16,
      `scan ${scan + 1} should detect all QR codes again`,
    );
  }
});
