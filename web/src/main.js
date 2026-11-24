import { FileDecoder } from '../../src/index.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const elements = {
  video: $('video'),
  videoPlaceholder: $('videoPlaceholder'),
  cameraSelect: $('cameraSelect'),
  cameraState: $('cameraState'),
  resolutionLabel: $('resolutionLabel'),
  scanRateLabel: $('scanRateLabel'),
  startButton: $('startButton'),
  stopButton: $('stopButton'),
  torchButton: $('torchButton'),
  resetButton: $('resetButton'),
  transferIcon: $('transferIcon'),
  transferTitle: $('transferTitle'),
  transferSubtitle: $('transferSubtitle'),
  decodeProgress: $('decodeProgress'),
  progressLabel: $('progressLabel'),
  fragmentCount: $('fragmentCount'),
  duplicateCount: $('duplicateCount'),
  qrCount: $('qrCount'),
  invalidCount: $('invalidCount'),
  eventList: $('eventList'),
  eventCount: $('eventCount'),
  resultBadge: $('resultBadge'),
  resultEmpty: $('resultEmpty'),
  resultContent: $('resultContent'),
  filenameInput: $('filenameInput'),
  fileSize: $('fileSize'),
  hashValue: $('hashValue'),
  downloadButton: $('downloadButton'),
};

const session = new FileDecoder();
const canvas = document.createElement('canvas');
const canvasContext = canvas.getContext('2d', { willReadFrequently: true });
const qrWorker = new Worker(new URL('./workers/qr-worker.js', import.meta.url), { type: 'module' });

let mediaStream = null;
let animationFrameId = 0;
let lastFrameAt = 0;
let frameId = 0;
let workerBusy = false;
let torchOn = false;
let lastRateUpdate = 0;
let framesInWindow = 0;
let decodedQrCount = 0;
let completedFile = null;
let recentEvents = [];
let selectedCameraId = '';

const FRAME_INTERVAL_MS = 190;
const MAX_SCAN_WIDTH = 1440;
const MAX_EVENTS = 7;

function setCameraState(label, state = 'idle') {
  elements.cameraState.className = `state-chip state-${state}`;
  elements.cameraState.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'state-dot';
  const text = document.createElement('span');
  text.textContent = label;
  elements.cameraState.append(dot, text);
}

function setTransferState(title, subtitle, mode = 'waiting') {
  elements.transferTitle.textContent = title;
  elements.transferSubtitle.textContent = subtitle;
  elements.transferIcon.className = `transfer-icon transfer-${mode}`;
  elements.transferIcon.textContent = mode === 'complete' ? '✓' : mode === 'error' ? '!' : '↯';
  elements.resultBadge.textContent = mode === 'complete' ? 'Fertig' : mode === 'error' ? 'Fehler' : 'Ausstehend';
  elements.resultBadge.className = `result-badge ${mode === 'complete' ? 'badge-complete' : mode === 'error' ? 'badge-error' : ''}`;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function addEvent(message, kind = 'normal') {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  recentEvents.unshift({ time, message, kind });
  recentEvents = recentEvents.slice(0, MAX_EVENTS);
  elements.eventList.replaceChildren();
  for (const item of recentEvents) {
    const li = document.createElement('li');
    li.className = `event-item event-${item.kind}`;
    const timeSpan = document.createElement('time');
    timeSpan.textContent = item.time;
    const messageSpan = document.createElement('span');
    messageSpan.textContent = item.message;
    li.append(timeSpan, messageSpan);
    elements.eventList.append(li);
  }
  elements.eventCount.textContent = String(recentEvents.length);
}

function renderCounters() {
  const status = session.status;
  elements.fragmentCount.textContent = String(status.fragmentsReceived);
  elements.duplicateCount.textContent = String(status.duplicatesIgnored + status.redundantFragments);
  elements.invalidCount.textContent = String(status.invalidUris);
  elements.qrCount.textContent = String(decodedQrCount);
  elements.decodeProgress.value = status.progress;
  elements.progressLabel.textContent = `${Math.round(status.progress * 100)} %`;
}

function resetSession() {
  session.reset();
  decodedQrCount = 0;
  completedFile = null;
  recentEvents = [];
  elements.eventList.innerHTML = '<li class="empty-event">Noch keine QR-Codes erkannt.</li>';
  elements.eventCount.textContent = '0';
  elements.resultEmpty.hidden = false;
  elements.resultContent.hidden = true;
  elements.filenameInput.value = 'recovered.bin';
  elements.downloadButton.disabled = true;
  setTransferState('Warte auf UR-Fragmente', 'Richte die Kamera auf einen MUR-QR-Code.');
  renderCounters();
}

function isSecureCameraContext() {
  return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  const oldValue = selectedCameraId || elements.cameraSelect.value;
  elements.cameraSelect.replaceChildren();
  cameras.forEach((camera, index) => {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Kamera ${index + 1}`;
    elements.cameraSelect.append(option);
  });
  if (oldValue && cameras.some((camera) => camera.deviceId === oldValue)) {
    elements.cameraSelect.value = oldValue;
  } else if (cameras.length) {
    const rear = cameras.find((camera) => /back|rear|environment|rück|hinten/i.test(camera.label));
    elements.cameraSelect.value = (rear || cameras[0]).deviceId;
  }
  selectedCameraId = elements.cameraSelect.value;
  elements.cameraSelect.disabled = cameras.length < 2;
}

async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Dieser Browser stellt keinen Kamerazugriff über getUserMedia bereit.');
  }
  if (!isSecureCameraContext()) {
    throw new Error('Der Kamerazugriff benötigt HTTPS oder localhost.');
  }

  const constraints = selectedCameraId
    ? { deviceId: { exact: selectedCameraId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
  } catch (firstError) {
    try {
      const fallback = selectedCameraId ? { deviceId: { exact: selectedCameraId } } : { facingMode: 'environment' };
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: fallback });
    } catch {
      throw firstError;
    }
  }
}

function updateTorchAvailability() {
  const track = mediaStream?.getVideoTracks?.()[0];
  let supportsTorch = false;
  try {
    const capabilities = track?.getCapabilities?.();
    supportsTorch = Boolean(capabilities && 'torch' in capabilities);
  } catch {
    supportsTorch = false;
  }
  elements.torchButton.disabled = !supportsTorch;
  elements.torchButton.classList.toggle('torch-active', torchOn);
}

async function toggleTorch() {
  const track = mediaStream?.getVideoTracks?.()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
    torchOn = !torchOn;
    updateTorchAvailability();
  } catch (error) {
    addEvent(`Blitzlicht nicht verfügbar: ${error.message}`, 'warning');
  }
}

function stopCamera() {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  animationFrameId = 0;
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  elements.video.pause();
  elements.video.srcObject = null;
  elements.videoPlaceholder.hidden = false;
  elements.resolutionLabel.textContent = 'Kein Videostream';
  elements.scanRateLabel.textContent = 'Scanner inaktiv';
  elements.startButton.disabled = false;
  elements.stopButton.disabled = true;
  elements.cameraSelect.disabled = false;
  elements.torchButton.disabled = true;
  torchOn = false;
  setCameraState('Bereit', 'idle');
}

async function startCamera() {
  elements.startButton.disabled = true;
  setCameraState('Verbinde …', 'starting');
  try {
    mediaStream = await requestCamera();
    elements.video.srcObject = mediaStream;
    await elements.video.play();
    elements.videoPlaceholder.hidden = true;
    elements.stopButton.disabled = false;
    elements.cameraSelect.disabled = true;
    const trackSettings = mediaStream.getVideoTracks()[0]?.getSettings?.() || {};
    selectedCameraId = trackSettings.deviceId || selectedCameraId;
    elements.resolutionLabel.textContent = `${trackSettings.width || elements.video.videoWidth} × ${trackSettings.height || elements.video.videoHeight}`;
    setCameraState('Live', 'live');
    updateTorchAvailability();
    await listCameras();
    addEvent('Kamera gestartet.', 'normal');
    lastFrameAt = 0;
    animationFrameId = requestAnimationFrame(scanLoop);
  } catch (error) {
    stopCamera();
    setCameraState('Kamerafehler', 'error');
    addEvent(error.message || 'Kamera konnte nicht gestartet werden.', 'error');
    setTransferState('Kamera nicht verfügbar', error.message || 'Bitte Berechtigung und Verbindung prüfen.', 'error');
  }
}

function submitFrame(timestamp) {
  if (workerBusy || !canvasContext || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
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

  canvasContext.drawImage(elements.video, 0, 0, width, height);
  const imageData = canvasContext.getImageData(0, 0, width, height);
  workerBusy = true;
  frameId += 1;
  qrWorker.postMessage({ type: 'scan-frame', frameId, width, height, pixels: imageData.data.buffer }, [imageData.data.buffer]);
  framesInWindow += 1;
  if (!lastRateUpdate) lastRateUpdate = timestamp;
  if (timestamp - lastRateUpdate >= 1000) {
    elements.scanRateLabel.textContent = `${framesInWindow} Frames/s`;
    framesInWindow = 0;
    lastRateUpdate = timestamp;
  }
}

function scanLoop(timestamp) {
  if (!mediaStream) return;
  if (!session.complete && timestamp - lastFrameAt >= FRAME_INTERVAL_MS) {
    lastFrameAt = timestamp;
    submitFrame(timestamp);
  }
  animationFrameId = requestAnimationFrame(scanLoop);
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return 'Nicht verfügbar';
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function showCompletedFile(bytes) {
  completedFile = new Uint8Array(bytes);
  elements.resultEmpty.hidden = true;
  elements.resultContent.hidden = false;
  elements.fileSize.textContent = formatBytes(completedFile.byteLength);
  elements.filenameInput.value = 'recovered.bin';
  elements.hashValue.textContent = 'SHA-256 wird berechnet …';
  setTransferState('Datei vollständig rekonstruiert', `${formatBytes(completedFile.byteLength)} erfolgreich aus UR rekonstruiert.`, 'complete');
  addEvent(`Datei rekonstruiert (${formatBytes(completedFile.byteLength)}).`, 'success');
  try {
    elements.hashValue.textContent = await sha256Hex(completedFile);
  } catch {
    elements.hashValue.textContent = 'Nicht verfügbar';
  }
  elements.downloadButton.disabled = false;
  renderCounters();
}

function handleQrTexts(texts) {
  for (const text of texts) {
    decodedQrCount += 1;
    const result = session.add(text);
    if (result.kind === 'fragment') {
      const progress = Math.round(result.status.progress * 100);
      setTransferState('MUR-Fragmente werden gesammelt', `${result.status.fragmentsReceived} Fragmente · ${progress} % Decodierfortschritt`, 'receiving');
      addEvent(`MUR-Fragment empfangen (${result.status.fragmentsReceived}).`, 'normal');
    } else if (result.kind === 'redundant') {
      // The fountain decoder received a valid fragment that added no new rank.
    } else if (result.kind === 'duplicate') {
      // Repeated camera detections are expected; do not flood the event log.
    } else if (result.kind === 'invalid') {
      addEvent(`UR verworfen: ${result.message}`, 'warning');
      if (!session.complete) setTransferState('Ungültige UR erkannt', result.message, 'error');
    } else if (result.kind === 'complete' && result.bytes) {
      void showCompletedFile(result.bytes);
    }
  }
  renderCounters();
}

qrWorker.addEventListener('message', (event) => {
  const message = event.data;
  workerBusy = false;
  if (message?.type === 'scan-result') {
    handleQrTexts(message.texts || []);
  } else if (message?.type === 'scan-error') {
    addEvent(`QR-Erkennung: ${message.message}`, 'warning');
  }
});

qrWorker.addEventListener('error', (event) => {
  workerBusy = false;
  addEvent(`Scanner-Worker fehlgeschlagen: ${event.message}`, 'error');
  setTransferState('QR-Scanner fehlgeschlagen', 'Bitte Seite neu laden oder Browser prüfen.', 'error');
});

elements.startButton.addEventListener('click', () => void startCamera());
elements.stopButton.addEventListener('click', stopCamera);
elements.resetButton.addEventListener('click', resetSession);
elements.torchButton.addEventListener('click', () => void toggleTorch());
elements.cameraSelect.addEventListener('change', async () => {
  selectedCameraId = elements.cameraSelect.value;
  if (mediaStream) {
    stopCamera();
    await startCamera();
  }
});
elements.downloadButton.addEventListener('click', () => {
  if (!completedFile) return;
  const safeName = (elements.filenameInput.value || 'recovered.bin').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'recovered.bin';
  const blob = new Blob([completedFile], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

window.addEventListener('pagehide', stopCamera);
resetSession();
