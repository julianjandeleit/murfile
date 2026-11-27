import { scanImageDataWithoutCache } from '../../../src/browser/zbar-scanner.js';

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (message?.type !== 'scan-frame') return;

  try {
    const { width, height, pixels, frameId } = message;
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const scanStartedAt = performance.now();
    const symbols = await scanImageDataWithoutCache(imageData);
    const scanDurationMs = performance.now() - scanStartedAt;
    const qrSymbols = symbols.filter((symbol) => /qr/i.test(symbol.typeName || ''));
    const texts = [];
    const symbolSides = qrSymbols
      .map((symbol) => {
        if (!Array.isArray(symbol.points) || symbol.points.length < 3) return 0;
        const xs = symbol.points.map((point) => point.x);
        const ys = symbol.points.map((point) => point.y);
        return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      })
      .filter((side) => Number.isFinite(side) && side > 0);

    const textDecodeStartedAt = performance.now();
    for (const symbol of qrSymbols) {
      try {
        const text = symbol.decode();
        if (typeof text === 'string' && text.length > 0) texts.push(text);
      } catch {
        // Ignore one unreadable symbol without discarding other QR results.
      }
    }
    const textDecodeDurationMs = performance.now() - textDecodeStartedAt;

    self.postMessage({
      type: 'scan-result',
      frameId,
      scanWidth: width,
      scanHeight: height,
      sourceWidth: message.sourceWidth,
      isHighResolutionProbe: message.isHighResolutionProbe,
      captureDurationMs: message.captureDurationMs,
      scanDurationMs,
      textDecodeDurationMs,
      totalSymbols: qrSymbols.length,
      smallestSymbolSide: symbolSides.length ? Math.min(...symbolSides) : 0,
      texts,
    });
  } catch (error) {
    self.postMessage({
      type: 'scan-error',
      frameId: message.frameId,
      sourceWidth: message.sourceWidth,
      isHighResolutionProbe: message.isHighResolutionProbe,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
