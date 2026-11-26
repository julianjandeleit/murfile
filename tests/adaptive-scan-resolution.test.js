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

test('raises the regular scan width when a full-resolution probe finds more symbols', () => {
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
    isHighResolutionProbe: probe.isHighResolutionProbe,
    symbolCount: 3,
  });

  assert.equal(adaptive.next(3840).width, Math.ceil(DEFAULT_SCAN_WIDTH * 1.5));
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
  assert.equal(adaptive.next(3840).width, Math.ceil(DEFAULT_SCAN_WIDTH * 1.5));

  adaptive.reset();

  assert.deepEqual(adaptive.next(3840), {
    width: DEFAULT_SCAN_WIDTH,
    isHighResolutionProbe: false,
  });
});
