import { getDefaultScanner, scanImageData } from '@undecaf/zbar-wasm';

let scannerPromise;

export async function scanImageDataWithoutCache(imageData) {
  scannerPromise ??= getDefaultScanner().then((scanner) => {
    scanner.enableCache(false);
    return scanner;
  });
  return scanImageData(imageData, await scannerPromise);
}
