export const DEFAULT_SCAN_WIDTH = 1440;
export const HIGH_RESOLUTION_PROBE_INTERVAL = 8;
export const TARGET_QR_SYMBOL_SIDE_PIXELS = 400;

export class AdaptiveScanResolution {
  constructor({
    initialWidth = DEFAULT_SCAN_WIDTH,
    probeInterval = HIGH_RESOLUTION_PROBE_INTERVAL,
    targetSymbolSide = TARGET_QR_SYMBOL_SIDE_PIXELS,
  } = {}) {
    this.initialWidth = initialWidth;
    this.probeInterval = probeInterval;
    this.targetSymbolSide = targetSymbolSide;
    this.reset();
  }

  reset() {
    this.sourceWidth = 0;
    this.scanWidth = 0;
    this.scanCount = 0;
    this.recentLowResolutionSymbolCounts = [];
  }

  next(sourceWidth) {
    if (sourceWidth !== this.sourceWidth) {
      this.sourceWidth = sourceWidth;
      this.scanWidth = Math.min(this.initialWidth, sourceWidth);
      this.scanCount = 0;
      this.recentLowResolutionSymbolCounts = [];
    }

    this.scanCount += 1;
    const isHighResolutionProbe = this.scanWidth < sourceWidth &&
      this.scanCount % this.probeInterval === 0;

    return {
      width: isHighResolutionProbe ? sourceWidth : this.scanWidth,
      isHighResolutionProbe,
    };
  }

  observe({ sourceWidth, scanWidth, isHighResolutionProbe, symbolCount, smallestSymbolSide }) {
    if (sourceWidth !== this.sourceWidth) return;

    if (isHighResolutionProbe) {
      const bestLowResolutionCount = Math.max(0, ...this.recentLowResolutionSymbolCounts);
      if (symbolCount > bestLowResolutionCount) {
        const requiredWidth = smallestSymbolSide > 0
          ? this.#requiredWidth(sourceWidth, sourceWidth, smallestSymbolSide)
          : sourceWidth;
        this.scanWidth = requiredWidth > this.scanWidth ? requiredWidth : sourceWidth;
      }
      this.recentLowResolutionSymbolCounts = [];
      return;
    }

    this.recentLowResolutionSymbolCounts.push(symbolCount);
    if (this.recentLowResolutionSymbolCounts.length >= this.probeInterval) {
      this.recentLowResolutionSymbolCounts.shift();
    }

    if (smallestSymbolSide > 0 && smallestSymbolSide < this.targetSymbolSide) {
      this.scanWidth = this.#requiredWidth(sourceWidth, scanWidth, smallestSymbolSide);
    } else if (smallestSymbolSide >= this.targetSymbolSide * 2) {
      this.scanWidth = Math.min(this.scanWidth, this.initialWidth, sourceWidth);
    }
  }

  #requiredWidth(sourceWidth, scanWidth, symbolSide) {
    const minimumWidth = Math.min(this.initialWidth, sourceWidth);
    return Math.min(
      sourceWidth,
      Math.max(minimumWidth, Math.ceil(scanWidth * this.targetSymbolSide / symbolSide)),
    );
  }
}
