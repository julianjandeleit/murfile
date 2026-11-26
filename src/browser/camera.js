export async function populateCameraSelect(select, selectedCameraId = '', { cameraLabel = 'Camera' } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) return selectedCameraId;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  const oldValue = selectedCameraId || select.value;
  select.replaceChildren();
  cameras.forEach((camera, index) => {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `${cameraLabel} ${index + 1}`;
    select.append(option);
  });
  if (oldValue && cameras.some((camera) => camera.deviceId === oldValue)) {
    select.value = oldValue;
  } else if (cameras.length) {
    const rear = cameras.find((camera) => /back|rear|environment|rück|hinten/i.test(camera.label));
    select.value = (rear || cameras[0]).deviceId;
  }
  select.disabled = cameras.length < 2;
  return select.value;
}

export async function requestCameraStream(selectedCameraId = '', {
  unavailableMessage = 'This browser does not provide camera access through getUserMedia.',
  insecureMessage = 'Camera access requires HTTPS or localhost.',
} = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(unavailableMessage);
  }
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    throw new Error(insecureMessage);
  }

  const constraints = selectedCameraId
    ? {
      deviceId: { exact: selectedCameraId },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    }
    : {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
  } catch (firstError) {
    try {
      const fallback = selectedCameraId
        ? { deviceId: { exact: selectedCameraId } }
        : { facingMode: { ideal: 'environment' } };
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: fallback });
    } catch (fallbackError) {
      throw new AggregateError(
        [firstError, fallbackError],
        `Could not start the selected camera at its best available resolution: ${fallbackError.message}`,
      );
    }
  }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error('The selected media source did not provide a video track.');
  }
  const capabilities = track.getCapabilities?.();
  const current = track.getSettings?.() ?? {};
  const maxWidth = capabilities?.width?.max;
  const maxHeight = capabilities?.height?.max;
  const candidates = new Map();
  const addCandidate = (width, height) => {
    const w = Math.floor(width / 2) * 2;
    const h = Math.floor(height / 2) * 2;
    if (w >= (capabilities?.width?.min ?? 1) &&
        h >= (capabilities?.height?.min ?? 1) &&
        (!Number.isFinite(maxWidth) || w <= maxWidth) &&
        (!Number.isFinite(maxHeight) || h <= maxHeight)) {
      candidates.set(`${w}x${h}`, { width: w, height: h });
    }
  };
  if (Number.isFinite(maxWidth) && Number.isFinite(maxHeight)) {
    addCandidate(maxWidth, maxHeight);
    for (const aspect of [
      current.width && current.height ? current.width / current.height : 16 / 9,
      16 / 9,
      4 / 3,
      3 / 2,
    ]) {
      const width = Math.min(maxWidth, maxHeight * aspect);
      addCandidate(width, width / aspect);
    }
    for (const [width, height] of [
      [7680, 4320], [4096, 2160], [3840, 2160], [2560, 1440],
      [1920, 1080], [1280, 720], [640, 480],
    ]) {
      addCandidate(width, height);
    }
  }

  const resolutionCandidates = [...candidates.values()]
    .filter(({ width, height }) => width !== current.width || height !== current.height)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  let resolutionWarning = '';
  if (resolutionCandidates.length && typeof track.applyConstraints !== 'function') {
    resolutionWarning = 'This browser cannot request a higher camera resolution.';
  }
  for (const candidate of resolutionCandidates) {
    if (typeof track.applyConstraints !== 'function') break;
    try {
      await track.applyConstraints({
        width: { exact: candidate.width },
        height: { exact: candidate.height },
      });
      break;
    } catch (error) {
      if (error?.name !== 'OverconstrainedError' && error?.name !== 'NotSupportedError') {
        stream.getTracks().forEach((item) => item.stop());
        throw error;
      }
      resolutionWarning = `Could not select ${candidate.width}×${candidate.height}; trying the next supported resolution.`;
    }
  }

  const settings = track.getSettings?.() ?? {};
  if (Number.isFinite(maxWidth) && Number.isFinite(maxHeight) &&
      settings.width < maxWidth && settings.height < maxHeight && !resolutionWarning) {
    resolutionWarning = 'The camera did not select its reported maximum resolution.';
  }
  const resolution = {
    width: settings.width ?? 0,
    height: settings.height ?? 0,
    maxWidth: Number.isFinite(maxWidth) ? maxWidth : null,
    maxHeight: Number.isFinite(maxHeight) ? maxHeight : null,
    warning: resolutionWarning,
  };
  return { stream, resolution };
}
