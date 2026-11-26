import { scanImageData } from '@undecaf/zbar-wasm';

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (message?.type !== 'scan-frame') return;

  try {
    const { width, height, pixels, frameId } = message;
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const symbols = await scanImageData(imageData);
    const qrSymbols = symbols.filter((symbol) => /qr/i.test(symbol.typeName || ''));
    const texts = [];

    for (const symbol of qrSymbols) {
      try {
        const text = symbol.decode();
        if (typeof text === 'string' && text.length > 0) texts.push(text);
      } catch {
        // Ignore one unreadable symbol without discarding other QR results.
      }
    }

    self.postMessage({
      type: 'scan-result',
      frameId,
      sourceWidth: message.sourceWidth,
      isHighResolutionProbe: message.isHighResolutionProbe,
      totalSymbols: qrSymbols.length,
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
