const API_BASE_URL = (() => {
  if (!window.location.hostname || window.location.protocol === "file:") {
    return "http://192.168.1.8:8000";
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:8000`;
})();
const MIN_DURATION_SEC = 3 * 60;
const MAX_DURATION_SEC = 15 * 60;

const token = localStorage.getItem("speakeasy_token");
const statusText = document.querySelector("[data-status-text]");
const recordTime = document.querySelector("[data-record-time]");
const controlTime = document.querySelector("[data-control-time]");
const progressBar = document.querySelector("[data-record-progress]");
const mainActionButton = document.querySelector("[data-main-record-action]");
const pauseButton = document.querySelector("[data-pause-record]");
const draftButton = document.querySelector("[data-save-draft]");
const processButton = document.querySelector("[data-process-record]");
const preview = document.querySelector("[data-audio-preview]");
const errorBox = document.querySelector("[data-record-error]");
const waveBars = [...document.querySelectorAll("[data-audio-wave] span")];
const audioHeading = document.querySelector("[data-audio-heading]");
const audioCopy = document.querySelector("[data-audio-copy]");
const selectedScenarioLabel = document.querySelector("[data-selected-scenario]");
const scenarioToggle = document.querySelector("[data-scenario-toggle]");
const scenarioMenu = document.querySelector("[data-scenario-menu]");
const scenarioOptions = document.querySelectorAll("[data-scenario-option]");
const notesInput = document.querySelector("[data-record-notes]");
const clearNotesButton = document.querySelector("[data-clear-notes]");
const audioPanel = document.querySelector("[data-audio-panel]");
const prepModal = document.querySelector("[data-prep-modal]");
const prepStartButton = document.querySelector("[data-prep-start]");
const prepCloseButtons = document.querySelectorAll("[data-prep-close]");
const countdownOptions = document.querySelectorAll("[data-countdown-option]");
const countdownOverlay = document.querySelector("[data-countdown-overlay]");
const countdownValue = document.querySelector("[data-countdown-value]");
const titleModal = document.querySelector("[data-title-modal]");
const titleForm = document.querySelector("[data-title-form]");
const titleInput = document.querySelector("[data-title-input]");
const titleError = document.querySelector("[data-title-error]");
const titleSubmitButton = document.querySelector("[data-title-submit]");
const titleCancelButtons = document.querySelectorAll("[data-title-cancel]");
const leaveModal = document.querySelector("[data-leave-modal]");
const leaveCancelButtons = document.querySelectorAll("[data-leave-cancel]");
const leaveConfirmButton = document.querySelector("[data-leave-confirm]");

let selectedScenario = localStorage.getItem("speakeasy_selected_scenario") || "presentation";
let selectedCountdown = Number(localStorage.getItem("speakeasy_audio_countdown") || "3");
let mediaRecorder = null;
let mediaStream = null;
let audioContext = null;
let analyser = null;
let animationFrame = null;
let timerId = null;
let startedAt = 0;
let elapsedBeforePause = 0;
let elapsedSeconds = 0;
let recordedChunks = [];
let recordedFile = null;
let recordingScenario = null;
let previewUrl = null;
let countdownTimerId = null;
let scenarioSelectionLocked = false;
let allowNavigation = false;
let titleResolver = null;
let pendingNavigationUrl = null;

if (!token) {
  window.location.href = "main.html";
}

const scenarioNames = {
  presentation: "Презентация",
  pitch: "Бизнес-питч",
  podcast: "Подкаст",
  free: "Свободная практика",
};

function setError(message) {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  document.body.dataset.recordState = state;
}

function setStageMessage(heading, copy) {
  if (audioHeading) audioHeading.textContent = heading;
  if (audioCopy) audioCopy.textContent = copy;
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function updateClock(seconds) {
  elapsedSeconds = seconds;
  const label = formatTime(seconds);
  if (recordTime) recordTime.textContent = label;
  controlTime.textContent = label;
  progressBar.style.width = `${Math.min(seconds / MAX_DURATION_SEC, 1) * 100}%`;
}

function isDurationValid(seconds) {
  return seconds >= MIN_DURATION_SEC && seconds <= MAX_DURATION_SEC;
}

function durationRangeWarning() {
  return `Запись должна длиться от 3 до 15 минут. Текущая длительность: ${formatTime(elapsedSeconds)}.`;
}

function setPauseButtonIcon(isPaused) {
  pauseButton.innerHTML = isPaused
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7-11-7Z" /></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14" /><path d="M16 5v14" /></svg>`;
}

function startTimer() {
  stopTimer();
  startedAt = Date.now();
  timerId = window.setInterval(() => {
    const seconds = elapsedBeforePause + (Date.now() - startedAt) / 1000;
    updateClock(seconds);
    if (seconds >= MAX_DURATION_SEC && mediaRecorder?.state === "recording") {
      stopRecording();
    }
  }, 250);
}

function stopTimer() {
  if (timerId) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

function resetRecording() {
  stopTimer();
  stopLevelMeter();
  recordedChunks = [];
  recordedFile = null;
  recordingScenario = null;
  elapsedBeforePause = 0;
  updateClock(0);
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  preview.hidden = true;
  preview.removeAttribute("src");
  draftButton.disabled = true;
  processButton.disabled = true;
  pauseButton.disabled = true;
  pauseButton.setAttribute("aria-label", "Пауза");
  setPauseButtonIcon(false);
  mainActionButton.textContent = "Начать запись";
  renderSelectedScenario();
  setStageMessage(
    "Готово к аудиопрактике",
    "Выберите тип практики, нажмите «Начать запись» и говорите в комфортном темпе."
  );
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fileExtensionForMime(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

function getRecordingSupportError(kind) {
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (!window.isSecureContext && !isLocalhost) {
    if (isMobile) {
      return `Запись ${kind} на телефоне через локальный IP требует HTTPS. Для проверки на компьютере откройте http://127.0.0.1:5500/frontend/record-audio.html.`;
    }

    return `Для записи ${kind} на этом компьютере откройте страницу через localhost: http://127.0.0.1:5500/frontend/record-audio.html. Сейчас открыто через ${window.location.host}.`;
  }

  return "";
}

function defaultRecordingTitle() {
  const scenarioTitle = scenarioNames[recordingScenario || selectedScenario] || "Практика";
  const timestamp = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  return `${scenarioTitle} ${timestamp}`;
}

function askRecordingTitle() {
  if (!titleModal || !titleInput) {
    return Promise.resolve(defaultRecordingTitle());
  }

  titleInput.value = defaultRecordingTitle();
  if (titleError) {
    titleError.hidden = true;
    titleError.textContent = "";
  }
  if (titleSubmitButton) {
    titleSubmitButton.textContent = "Сохранить";
  }

  titleModal.hidden = false;
  document.body.classList.add("modal-open");
  window.setTimeout(() => {
    titleInput.focus();
    titleInput.select();
  }, 0);

  return new Promise((resolve) => {
    titleResolver = resolve;
  });
}

function closeTitleModal(value = null) {
  if (!titleModal) {
    return;
  }

  titleModal.hidden = true;
  document.body.classList.remove("modal-open");

  if (titleResolver) {
    titleResolver(value);
    titleResolver = null;
  }
}

function submitTitleModal() {
  const trimmed = titleInput?.value.trim() || "";

  if (!trimmed) {
    if (titleError) {
      titleError.textContent = "Введите название записи.";
      titleError.hidden = false;
    }
    titleInput?.focus();
    return;
  }

  closeTitleModal(trimmed.slice(0, 120));
}

function normalizeAudioPreviewDuration() {
  const expectedDuration = elapsedSeconds;

  preview.addEventListener("loadedmetadata", () => {
    const durationLooksWrong =
      !Number.isFinite(preview.duration) ||
      preview.duration <= 0 ||
      Math.abs(preview.duration - expectedDuration) > 2;

    if (!durationLooksWrong) {
      return;
    }

    const restoreStart = () => {
      preview.removeEventListener("timeupdate", restoreStart);
      preview.currentTime = 0;
    };

    preview.addEventListener("timeupdate", restoreStart);
    preview.currentTime = Number.MAX_SAFE_INTEGER;
  }, { once: true });
}

async function startRecording() {
  scenarioSelectionLocked = true;
  renderSelectedScenario();
  setError("");

  const supportError = getRecordingSupportError("аудио");
  if (supportError) {
    setError(supportError);
    scenarioSelectionLocked = false;
    renderSelectedScenario();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setError("Браузер не поддерживает запись аудио. Попробуйте Chrome или Edge.");
    scenarioSelectionLocked = false;
    renderSelectedScenario();
    return;
  }

  resetRecording();
  recordingScenario = selectedScenario;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const mimeType = pickMimeType();
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    });
    mediaRecorder.addEventListener("stop", finalizeRecording);
    mediaRecorder.start(1000);

    startLevelMeter(mediaStream);
    startTimer();
    setStatus("Запись идет", "recording");
    setStageMessage(
      "Запись идет",
      "Следите за таймером в нижней панели. После остановки можно прослушать запись и отправить ее на анализ."
    );
    mainActionButton.textContent = "Стоп";
    pauseButton.disabled = false;
    scenarioSelectionLocked = false;
    renderSelectedScenario();
  } catch (error) {
    setStatus("Готово к записи аудио");
    setError(error.name === "NotAllowedError"
      ? "Разрешите доступ к микрофону, чтобы записать практику."
      : "Не удалось включить микрофон.");
    cleanupStream();
    scenarioSelectionLocked = false;
    renderSelectedScenario();
  }
}

function pauseRecording() {
  if (!mediaRecorder) return;

  if (mediaRecorder.state === "recording") {
    mediaRecorder.pause();
    elapsedBeforePause = elapsedSeconds;
    stopTimer();
    stopLevelMeter();
    setStatus("Запись на паузе", "paused");
    setStageMessage("Пауза", "Можно продолжить запись с того же места или остановить ее нижней кнопкой.");
    pauseButton.setAttribute("aria-label", "Продолжить");
    setPauseButtonIcon(true);
    mainActionButton.textContent = "Продолжить";
    return;
  }

  if (mediaRecorder.state === "paused") {
    mediaRecorder.resume();
    startTimer();
    if (mediaStream) startLevelMeter(mediaStream);
    setStatus("Запись идет", "recording");
    setStageMessage(
      "Запись идет",
      "Следите за таймером в нижней панели. После остановки можно прослушать запись и отправить ее на анализ."
    );
    pauseButton.setAttribute("aria-label", "Пауза");
    setPauseButtonIcon(false);
    mainActionButton.textContent = "Стоп";
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  elapsedBeforePause = elapsedSeconds;
  stopTimer();
  stopLevelMeter();
  setStatus("Готовим запись", "processing");
  setStageMessage("Готовим запись", "Собираем аудиофайл, чтобы его можно было прослушать или отправить на анализ.");
  pauseButton.disabled = true;
  mainActionButton.disabled = true;
  mediaRecorder.stop();
}

function finalizeRecording() {
  scenarioSelectionLocked = false;
  mainActionButton.disabled = false;
  mainActionButton.textContent = "Записать заново";
  renderSelectedScenario();

  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const extension = fileExtensionForMime(mimeType);
  const blob = new Blob(recordedChunks, { type: mimeType });
  recordedFile = new File([blob], `speakeasy-audio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${extension}`, {
    type: mimeType,
  });

  previewUrl = URL.createObjectURL(recordedFile);
  normalizeAudioPreviewDuration();
  preview.src = previewUrl;
  preview.hidden = false;
  draftButton.disabled = false;
  processButton.disabled = false;
  setStatus("Запись готова", "ready");
  setStageMessage(
    "Запись готова",
    "Прослушайте результат, сохраните черновик или запустите анализ аудиометрик."
  );

  if (!isDurationValid(elapsedSeconds)) {
    setError(durationRangeWarning());
    draftButton.disabled = true;
    processButton.disabled = true;
  }

  cleanupStream();
}

function cleanupStream() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  mediaRecorder = null;
}

function startLevelMeter(stream) {
  stopLevelMeter();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }
  audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const tick = () => {
    analyser.getByteFrequencyData(data);
    waveBars.forEach((bar, index) => {
      const bin = data[(index * 7) % data.length] || 0;
      const height = 18 + Math.min(78, bin / 2.8);
      bar.style.height = `${height}%`;
    });
    animationFrame = window.requestAnimationFrame(tick);
  };

  tick();
}

function stopLevelMeter() {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  audioContext?.close().catch(() => {});
  audioContext = null;
  analyser = null;
  waveBars.forEach((bar, index) => {
    bar.style.height = `${32 + ((index * 13) % 44)}%`;
  });
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    localStorage.removeItem("speakeasy_token");
    localStorage.removeItem("speakeasy_user");
    localStorage.removeItem("speakeasy_session_expires_at");
    allowNavigation = true;
    window.location.href = "main.html";
    return null;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || "Не удалось сохранить запись");
  }

  return response.json();
}

async function uploadRecordedAudio(mode) {
  if (!recordedFile) return;

  const recordingTitle = await askRecordingTitle();
  if (!recordingTitle) {
    return;
  }

  setError("");
  draftButton.disabled = true;
  processButton.disabled = true;
  mainActionButton.disabled = true;
  const activeButton = mode === "draft" ? draftButton : processButton;
  const previousText = activeButton.getAttribute("aria-label");
  activeButton.setAttribute("aria-label", mode === "draft" ? "Сохраняем" : "Обрабатываем");
  setStatus(mode === "draft" ? "Сохраняем черновик" : "Обрабатываем запись", "processing");
  setStageMessage(
    mode === "draft" ? "Сохраняем черновик" : "Запускаем анализ",
    mode === "draft" ? "Черновик появится в списке практик." : "Запись отправляется на обработку. Это может занять немного времени."
  );

  const formData = new FormData();
  formData.append("scenario", recordingScenario || selectedScenario);
  formData.append("media_type", "audio");
  formData.append("mode", mode);
  formData.append("title", recordingTitle);
  formData.append("file", recordedFile);

  try {
    const practice = await apiRequest("/api/practices/upload", {
      method: "POST",
      body: formData,
    });

    allowNavigation = true;
    window.location.href = "lk.html";
  } catch (error) {
    setError(error.message);
    setStatus("Запись готова", "ready");
    setStageMessage(
      "Запись готова",
      "Прослушайте результат, сохраните черновик или запустите анализ аудиометрик."
    );
    const validDuration = isDurationValid(elapsedSeconds);
    draftButton.disabled = !validDuration;
    processButton.disabled = !validDuration;
    mainActionButton.disabled = false;
    activeButton.setAttribute("aria-label", previousText);
  }
}

function renderSelectedScenario() {
  if (!scenarioNames[selectedScenario]) {
    selectedScenario = "presentation";
    localStorage.setItem("speakeasy_selected_scenario", selectedScenario);
  }
  selectedScenarioLabel.textContent = scenarioNames[selectedScenario] || "Презентация";
  const locked = isScenarioLocked();
  scenarioToggle.disabled = locked;
  if (locked) {
    setScenarioMenuOpen(false);
  }
  scenarioOptions.forEach((button) => {
    const isActive = button.dataset.scenarioOption === selectedScenario;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
    button.disabled = locked;
  });
}

function setScenarioMenuOpen(isOpen) {
  if (isOpen && isScenarioLocked()) {
    return;
  }
  scenarioMenu.hidden = !isOpen;
  scenarioToggle.setAttribute("aria-expanded", String(isOpen));
}

function selectScenario(scenario) {
  if (isScenarioLocked()) {
    setScenarioMenuOpen(false);
    return;
  }
  selectedScenario = scenario;
  localStorage.setItem("speakeasy_selected_scenario", scenario);
  renderSelectedScenario();
  setScenarioMenuOpen(false);
}

function isScenarioLocked() {
  return Boolean(
    scenarioSelectionLocked ||
      countdownTimerId ||
      (mediaRecorder && mediaRecorder.state !== "inactive")
  );
}

function openPrepModal() {
  if (!prepModal) {
    startCountdown();
    return;
  }

  prepModal.hidden = false;
  document.body.classList.add("modal-open");
  prepStartButton?.focus();
}

function closePrepModal() {
  if (!prepModal) {
    return;
  }

  prepModal.hidden = true;
  document.body.classList.remove("modal-open");
  mainActionButton.focus();
}

function confirmPrepAndStart() {
  closePrepModal();
  startCountdown();
}

function renderCountdownChoice() {
  if (![3, 5, 10].includes(selectedCountdown)) {
    selectedCountdown = 3;
  }

  countdownOptions.forEach((option) => {
    option.checked = Number(option.value) === selectedCountdown;
  });
}

function setCountdown(seconds) {
  selectedCountdown = seconds;
  localStorage.setItem("speakeasy_audio_countdown", String(seconds));
  renderCountdownChoice();
}

function startCountdown() {
  let remaining = selectedCountdown;
  scenarioSelectionLocked = true;
  renderSelectedScenario();

  if (!countdownOverlay || !countdownValue) {
    startRecording();
    return;
  }

  mainActionButton.disabled = true;
  renderSelectedScenario();
  countdownValue.textContent = String(remaining);
  countdownOverlay.hidden = false;
  document.body.classList.add("modal-open");

  clearInterval(countdownTimerId);
  countdownTimerId = window.setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
      countdownOverlay.hidden = true;
      document.body.classList.remove("modal-open");
      mainActionButton.disabled = false;
      startRecording();
      return;
    }

    countdownValue.textContent = String(remaining);
  }, 1000);
}

function hasUnsavedRecordingProgress() {
  return Boolean(
    countdownTimerId ||
      recordedFile ||
      (mediaRecorder && mediaRecorder.state !== "inactive")
  );
}

function confirmLeaveRecording() {
  if (!hasUnsavedRecordingProgress()) {
    return true;
  }

  return window.confirm("Запись будет прервана, а несохраненный результат потеряется. Уйти со страницы?");
}

function openLeaveModal(url) {
  if (!leaveModal) {
    allowNavigation = true;
    window.location.href = url;
    return;
  }

  if (mediaRecorder?.state === "recording") {
    pauseRecording();
  }

  pendingNavigationUrl = url;
  leaveModal.hidden = false;
  document.body.classList.add("modal-open");
  leaveConfirmButton?.focus();
}

function closeLeaveModal() {
  if (!leaveModal) {
    return;
  }

  pendingNavigationUrl = null;
  leaveModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function confirmLeaveModal() {
  if (!pendingNavigationUrl) {
    closeLeaveModal();
    return;
  }

  allowNavigation = true;
  window.location.href = pendingNavigationUrl;
}

mainActionButton.addEventListener("click", () => {
  if (mediaRecorder?.state === "paused") {
    pauseRecording();
    return;
  }

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    stopRecording();
    return;
  }
  openPrepModal();
});

prepStartButton?.addEventListener("click", confirmPrepAndStart);
prepCloseButtons.forEach((button) => {
  button.addEventListener("click", closePrepModal);
});
titleForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitTitleModal();
});
titleCancelButtons.forEach((button) => {
  button.addEventListener("click", () => closeTitleModal(null));
});
leaveCancelButtons.forEach((button) => {
  button.addEventListener("click", closeLeaveModal);
});
leaveConfirmButton?.addEventListener("click", confirmLeaveModal);
countdownOptions.forEach((option) => {
  option.addEventListener("change", () => setCountdown(Number(option.value)));
});
pauseButton.addEventListener("click", pauseRecording);
draftButton.addEventListener("click", () => uploadRecordedAudio("draft"));
processButton.addEventListener("click", () => uploadRecordedAudio("process"));
clearNotesButton?.addEventListener("click", () => {
  notesInput.value = "";
});
scenarioToggle?.addEventListener("click", () => {
  if (isScenarioLocked()) {
    return;
  }
  setScenarioMenuOpen(scenarioMenu.hidden);
});
scenarioOptions.forEach((button) => {
  button.addEventListener("click", () => selectScenario(button.dataset.scenarioOption));
});
document.addEventListener("click", (event) => {
  if (scenarioMenu.hidden) {
    return;
  }
  if (!event.target.closest(".practice-type-picker")) {
    setScenarioMenuOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && prepModal && !prepModal.hidden) {
    closePrepModal();
    return;
  }

  if (event.key === "Escape" && titleModal && !titleModal.hidden) {
    closeTitleModal(null);
    return;
  }

  if (event.key === "Escape" && leaveModal && !leaveModal.hidden) {
    closeLeaveModal();
    return;
  }

  if (event.key === "Escape" && !scenarioMenu.hidden) {
    setScenarioMenuOpen(false);
    scenarioToggle.focus();
  }
});

window.addEventListener("pagehide", () => {
  clearInterval(countdownTimerId);
  cleanupStream();
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
  }
});

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");

  if (!link || allowNavigation) {
    return;
  }

  if (link.target === "_blank" || link.hasAttribute("download")) {
    return;
  }

  if (hasUnsavedRecordingProgress()) {
    event.preventDefault();
    openLeaveModal(link.href);
    return;
  }

  allowNavigation = true;
});

renderSelectedScenario();
renderCountdownChoice();
resetRecording();
