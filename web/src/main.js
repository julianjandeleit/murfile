import { FileDecoder } from '../../src/index.js';
import { populateCameraSelect, requestCameraStream } from '../../src/browser/camera.js';
import { AdaptiveScanResolution } from '../../src/browser/adaptive-scan-resolution.js';
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
  pageProgressLabel: $('pageProgressLabel'),
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
const adaptiveScanResolution = new AdaptiveScanResolution();
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
  elements.invalidCount.textContent = String(status.invalidFrames);
  elements.qrCount.textContent = String(decodedQrCount);
  elements.decodeProgress.value = status.progress;
  elements.progressLabel.textContent = `${Math.round(status.progress * 100)} %`;
  elements.pageProgressLabel.hidden = status.pageCount === null;
  if (status.pageCount !== null) {
    elements.pageProgressLabel.textContent = `Seiten rekonstruiert: ${status.completedPages} / ${status.pageCount} · ` +
      `${status.missingPages.length} noch offen · ${status.activeSessions} aktive Sessions`;
  }
}

function resetSession() {
  session.reset();
  decodedQrCount = 0;
  completedFile = null;
  recentEvents = [];
  elements.eventList.innerHTML = '<li class="empty-event">Noch keine QR-Codes erkannt.</li>';
  elements.eventCount.textContent = '0';
  elements.pageProgressLabel.hidden = true;
  elements.pageProgressLabel.textContent = '';
  elements.resultEmpty.hidden = false;
  elements.resultContent.hidden = true;
  elements.filenameInput.value = 'recovered.bin';
  elements.downloadButton.disabled = true;
  setTransferState('Warte auf MQR1-Frames', 'Richte die Kamera auf einen MQR1-QR-Code.');
  renderCounters();
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
    const camera = await requestCameraStream(selectedCameraId, {
      unavailableMessage: 'Dieser Browser stellt keinen Kamerazugriff über getUserMedia bereit.',
      insecureMessage: 'Der Kamerazugriff benötigt HTTPS oder localhost.',
    });
    mediaStream = camera.stream;
    adaptiveScanResolution.reset();
    elements.video.srcObject = mediaStream;
    await elements.video.play();
    elements.videoPlaceholder.hidden = true;
    elements.stopButton.disabled = false;
    elements.cameraSelect.disabled = true;
    const trackSettings = mediaStream.getVideoTracks()[0]?.getSettings?.() || {};
    selectedCameraId = trackSettings.deviceId || selectedCameraId;
    const actualWidth = camera.resolution.width || trackSettings.width || elements.video.videoWidth;
    const actualHeight = camera.resolution.height || trackSettings.height || elements.video.videoHeight;
    const maximum = camera.resolution.maxWidth && camera.resolution.maxHeight
      ? ` · Max. ${camera.resolution.maxWidth} × ${camera.resolution.maxHeight}`
      : '';
    elements.resolutionLabel.textContent =
      `${actualWidth} × ${actualHeight}${maximum}${camera.resolution.warning ? ` · ${camera.resolution.warning}` : ''}`;
    setCameraState('Live', 'live');
    updateTorchAvailability();
    selectedCameraId = await populateCameraSelect(elements.cameraSelect, selectedCameraId, {
      cameraLabel: 'Kamera',
    });
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

  const scan = adaptiveScanResolution.next(sourceWidth);
  const width = scan.width;
  const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  canvasContext.drawImage(elements.video, 0, 0, width, height);
  const imageData = canvasContext.getImageData(0, 0, width, height);
  workerBusy = true;
  frameId += 1;
  qrWorker.postMessage({
    type: 'scan-frame',
    frameId,
    width,
    height,
    sourceWidth,
    isHighResolutionProbe: scan.isHighResolutionProbe,
    pixels: imageData.data.buffer,
  }, [imageData.data.buffer]);
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
  setTransferState('Datei vollständig rekonstruiert', `${formatBytes(completedFile.byteLength)} bytegenau aus MQR1 rekonstruiert.`, 'complete');
  addEvent(`Datei rekonstruiert (${formatBytes(completedFile.byteLength)}).`, 'success');
  try {
    const actualHash = await sha256Hex(completedFile);
    const expectedHash = session.status.expectedSha256;
    if (expectedHash && actualHash !== 'Nicht verfügbar' && actualHash !== expectedHash) {
      completedFile = null;
      setTransferState('Integritätsprüfung fehlgeschlagen', 'Der SHA-256-Hash stimmt nicht mit den Seitendaten überein.', 'error');
      addEvent('Datei-Hash stimmt nicht überein; Download gesperrt.', 'error');
      elements.hashValue.textContent = 'Hash stimmt nicht überein';
      renderCounters();
      return;
    }
    elements.hashValue.textContent = actualHash;
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
      const detail = result.status.pageCount !== null
        ? `${result.status.completedPages}/${result.status.pageCount} Seiten vollständig · ${progress} %`
        : `${result.status.fragmentsReceived} Fragmente · ${progress} % Decodierfortschritt`;
      setTransferState('MQR1-Frames werden gesammelt', detail, 'receiving');
      addEvent(`MQR1-Frame empfangen (${result.status.fragmentsReceived}).`, 'normal');
    } else if (result.kind === 'page-complete') {
      setTransferState(
        'Seite rekonstruiert',
        `Seite ${result.pageIndex + 1} von ${result.pageCount} vollständig.`,
        'receiving',
      );
      addEvent(`Seite ${result.pageIndex + 1}/${result.pageCount} rekonstruiert.`, 'success');
    } else if (result.kind === 'redundant' || result.kind === 'duplicate' || result.kind === 'duplicate-page') {
      // Repeated camera detections and already completed pages are expected.
    } else if (result.kind === 'invalid') {
      addEvent(`MQR1-Frame verworfen: ${result.message}`, 'warning');
      if (!session.complete) setTransferState('Ungültiger MQR1-Frame', result.message, 'error');
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
    adaptiveScanResolution.observe({
      sourceWidth: message.sourceWidth,
      scanWidth: message.scanWidth,
      isHighResolutionProbe: message.isHighResolutionProbe,
      symbolCount: message.totalSymbols,
      smallestSymbolSide: message.smallestSymbolSide,
    });
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
