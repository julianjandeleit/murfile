export const DEFAULT_SCAN_WIDTH = 1440;
export const HIGH_RESOLUTION_PROBE_INTERVAL = 8;

export class AdaptiveScanResolution {
  constructor({ initialWidth = DEFAULT_SCAN_WIDTH, probeInterval = HIGH_RESOLUTION_PROBE_INTERVAL } = {}) {
    this.initialWidth = initialWidth;
    this.probeInterval = probeInterval;
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

  observe({ sourceWidth, isHighResolutionProbe, symbolCount }) {
    if (sourceWidth !== this.sourceWidth) return;

    if (!isHighResolutionProbe) {
      this.recentLowResolutionSymbolCounts.push(symbolCount);
      if (this.recentLowResolutionSymbolCounts.length >= this.probeInterval) {
        this.recentLowResolutionSymbolCounts.shift();
      }
      return;
    }

    const bestLowResolutionCount = Math.max(0, ...this.recentLowResolutionSymbolCounts);
    if (symbolCount > bestLowResolutionCount) {
      this.scanWidth = Math.min(
        sourceWidth,
        Math.ceil(this.scanWidth * 1.5),
      );
    }
    this.recentLowResolutionSymbolCounts = [];
  }
}
