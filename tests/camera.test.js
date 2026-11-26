import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCameraStream } from '../src/browser/camera.js';

function installBrowserGlobals(t, mediaDevices) {
  const previous = new Map();
  for (const [name, value] of [
    ['navigator', { mediaDevices }],
    ['window', { isSecureContext: true }],
    ['location', { hostname: 'localhost' }],
  ]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

test('camera request selects the highest reported resolution and returns actual settings', async (t) => {
  let settings = { width: 640, height: 480, deviceId: 'camera-1' };
  let requested;
  const constraintsApplied = [];
  const track = {
    getCapabilities: () => ({
      width: { min: 320, max: 1920 },
      height: { min: 240, max: 1080 },
    }),
    getSettings: () => ({ ...settings }),
    applyConstraints: async (constraints) => {
      constraintsApplied.push(constraints);
      settings = {
        ...settings,
        width: constraints.width.exact,
        height: constraints.height.exact,
      };
    },
  };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
  installBrowserGlobals(t, {
    getUserMedia: async (constraints) => {
      requested = constraints;
      return stream;
    },
  });

  const result = await requestCameraStream('camera-1');

  assert.deepEqual(requested.video.width, { ideal: 3840 });
  assert.deepEqual(requested.video.height, { ideal: 2160 });
  assert.deepEqual(constraintsApplied[0], {
    width: { exact: 1920 },
    height: { exact: 1080 },
  });
  assert.deepEqual(result.resolution, {
    width: 1920,
    height: 1080,
    maxWidth: 1920,
    maxHeight: 1080,
    warning: '',
  });
  assert.equal(result.stream, stream);
});
