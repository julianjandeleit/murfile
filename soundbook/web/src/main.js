import { SoundbookDecoder } from '../../../src/soundbook-decoder.js';
import { completeOggPrefixLength } from '../../../src/ogg-stream.js';
import { populateCameraSelect, requestCameraStream } from '../../../src/browser/camera.js';
import { AdaptiveScanResolution } from '../../../src/browser/adaptive-scan-resolution.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const elements = {
  video: $('video'),
  videoPlaceholder: $('videoPlaceholder'),
  cameraSelect: $('cameraSelect'),
  cameraResolution: $('cameraResolution'),
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
  playbackButton: $('playbackButton'),
  audioStatus: $('audioStatus'),
  downloadButton: $('downloadButton'),
};

const decoder = new SoundbookDecoder();
const adaptiveScanResolution = new AdaptiveScanResolution();
const supportsOggOpus = Boolean(
  document.createElement('audio').canPlayType('audio/ogg; codecs="opus"'),
);
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
const qrWorker = new Worker(new URL('../../../web/src/workers/qr-worker.js', import.meta.url), { type: 'module' });
const FRAME_INTERVAL_MS = 190;

let mediaStream;
let animationFrameId = 0;
let lastFrameAt = 0;
let frameId = 0;
let workerBusy = false;
let selectedCameraId = '';
let decodedQrCount = 0;
const audioSegments = new Map();
const audioChunks = new Map();
const audioObjectUrls = new Set();
let playbackMode = null;
let currentPageIndex = null;
let nextPageIndex = 0;
let waitingForPageIndex = null;
let playbackSegmentCount = 0;
let progressivePlayableBytes = new Uint8Array(0);
let progressiveSourceLength = 0;
let progressiveObjectUrl = null;
let progressivePlaybackTime = 0;
let progressiveFinished = false;
let playbackRequested = false;
let playbackError = '';
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

function updatePlaybackUi(status) {
  if (status.format === 'SOUNDBOOK-3' || status.format === 'SOUNDBOOK-4') {
    elements.playbackButton.hidden = status.pageCount === null;
    elements.playbackButton.disabled = !supportsOggOpus || progressivePlayableBytes.byteLength === 0;
    elements.playbackButton.textContent = playbackRequested ? 'Pause playback'
      : progressiveFinished ? 'Play again'
        : status.contiguousPageCount > 0 ? 'Play / resume' : 'Play audio';

    if (playbackError) {
      elements.audioStatus.textContent = playbackError;
    } else if (!supportsOggOpus) {
      elements.audioStatus.textContent =
        'This browser does not report Ogg Opus playback support. The original file can still be downloaded after all pages are verified.';
    } else if (waitingForPageIndex !== null) {
      elements.audioStatus.textContent =
        `Playback is waiting at page ${waitingForPageIndex + 1}; scan that page to continue.`;
    } else if (playbackRequested) {
      elements.audioStatus.textContent = `Playing the verified contiguous Ogg prefix (${progressivePlayableBytes.byteLength.toLocaleString()} bytes).`;
    } else if (progressiveFinished) {
      elements.audioStatus.textContent = 'Playback finished. Press Play again to replay the original audio.';
    } else if (progressivePlayableBytes.byteLength > 0) {
      elements.audioStatus.textContent =
        `Ready to play ${progressivePlayableBytes.byteLength.toLocaleString()} contiguous Ogg bytes. Playback waits at any missing page.`;
    } else {
      elements.audioStatus.textContent =
        'Waiting for the first complete Ogg page from page 1 before playback is available.';
    }
    return;
  }

  const finished = status.complete && playbackSegmentCount > 0 &&
    nextPageIndex >= playbackSegmentCount && currentPageIndex === null;
  elements.playbackButton.hidden = status.pageCount === null;
  elements.playbackButton.disabled = status.pageCount === null ||
    (status.format === 'SOUNDBOOK-1' && !status.complete);
  elements.playbackButton.textContent = playbackRequested ? 'Pause playback'
    : finished ? 'Play again' : nextPageIndex > 0 ? 'Resume playback' : 'Play audio';

  if (playbackError) {
    elements.audioStatus.textContent = playbackError;
  } else if (waitingForPageIndex !== null) {
    elements.audioStatus.textContent =
      `Waiting for page ${waitingForPageIndex + 1}; playback will resume when it is scanned.`;
  } else if (currentPageIndex !== null && playbackRequested) {
    elements.audioStatus.textContent = `Playing segment ${currentPageIndex + 1} of ${playbackSegmentCount}.`;
  } else if (currentPageIndex !== null) {
    elements.audioStatus.textContent = `Paused at segment ${currentPageIndex + 1}. Press Resume playback to continue.`;
  } else if (status.complete && nextPageIndex >= playbackSegmentCount && playbackSegmentCount > 0) {
    elements.audioStatus.textContent = 'Playback finished. Press Play audio to start again.';
  } else if (audioSegments.has(nextPageIndex)) {
    elements.audioStatus.textContent = `Segment ${nextPageIndex + 1} is ready. Press Play or Resume; playback will pause at missing pages.`;
  } else if (status.pageCount !== null) {
    elements.audioStatus.textContent = status.format === 'SOUNDBOOK-1' && !status.complete
      ? 'This legacy book stores one Ogg stream across pages; playback becomes available after every page is recovered.'
      : `Waiting for playable page ${nextPageIndex + 1}. Playback will begin when that page is recovered.`;
  } else {
    elements.audioStatus.textContent =
      'Scan pages in order; playback becomes available after the first complete Ogg page is recovered.';
  }
}

function startAudioSegment(pageIndex) {
  const url = audioSegments.get(pageIndex);
  if (!url) {
    waitingForPageIndex = pageIndex;
    updatePlaybackUi(decoder.status);
    return;
  }

  waitingForPageIndex = null;
  currentPageIndex = pageIndex;
  nextPageIndex = pageIndex + 1;
  playbackError = '';
  elements.audioPlayer.src = url;
  elements.audioPlayer.load();
  const playRequest = elements.audioPlayer.play();
  if (playRequest) {
    playRequest.catch((error) => {
      playbackRequested = false;
      currentPageIndex = null;
      nextPageIndex = pageIndex;
      playbackError = `Playback could not start: ${error.message}. Press Play audio to try again.`;
      updatePlaybackUi(decoder.status);
    });
  }
}

function addAudioSegment(pageIndex, pageCount, bytes) {
  playbackMode = 'segments';
  if (!audioSegments.has(pageIndex)) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/ogg; codecs=opus' }));
    audioSegments.set(pageIndex, url);
    audioObjectUrls.add(url);
  }
  playbackSegmentCount = pageCount;
  if (waitingForPageIndex === pageIndex && playbackRequested) {
    startAudioSegment(pageIndex);
  }
}

function addAudioChunk(pageIndex, bytes) {
  playbackMode = 'progressive';
  if (!audioChunks.has(pageIndex)) audioChunks.set(pageIndex, bytes.slice());

  const contiguousChunks = [];
  for (let index = 0; audioChunks.has(index); index += 1) {
    contiguousChunks.push(audioChunks.get(index));
  }
  const contiguousLength = contiguousChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const contiguousBytes = new Uint8Array(contiguousLength);
  let offset = 0;
  for (const chunk of contiguousChunks) {
    contiguousBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const completeLength = completeOggPrefixLength(contiguousBytes);
  progressivePlayableBytes = decoder.complete
    ? decoder.result
    : contiguousBytes.slice(0, completeLength);

  if (playbackRequested && waitingForPageIndex !== null &&
      progressivePlayableBytes.byteLength > progressiveSourceLength) {
    startProgressivePlayback(progressivePlaybackTime);
  }
}

function startProgressivePlayback(resumeAt = 0) {
  if (progressivePlayableBytes.byteLength === 0) {
    waitingForPageIndex = decoder.status.contiguousPageCount;
    updatePlaybackUi(decoder.status);
    return;
  }

  waitingForPageIndex = null;
  playbackError = '';
  progressiveFinished = false;
  const replaceSource = !progressiveObjectUrl ||
    progressiveSourceLength !== progressivePlayableBytes.byteLength;
  if (replaceSource) {
    elements.audioPlayer.pause();
    if (progressiveObjectUrl) {
      URL.revokeObjectURL(progressiveObjectUrl);
      audioObjectUrls.delete(progressiveObjectUrl);
    }
    progressiveObjectUrl = URL.createObjectURL(
      new Blob([progressivePlayableBytes], { type: 'audio/ogg; codecs=opus' }),
    );
    audioObjectUrls.add(progressiveObjectUrl);
    progressiveSourceLength = progressivePlayableBytes.byteLength;
    elements.audioPlayer.src = progressiveObjectUrl;
    elements.audioPlayer.load();
    elements.audioPlayer.addEventListener('loadedmetadata', () => {
      if (resumeAt > 0) {
        const duration = elements.audioPlayer.duration;
        elements.audioPlayer.currentTime = Number.isFinite(duration)
          ? Math.min(resumeAt, Math.max(0, duration - 0.05))
          : resumeAt;
        if (playbackRequested) playProgressiveSource();
      }
    }, { once: true });
    if (resumeAt === 0 && playbackRequested) playProgressiveSource();
  } else {
    playProgressiveSource();
  }
}

function playProgressiveSource() {
  const playRequest = elements.audioPlayer.play();
  if (playRequest) {
    playRequest.catch((error) => {
      playbackRequested = false;
      playbackError = `Playback could not start: ${error.message}. Press Play audio to try again.`;
      updatePlaybackUi(decoder.status);
    });
  }
}

function onAudioEnded() {
  if (playbackMode === 'progressive') {
    progressivePlaybackTime = elements.audioPlayer.currentTime || progressivePlaybackTime;
    if (!playbackRequested) return;
    if (progressivePlayableBytes.byteLength > progressiveSourceLength) {
      startProgressivePlayback(progressivePlaybackTime);
    } else if (decoder.complete) {
      playbackRequested = false;
      progressiveFinished = true;
      waitingForPageIndex = null;
    } else {
      waitingForPageIndex = decoder.status.contiguousPageCount;
    }
    updatePlaybackUi(decoder.status);
    return;
  }
  if (currentPageIndex === null) return;
  currentPageIndex = null;
  const nextIndex = nextPageIndex;
  if (nextIndex >= playbackSegmentCount) {
    playbackRequested = false;
    waitingForPageIndex = null;
  } else if (audioSegments.has(nextIndex)) {
    if (playbackRequested) startAudioSegment(nextIndex);
  } else {
    waitingForPageIndex = nextIndex;
  }
  updatePlaybackUi(decoder.status);
}

function renderStatus() {
  const status = decoder.status;
  elements.pageCount.textContent = status.pageCount === null
    ? '0 / ?'
    : `${status.completedPages} / ${status.pageCount}`;
  elements.activeCount.textContent = String(status.activeSessions.length);
  elements.fragmentCount.textContent = String(status.fragmentsReceived);
  elements.qrCount.textContent = String(decodedQrCount);
  elements.errorCount.textContent = `${status.duplicatesIgnored + status.redundantFragments} / ${status.invalidFrames}`;

  if (status.pageCount === null) {
    elements.pageList.innerHTML = '<span class="muted">Page details will appear after the first page is validated.</span>';
    elements.statusTitle.textContent = status.activeSessions.length
      ? 'Collecting fragments for an unknown page'
      : 'Waiting for Soundbook pages';
    elements.statusDetail.textContent = status.activeSessions.length
      ? 'The Soundbook page identity is confirmed only when its page code reconstructs.'
      : 'Playback starts from the first complete Ogg page and waits whenever a contiguous page is missing.';
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
      const description = status.format === 'SOUNDBOOK-3' || status.format === 'SOUNDBOOK-4'
        ? 'byte-identical original Ogg Opus bytes'
        : 'chained Ogg bytes';
      elements.statusDetail.textContent = `Book ${status.bookId} · ${status.audioBytes.toLocaleString()} ${description} · ` +
        `${(status.audioDurationMicros / 1_000_000).toFixed(1)} seconds. All pages are verified.`;
    } else {
      elements.statusTitle.textContent = `Waiting for page ${nextMissing + 1}`;
      if (status.format === 'SOUNDBOOK-1') {
        elements.statusDetail.textContent =
          `${status.completedPages} of ${status.pageCount} legacy pages complete. Playback waits for the full Ogg stream.`;
      } else if (status.format === 'SOUNDBOOK-3' || status.format === 'SOUNDBOOK-4') {
        elements.statusDetail.textContent =
          `${status.completedPages} of ${status.pageCount} pages complete; ` +
          `${status.missingPages.length} page(s) remain. ${status.contiguousPageCount} page(s) from the start are contiguous. ` +
          `Playback uses only complete Ogg pages and waits at gaps. Expected audio: ` +
          `${(status.audioDurationMicros / 1_000_000).toFixed(1)} seconds.` +
          (lastScanError ? ` Last scan issue: ${lastScanError}` : '');
      } else {
        elements.statusDetail.textContent =
          `${status.completedPages} of ${status.pageCount} pages complete. ` +
          `${status.missingPages.length} page(s) remain. Each page is an independent Ogg segment; playback waits at missing pages. ` +
          `Expected audio: ${(status.audioDurationMicros / 1_000_000).toFixed(1)} seconds.` +
          (lastScanError ? ` Last scan issue: ${lastScanError}` : '');
      }
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
    elements.downloadButton.hidden = false;
    elements.downloadButton.disabled = false;
  } else {
    elements.downloadButton.hidden = true;
    elements.downloadButton.disabled = true;
  }
  updatePlaybackUi(status);
}

async function startCamera() {
  const camera = await requestCameraStream(selectedCameraId);
  mediaStream = camera.stream;
  adaptiveScanResolution.reset();
  elements.video.srcObject = mediaStream;
  await elements.video.play();
  elements.videoPlaceholder.hidden = true;
  elements.startButton.disabled = true;
  elements.stopButton.disabled = false;
  elements.cameraSelect.disabled = true;
  setCameraState('Scanning', true);
  const actualWidth = camera.resolution.width || elements.video.videoWidth;
  const actualHeight = camera.resolution.height || elements.video.videoHeight;
  const maximum = camera.resolution.maxWidth && camera.resolution.maxHeight
    ? ` (max ${camera.resolution.maxWidth}×${camera.resolution.maxHeight})`
    : '';
  elements.cameraResolution.textContent =
    `Scanning at ${actualWidth}×${actualHeight}${maximum}${camera.resolution.warning ? ` — ${camera.resolution.warning}` : ''}`;
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
  const scan = adaptiveScanResolution.next(sourceWidth);
  const width = scan.width;
  const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
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
    sourceWidth,
    isHighResolutionProbe: scan.isHighResolutionProbe,
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
      if (result.chunkBytes) {
        addAudioChunk(result.pageIndex, result.chunkBytes);
      } else if (result.segmentBytes) {
        addAudioSegment(result.playbackPageIndex, result.playbackPageCount, result.segmentBytes);
      }
    } else if (result.kind === 'book-complete') {
      lastScanError = '';
      if (result.chunkBytes) {
        addAudioChunk(result.pageIndex, result.chunkBytes);
      } else {
        addAudioSegment(result.playbackPageIndex, result.playbackPageCount, result.segmentBytes);
      }
      elements.statusTitle.textContent = 'All pages reconstructed and verified';
    }
  }
  renderStatus();
}

qrWorker.addEventListener('message', (event) => {
  workerBusy = false;
  if (event.data?.type === 'scan-result') {
    adaptiveScanResolution.observe({
      sourceWidth: event.data.sourceWidth,
      scanWidth: event.data.scanWidth,
      isHighResolutionProbe: event.data.isHighResolutionProbe,
      symbolCount: event.data.totalSymbols,
      smallestSymbolSide: event.data.smallestSymbolSide,
    });
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
elements.audioPlayer.addEventListener('ended', onAudioEnded);
elements.audioPlayer.addEventListener('timeupdate', () => {
  if (playbackMode === 'progressive' && Number.isFinite(elements.audioPlayer.currentTime)) {
    progressivePlaybackTime = elements.audioPlayer.currentTime;
  }
});
elements.playbackButton.addEventListener('click', () => {
  playbackError = '';
  if (playbackRequested) {
    if (playbackMode === 'progressive' && Number.isFinite(elements.audioPlayer.currentTime)) {
      progressivePlaybackTime = elements.audioPlayer.currentTime;
    }
    playbackRequested = false;
    elements.audioPlayer.pause();
    updatePlaybackUi(decoder.status);
    return;
  }

  if (playbackMode === 'progressive') {
    if (progressiveFinished) {
      progressivePlaybackTime = 0;
      elements.audioPlayer.currentTime = 0;
    }
    playbackRequested = true;
    startProgressivePlayback(progressivePlaybackTime);
    updatePlaybackUi(decoder.status);
    return;
  }

  if (decoder.complete && playbackSegmentCount > 0 && nextPageIndex >= playbackSegmentCount) {
    nextPageIndex = 0;
    waitingForPageIndex = null;
  }
  playbackRequested = true;
  if (currentPageIndex !== null && !elements.audioPlayer.ended) {
    const playRequest = elements.audioPlayer.play();
    if (playRequest) {
      playRequest.catch((error) => {
        playbackRequested = false;
        playbackError = `Playback could not resume: ${error.message}. Press Play audio to try again.`;
        updatePlaybackUi(decoder.status);
      });
    }
    updatePlaybackUi(decoder.status);
    return;
  }

  const pageIndex = waitingForPageIndex ?? nextPageIndex;
  if (audioSegments.has(pageIndex)) {
    startAudioSegment(pageIndex);
  } else {
    waitingForPageIndex = pageIndex;
    updatePlaybackUi(decoder.status);
  }
});
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
  playbackRequested = false;
  currentPageIndex = null;
  nextPageIndex = 0;
  waitingForPageIndex = null;
  playbackSegmentCount = 0;
  playbackMode = null;
  audioChunks.clear();
  progressivePlayableBytes = new Uint8Array(0);
  progressiveSourceLength = 0;
  progressiveObjectUrl = null;
  progressivePlaybackTime = 0;
  progressiveFinished = false;
  playbackError = '';
  elements.audioPlayer.pause();
  elements.audioPlayer.removeAttribute('src');
  elements.audioPlayer.load();
  for (const url of audioObjectUrls) URL.revokeObjectURL(url);
  audioObjectUrls.clear();
  audioSegments.clear();
  renderStatus();
});
elements.downloadButton.addEventListener('click', () => {
  const bytes = decoder.result;
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/ogg; codecs=opus' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'soundbook.opus';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => {
  stopCamera();
  for (const url of audioObjectUrls) URL.revokeObjectURL(url);
});
renderStatus();
