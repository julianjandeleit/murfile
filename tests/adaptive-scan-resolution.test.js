import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveScanResolution,
  DEFAULT_SCAN_WIDTH,
  HIGH_RESOLUTION_PROBE_INTERVAL,
} from '../src/browser/adaptive-scan-resolution.js';

test('starts with a reduced scan frame and preserves its aspect ratio inputs', () => {
  const adaptive = new AdaptiveScanResolution();

  assert.deepEqual(adaptive.next(3840), {
    width: DEFAULT_SCAN_WIDTH,
    isHighResolutionProbe: false,
  });
});

test('probes at full resolution periodically without raising the scan width unnecessarily', () => {
  const adaptive = new AdaptiveScanResolution();
  let scan;

  for (let index = 0; index < HIGH_RESOLUTION_PROBE_INTERVAL - 1; index += 1) {
    scan = adaptive.next(3840);
    adaptive.observe({
      sourceWidth: 3840,
      isHighResolutionProbe: scan.isHighResolutionProbe,
      symbolCount: 2,
    });
  }
  scan = adaptive.next(3840);

  assert.deepEqual(scan, { width: 3840, isHighResolutionProbe: true });
  adaptive.observe({
    sourceWidth: 3840,
    isHighResolutionProbe: true,
    symbolCount: 2,
  });
  assert.equal(adaptive.next(3840).width, DEFAULT_SCAN_WIDTH);
});

test('chooses a suitable scan width when a probe finds more symbols', () => {
  const adaptive = new AdaptiveScanResolution();

  for (let index = 0; index < HIGH_RESOLUTION_PROBE_INTERVAL - 1; index += 1) {
    const scan = adaptive.next(3840);
    adaptive.observe({
      sourceWidth: 3840,
      isHighResolutionProbe: scan.isHighResolutionProbe,
      symbolCount: 2,
    });
  }
  const probe = adaptive.next(3840);
  adaptive.observe({
    sourceWidth: 3840,
    scanWidth: probe.width,
    isHighResolutionProbe: probe.isHighResolutionProbe,
    symbolCount: 3,
    smallestSymbolSide: 480,
  });

  assert.equal(adaptive.next(3840).width, 3200);
});

test('raises scan resolution when detected QR symbols are too small', () => {
  const adaptive = new AdaptiveScanResolution();
  const scan = adaptive.next(3840);

  adaptive.observe({
    sourceWidth: 3840,
    scanWidth: scan.width,
    isHighResolutionProbe: false,
    symbolCount: 5,
    smallestSymbolSide: 180,
  });

  assert.equal(adaptive.next(3840).width, 3200);
});

test('returns to fast scans immediately after detecting a large QR', () => {
  const adaptive = new AdaptiveScanResolution();
  const firstScan = adaptive.next(3840);
  adaptive.observe({
    sourceWidth: 3840,
    scanWidth: firstScan.width,
    isHighResolutionProbe: false,
    symbolCount: 5,
    smallestSymbolSide: 180,
  });
  const closeScan = adaptive.next(3840);
  adaptive.observe({
    sourceWidth: 3840,
    scanWidth: closeScan.width,
    isHighResolutionProbe: false,
    symbolCount: 1,
    smallestSymbolSide: 900,
  });

  assert.equal(adaptive.next(3840).width, DEFAULT_SCAN_WIDTH);
});

test('uses full resolution if a calibrated scan still misses detected symbols', () => {
  const adaptive = new AdaptiveScanResolution();
  const firstScan = adaptive.next(3840);
  adaptive.observe({
    sourceWidth: 3840,
    scanWidth: firstScan.width,
    isHighResolutionProbe: false,
    symbolCount: 5,
    smallestSymbolSide: 180,
  });

  for (let index = 1; index < HIGH_RESOLUTION_PROBE_INTERVAL - 1; index += 1) {
    const scan = adaptive.next(3840);
    adaptive.observe({
      sourceWidth: 3840,
      scanWidth: scan.width,
      isHighResolutionProbe: false,
      symbolCount: 5,
      smallestSymbolSide: 450,
    });
  }
  const probe = adaptive.next(3840);
  adaptive.observe({
    sourceWidth: 3840,
    scanWidth: probe.width,
    isHighResolutionProbe: probe.isHighResolutionProbe,
    symbolCount: 6,
    smallestSymbolSide: 500,
  });

  assert.equal(adaptive.next(3840).width, 3840);
});

test('uses the full frame directly when the camera source is already small', () => {
  const adaptive = new AdaptiveScanResolution();

  assert.deepEqual(adaptive.next(1280), {
    width: 1280,
    isHighResolutionProbe: false,
  });
});

test('resets the learned resolution when a new camera session starts', () => {
  const adaptive = new AdaptiveScanResolution();
  for (let index = 0; index < HIGH_RESOLUTION_PROBE_INTERVAL - 1; index += 1) {
    const scan = adaptive.next(3840);
    adaptive.observe({
      sourceWidth: 3840,
      isHighResolutionProbe: scan.isHighResolutionProbe,
      symbolCount: 1,
    });
  }
  const probe = adaptive.next(3840);
  adaptive.observe({
    sourceWidth: 3840,
    isHighResolutionProbe: probe.isHighResolutionProbe,
    symbolCount: 2,
  });
  assert.equal(adaptive.next(3840).width, 3840);

  adaptive.reset();

  assert.deepEqual(adaptive.next(3840), {
    width: DEFAULT_SCAN_WIDTH,
    isHighResolutionProbe: false,
  });
});
