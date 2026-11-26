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
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 24, max: 30 },
    }
    : {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 24, max: 30 },
    };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
  } catch (firstError) {
    try {
      const fallback = selectedCameraId
        ? { deviceId: { exact: selectedCameraId } }
        : { facingMode: 'environment' };
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: fallback });
    } catch {
      throw firstError;
    }
  }
}
