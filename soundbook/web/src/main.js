import { SoundbookDecoder } from '../../../src/soundbook-decoder.js';
import { populateCameraSelect, requestCameraStream } from '../../../src/browser/camera.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const elements = {
  video: $('video'),
  videoPlaceholder: $('videoPlaceholder'),
  cameraSelect: $('cameraSelect'),
  cameraState: $('cameraState'),
  startButton: $('startButton'),
  stopButton: $('stopButton'),
  resetButton: $('resetButton'),
  statusTitle: $('statusTitle'),
  statusDetail: $('statusDetail'),
  pageCount: $('pageCount'),
  activeCount: $('activeCount'),
  fragmentCount: $('fragmentCount'),
  qrCount: $('qrCount'),
  errorCount: $('errorCount'),
  pageList: $('pageList'),
  sessionProgress: $('sessionProgress'),
  audioPlayer: $('audioPlayer'),
  audioStatus: $('audioStatus'),
  downloadButton: $('downloadButton'),
};

const decoder = new SoundbookDecoder();
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
const qrWorker = new Worker(new URL('../../../web/src/workers/qr-worker.js', import.meta.url), { type: 'module' });
const FRAME_INTERVAL_MS = 190;
const MAX_SCAN_WIDTH = 1440;

let mediaStream;
let animationFrameId = 0;
let lastFrameAt = 0;
let frameId = 0;
let workerBusy = false;
let selectedCameraId = '';
let decodedQrCount = 0;
let audioObjectUrl;
let lastScanError = '';

function setCameraState(label, live = false) {
  elements.cameraState.className = `state-chip${live ? ' state-live' : ''}`;
  elements.cameraState.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'state-dot';
  const text = document.createElement('span');
  text.textContent = label;
  elements.cameraState.append(dot, text);
}

function renderStatus() {
  const status = decoder.status;
  elements.pageCount.textContent = status.pageCount === null
    ? '0 / ?'
    : `${status.completedPages} / ${status.pageCount}`;
  elements.activeCount.textContent = String(status.activeSessions.length);
  elements.fragmentCount.textContent = String(status.fragmentsReceived);
  elements.qrCount.textContent = String(decodedQrCount);
  elements.errorCount.textContent = `${status.duplicatesIgnored + status.redundantFragments} / ${status.invalidUris}`;

  if (status.pageCount === null) {
    elements.pageList.innerHTML = '<span class="muted">Page details will appear after the first page is validated.</span>';
    elements.statusTitle.textContent = status.activeSessions.length
      ? 'Collecting fragments for an unknown page'
      : 'Waiting for Soundbook pages';
    elements.statusDetail.textContent = status.activeSessions.length
      ? 'The Soundbook page identity is confirmed only when its Fountain session reconstructs.'
      : 'Point the camera at any page. The full compressed recording becomes playable when every page is reconstructed.';
    if (lastScanError) elements.statusDetail.textContent += ` Last scan issue: ${lastScanError}`;
  } else {
    elements.pageList.replaceChildren();
    const visiblePageCount = Math.min(status.pageCount, 256);
    const missingPageSet = new Set(status.missingPages);
    for (let index = 0; index < visiblePageCount; index += 1) {
      const page = document.createElement('span');
      const missing = missingPageSet.has(index);
      page.className = `page-pill${missing ? '' : ' complete'}`;
      page.textContent = `Page ${index + 1}: ${missing ? 'missing' : 'complete'}`;
      elements.pageList.append(page);
    }
    if (status.pageCount > visiblePageCount) {
      const remainder = document.createElement('span');
      remainder.className = 'muted';
      remainder.textContent = `${status.pageCount - visiblePageCount} additional pages; see missing-page count above.`;
      elements.pageList.append(remainder);
    }

    const nextMissing = status.missingPages[0];
    if (status.complete) {
      elements.statusTitle.textContent = 'All pages reconstructed and verified';
      elements.statusDetail.textContent = `Book ${status.bookId} · ${status.audioBytes.toLocaleString()} compressed bytes · ` +
        `${(status.audioDurationMicros / 1_000_000).toFixed(1)} seconds.`;
    } else {
      elements.statusTitle.textContent = `Waiting for page ${nextMissing + 1}`;
      elements.statusDetail.textContent = `${status.completedPages} of ${status.pageCount} pages complete. ` +
        `Playback will wait at the first missing page; ${status.missingPages.length} page(s) remain. ` +
        `Expected audio: ${(status.audioDurationMicros / 1_000_000).toFixed(1)} seconds; it is not playable until all pages arrive.` +
        (lastScanError ? ` Last scan issue: ${lastScanError}` : '');
    }
  }

  elements.sessionProgress.replaceChildren();
  if (status.activeSessions.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = 'No active sessions';
    elements.sessionProgress.append(empty);
  } else {
    status.activeSessions.forEach((session, index) => {
      const line = document.createElement('div');
      line.className = 'session-line';
      const label = document.createElement('span');
      label.textContent = `Session ${index + 1} · ${session.fragmentsReceived} fragments`;
      const progress = document.createElement('progress');
      progress.max = 1;
      progress.value = session.progress;
      const percent = document.createElement('span');
      percent.textContent = `${Math.round(session.progress * 100)}%`;
      line.append(label, progress, percent);
      elements.sessionProgress.append(line);
    });
  }

  if (status.complete) {
    elements.audioStatus.textContent = 'Complete compressed Ogg Opus recording is ready.';
    elements.downloadButton.hidden = false;
    elements.downloadButton.disabled = false;
    elements.audioPlayer.hidden = false;
  } else {
    elements.audioStatus.textContent = 'Waiting for all pages; playback will not skip missing pages.';
    elements.downloadButton.hidden = true;
    elements.downloadButton.disabled = true;
    elements.audioPlayer.hidden = true;
  }
}

async function startCamera() {
  mediaStream = await requestCameraStream(selectedCameraId);
  elements.video.srcObject = mediaStream;
  await elements.video.play();
  elements.videoPlaceholder.hidden = true;
  elements.startButton.disabled = true;
  elements.stopButton.disabled = false;
  elements.cameraSelect.disabled = true;
  setCameraState('Scanning', true);
  selectedCameraId = await populateCameraSelect(elements.cameraSelect, selectedCameraId);
  elements.cameraSelect.disabled = true;
  lastFrameAt = 0;
  animationFrameId = requestAnimationFrame(scanLoop);
}

function stopCamera() {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  animationFrameId = 0;
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = undefined;
  }
  elements.video.pause();
  elements.video.srcObject = null;
  elements.videoPlaceholder.hidden = false;
  elements.startButton.disabled = false;
  elements.stopButton.disabled = true;
  elements.cameraSelect.disabled = false;
  setCameraState('Ready');
}

function submitFrame() {
  if (workerBusy || !context || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const sourceWidth = elements.video.videoWidth;
  const sourceHeight = elements.video.videoHeight;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(1, MAX_SCAN_WIDTH / sourceWidth);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(elements.video, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  workerBusy = true;
  frameId += 1;
  qrWorker.postMessage({
    type: 'scan-frame',
    frameId,
    width,
    height,
    pixels: imageData.data.buffer,
  }, [imageData.data.buffer]);
}

function scanLoop(timestamp) {
  if (!mediaStream) return;
  if (!decoder.complete && timestamp - lastFrameAt >= FRAME_INTERVAL_MS) {
    lastFrameAt = timestamp;
    submitFrame();
  }
  animationFrameId = requestAnimationFrame(scanLoop);
}

async function handleQrTexts(texts) {
  for (const text of texts) {
    decodedQrCount += 1;
    const result = await decoder.add(text);
    if (result.kind === 'invalid') {
      lastScanError = result.message;
    } else if (result.kind === 'page-complete') {
      lastScanError = '';
      elements.statusTitle.textContent = `Page ${result.pageIndex + 1} reconstructed`;
    } else if (result.kind === 'book-complete') {
      lastScanError = '';
      const blob = new Blob([result.audioBytes], { type: 'audio/ogg; codecs=opus' });
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      audioObjectUrl = URL.createObjectURL(blob);
      elements.audioPlayer.src = audioObjectUrl;
      elements.audioPlayer.load();
      elements.statusTitle.textContent = 'All pages reconstructed and verified';
    }
  }
  renderStatus();
}

qrWorker.addEventListener('message', (event) => {
  workerBusy = false;
  if (event.data?.type === 'scan-result') {
    void handleQrTexts(event.data.texts || []).catch((error) => {
      elements.statusTitle.textContent = 'Soundbook processing failed';
      elements.statusDetail.textContent = error.message;
    });
  } else if (event.data?.type === 'scan-error') {
    elements.statusDetail.textContent = `QR recognition: ${event.data.message}`;
  }
});

qrWorker.addEventListener('error', (event) => {
  workerBusy = false;
  elements.statusTitle.textContent = 'QR scanner worker failed';
  elements.statusDetail.textContent = event.message;
});

elements.startButton.addEventListener('click', () => {
  elements.startButton.disabled = true;
  void startCamera().catch((error) => {
    stopCamera();
    setCameraState('Camera error');
    elements.statusTitle.textContent = 'Camera unavailable';
    elements.statusDetail.textContent = error.message;
  });
});
elements.stopButton.addEventListener('click', stopCamera);
elements.cameraSelect.addEventListener('change', () => {
  selectedCameraId = elements.cameraSelect.value;
  if (mediaStream) {
    stopCamera();
    elements.startButton.click();
  }
});
elements.resetButton.addEventListener('click', () => {
  decoder.reset();
  decodedQrCount = 0;
  lastScanError = '';
  elements.audioPlayer.pause();
  elements.audioPlayer.removeAttribute('src');
  elements.audioPlayer.load();
  if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
  audioObjectUrl = undefined;
  renderStatus();
});
elements.downloadButton.addEventListener('click', () => {
  const bytes = decoder.result;
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/ogg; codecs=opus' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'soundbook.ogg';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', stopCamera);
renderStatus();
