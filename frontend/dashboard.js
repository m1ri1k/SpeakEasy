const scenarioButtons = document.querySelectorAll(".scenario-chip[data-scenario]");
const scenarioDescription = document.querySelector(".scenario-description");
const historyTabs = document.querySelectorAll(".history-tab[data-history-filter]");
const userName = document.querySelector("[data-user-name]");
const fileInput = document.querySelector(".drop-zone input[type='file']");
const historyList = document.querySelector(".history-list");
const totalPracticesStat = document.querySelector("[data-stat-total]");
const donePracticesStat = document.querySelector("[data-stat-done]");
const averageDurationStat = document.querySelector("[data-stat-duration]");
const uploadErrorEl = document.getElementById("uploadError");
const uploadErrorTextEl = document.getElementById("uploadErrorText");
const uploadModal = document.querySelector("[data-upload-modal]");
const confirmScenario = document.querySelector("[data-confirm-scenario]");
const confirmFilename = document.querySelector("[data-confirm-filename]");
const confirmMedia = document.querySelector("[data-confirm-media]");
const confirmDuration = document.querySelector("[data-confirm-duration]");
const uploadProcessWarning = document.querySelector("[data-upload-process-warning]");
const uploadCancelButton = document.querySelector("[data-upload-cancel]");
const uploadDraftButton = document.querySelector("[data-upload-draft]");
const uploadProcessButton = document.querySelector("[data-upload-process]");
const videoRecordAction = document.querySelector("[data-video-record-action]");

const API_BASE_URL = (() => {
  if (!window.location.hostname || window.location.protocol === "file:") {
    return "http://192.168.1.8:8000";
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:8000`;
})();
const token = localStorage.getItem("speakeasy_token");

const REMINDER_ENABLED_KEY = "speakeasy_reminder_enabled";
const REMINDER_INTERVAL_KEY = "speakeasy_reminder_interval";
const REMINDER_ACTIVE_KEY = "speakeasy_reminder_active";
const REMINDER_DISMISSED_KEY = "speakeasy_reminder_dismissed_at";

const scenarios = {
  presentation: {
    description:
      "Подходит для докладов, защит проектов и выступлений по слайдам. Фокус: структура речи, темп, тайминг",
  },
  pitch: {
    description:
      "Подходит для короткой деловой подачи идеи, продукта или проекта. Фокус: убедительность, лаконичность и сильный финал",
  },
  podcast: {
    description:
      "Подходит для аудиоформата, монолога или разговора без камеры. Фокус: естественный темп, чистый звук и удержание внимания голосом",
  },
  free: {
    description:
      "Подходит для тренировки речи без жесткого сценария: импровизация, сторителлинг, ежедневные выступления. Фокус: плавность речи, темп и уверенность",
  },
};

const ALLOWED_EXTENSIONS = new Set([".mp3", ".wav", ".mp4", ".mov", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".webm"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
const MIN_DURATION_SEC = 3 * 60;
const MAX_DURATION_SEC = 15 * 60;
const UPLOAD_STALL_TIMEOUT_MS = 45000;
const UPLOAD_OFFLINE_MESSAGE = "Соединение прервано. Проверьте интернет и попробуйте снова.";
const UPLOAD_NETWORK_MESSAGE = "Не удалось загрузить файл. Проверьте интернет и попробуйте снова.";

let selectedScenario = localStorage.getItem("speakeasy_selected_scenario") || "presentation";
let currentHistoryFilter = "done";
let currentPractices = [];
let pendingUpload = null;
let lastUploadAttempt = null;
let pollingTimer = null;
let activeUploadPreview = null;
let practicesLoadRequestId = 0;
let practiceMutationInFlight = 0;

if (!token) {
  window.location.href = "main.html";
}

function setUserName(name) {
  if (!userName || !name) {
    return;
  }

  userName.textContent = name;
}

function updateDescription(scenarioKey) {
  const scenario = scenarios[scenarioKey];

  if (!scenarioDescription || !scenario) {
    return;
  }

  scenarioDescription.textContent = scenario.description;
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
    window.location.href = "main.html";
    return null;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || "Ошибка API");
  }

  return response.json();
}

function scenarioTitle(key) {
  const names = {
    presentation: "Презентация",
    pitch: "Бизнес-питч",
    podcast: "Подкаст",
    free: "Свободная практика",
  };

  return names[key] || key;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(new Date(value));
}

function formatAverageDuration(seconds) {
  if (!seconds) {
    return "0 сек";
  }

  if (seconds < 60) {
    return `${formatDurationNumber(seconds)} сек`;
  }

  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);

  if (!restSeconds) {
    return `${minutes} мин`;
  }

  return `${minutes} мин ${restSeconds} сек`;
}

function formatDurationNumber(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
}

function updateStats(practices) {
  const visiblePractices = practices.filter((practice) => practice.status !== "deleted");
  const donePractices = visiblePractices.filter((practice) => practice.status === "done");
  const durations = visiblePractices
    .map((practice) => practice.duration_seconds)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const averageDuration = durations.length
    ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
    : 0;

  if (totalPracticesStat) {
    totalPracticesStat.textContent = String(visiblePractices.length);
  }

  if (donePracticesStat) {
    donePracticesStat.textContent = String(donePractices.length);
  }

  if (averageDurationStat) {
    averageDurationStat.textContent = formatAverageDuration(averageDuration);
  }
}

function practiceActivityTime(practice) {
  return new Date(practice.deleted_at || practice.created_at).getTime() || 0;
}

function renderPractices(practices) {
  if (!historyList) {
    return;
  }

  const sortedPractices = [...practices].sort((a, b) => practiceActivityTime(b) - practiceActivityTime(a));
  const practicesWithPreview = activeUploadPreview ? [activeUploadPreview, ...sortedPractices] : sortedPractices;
  const processingLocked = practicesWithPreview.some((practice) => practice.status === "processing");
  const allFilteredPractices = practicesWithPreview.filter((practice) => {
    if (currentHistoryFilter === "done") {
      return practice.status === "done" || practice.status === "processing";
    }
    if (currentHistoryFilter === "drafts") {
      return practice.status === "draft";
    }
    return practice.status !== "deleted";
  });
  const filteredPractices = currentHistoryFilter === "done"
    ? allFilteredPractices.slice(0, 5)
    : allFilteredPractices;

  if (!filteredPractices.length) {
    historyList.innerHTML = `<div class="history-empty">${historyEmptyText(currentHistoryFilter)}</div>`;
    return;
  }

  const existingItems = Array.from(historyList.querySelectorAll("article[data-practice-id]"));
  const existingIds = existingItems.map((el) => el.dataset.practiceId);
  const newIds = filteredPractices.map((p) => String(p.id));

  if (JSON.stringify(existingIds) === JSON.stringify(newIds)) {
    filteredPractices.forEach((practice, i) => {
      const el = existingItems[i];
      const badge = el.querySelector(".status-badge");
      const prevStatus = badge?.className.match(/\bstatus-(\w+)\b/)?.slice(1).find((s) => s !== "badge") ?? el.dataset.status;
      if (prevStatus !== practice.status) {
        el.dataset.status = practice.status;
        el.classList.toggle("is-processing", practice.status === "processing");

        if (practice.status === "processing") {
          badge?.remove();
          const existingHint = el.querySelector(".processing-hint");
          if (!existingHint) {
            el.insertAdjacentHTML("beforeend", processingHintMarkup());
          }
        } else {
          const next = document.createElement("span");
          next.className = `status-badge ${statusClass(practice.status)}`;
          next.innerHTML = statusLabel(practice.status);
          if (badge) {
            badge.replaceWith(next);
          } else {
            el.querySelector(".history-actions")?.insertAdjacentElement("beforebegin", next);
          }
          el.querySelector(".processing-hint")?.remove();
        }
      }
      const actionsDiv = el.querySelector(".history-actions");
      if (actionsDiv) {
        const isDone = practice.status === "done";
        const isProcessing = practice.status === "processing";
        actionsDiv.innerHTML = `${isDone ? `<a class="history-action primary" href="analytics.html?practice_id=${practice.id}">Отчет</a>` : ""}${practice.status === "draft" && !processingLocked ? `<button class="history-action" type="button" data-action="process-practice">Обработать</button>` : ""}${!isProcessing ? `<button class="history-action danger" type="button" data-action="delete-practice">В корзину</button>` : ""}`;
      }
    });
    const archiveHint = historyList.querySelector(".history-archive-hint");
    if (currentHistoryFilter === "done" && !archiveHint) {
      historyList.insertAdjacentHTML("beforeend", `<p class="history-archive-hint">Показаны последние 5 записей. Все записи — в <a href="archive.html">Архиве</a>.</p>`);
    } else if (currentHistoryFilter !== "done" && archiveHint) {
      archiveHint.remove();
    }
    return;
  }

  historyList.innerHTML = filteredPractices
    .map((practice) => {
      const isDone = practice.status === "done";
      const title = escapeHtml(practice.original_filename);
      const processingStyle = practice.status === "processing" ? ` style="${processingProgressStyle(practice)}"` : "";
      const statusContent = practice.status === "processing"
        ? `<span class="status-badge-label">${statusLabel(practice.status)}</span>`
        : statusLabel(practice.status);
      const isProcessing = practice.status === "processing";
      return `
        <article class="history-item${isProcessing ? " is-processing" : ""}" data-practice-id="${practice.id}" data-status="${practice.status}">
          <svg class="file-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          <div class="file-info">
            <h3>${title}</h3>
            <p>${scenarioTitle(practice.scenario)} • ${practice.media_type === "audio" ? "аудио" : "видео"} • ${formatDate(practice.created_at)}</p>
          </div>
          ${!isProcessing ? `<span class="status-badge ${statusClass(practice.status)}"${processingStyle}>${statusContent}</span>` : ""}
          <div class="history-actions">
            ${isDone ? `<a class="history-action primary" href="analytics.html?practice_id=${practice.id}">Отчет</a>` : ""}
            ${practice.status === "draft" && !processingLocked ? `<button class="history-action" type="button" data-action="process-practice">Обработать</button>` : ""}
            ${!isProcessing ? `<button class="history-action danger" type="button" data-action="delete-practice">В корзину</button>` : ""}
          </div>
          ${isProcessing ? processingHintMarkup() : ""}
        </article>
      `;
    })
    .join("");

  if (currentHistoryFilter === "done") {
    historyList.innerHTML += `<p class="history-archive-hint">Показаны последние 5 записей. Все записи — в <a href="archive.html">Архиве</a>.</p>`;
  }
}

function statusLabel(status) {
  return {
    done: "Готово",
    processing: "В обработке",
    draft: "Черновик",
    deleted: "Корзина",
  }[status] || status;
}

function statusClass(status) {
  return `status-${status}`;
}

function processingProgressStyle(practice) {
  return "";
}

function processingHintMarkup() {
  return `
    <div class="processing-hint">
      <svg class="processing-hint-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 6v6l4 2"/>
      </svg>
      <span class="processing-hint-text">Анализируем запись — обычно это занимает примерно столько же, сколько она длится. Можно закрыть страницу, результат сохранится.</span>
      <span class="processing-hint-bar"></span>
    </div>
  `;
}

function historyEmptyText(filter) {
  return {
    done: "Готовых отчетов пока нет",
    drafts: "Черновиков пока нет",
  }[filter] || "Здесь пока пусто";
}

function hasProcessingPractice() {
  return Boolean(activeUploadPreview) || currentPractices.some((practice) => practice.status === "processing");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

async function loadProfile() {
  const cachedUser = localStorage.getItem("speakeasy_user");

  if (cachedUser) {
    setUserName(JSON.parse(cachedUser).name);
  }

  const user = await apiRequest("/api/auth/me");
  if (user) {
    localStorage.setItem("speakeasy_user", JSON.stringify(user));
    setUserName(user.name);
  }
}

async function loadPractices(options = {}) {
  if (practiceMutationInFlight && !options.force) {
    return null;
  }
  const requestId = ++practicesLoadRequestId;
  const practices = await apiRequest("/api/practices?include_deleted=true");
  if (requestId !== practicesLoadRequestId) {
    return null;
  }
  if (practices) {
    applyPractices(practices);
  }
  return practices;
}

function applyPractices(practices) {
  currentPractices = practices;
  updateStats(practices);
  renderPractices(practices);
  managePolling(practices);
  checkAndShowReminder(practices);
  revealDashboard();
}

function revealDashboard() {
  document.body.classList.remove("is-dashboard-loading");
}

function managePolling(practices) {
  const hasProcessing = practices.some((p) => p.status === "processing");
  if (hasProcessing && !pollingTimer) {
    pollingTimer = setInterval(() => loadPractices().catch(() => {}), 10000);
  } else if (!hasProcessing && pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function showUploadError(message, showRetry = false) {
  if (!uploadErrorEl || !uploadErrorTextEl) return;
  uploadErrorTextEl.textContent = message;
  uploadErrorEl.classList.add("is-visible");
  const retryBtn = uploadErrorEl.querySelector(".upload-retry-btn");
  if (retryBtn) retryBtn.hidden = !showRetry;
  uploadErrorEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideUploadError() {
  if (!uploadErrorEl) return;
  uploadErrorEl.classList.remove("is-visible");
}

async function retryUpload() {
  if (!lastUploadAttempt) return;
  hideUploadError();
  pendingUpload = { file: lastUploadAttempt.file, duration: lastUploadAttempt.duration };
  await confirmUpload(lastUploadAttempt.mode);
}

function getMediaDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = detectMediaType(file) === "audio" ? new Audio() : document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(el.duration);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось определить длительность файла"));
    };
    el.src = url;
  });
}

function fileExtension(file) {
  const name = file.name || "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex !== -1 ? name.slice(dotIndex).toLowerCase() : "";
}

function detectMediaType(file) {
  const ext = fileExtension(file);
  if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (file.type.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  return "video";
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function validateFile(file) {
  const name = file.name || "";
  const ext = fileExtension(file);

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Недопустимый формат файла${ext ? ` «${ext}»` : ""}. Принимаются: MP3, WAV, MP4, MOV, WEBM.`
    );
  }

  let duration;
  try {
    duration = await getMediaDuration(file);
  } catch {
    return null;
  }

  if (!Number.isFinite(duration)) return null;

  if (duration < MIN_DURATION_SEC) {
    throw new Error(
      `Файл слишком короткий (${formatDuration(duration)}). Минимальная длительность — 3 минуты.`
    );
  }

  if (duration > MAX_DURATION_SEC) {
    throw new Error(
      `Файл слишком длинный (${formatDuration(duration)}). Максимальная длительность — 15 минут.`
    );
  }

  return duration;
}

function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let isSettled = false;
    let wasOffline = false;
    let offlinePollTimer = null;
    let stallTimer = null;

    function settle(callback, value) {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      callback(value);
    }

    function resetStallTimer() {
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
      stallTimer = setTimeout(() => {
        request.abort();
        settle(reject, new Error(navigator.onLine === false ? UPLOAD_OFFLINE_MESSAGE : UPLOAD_NETWORK_MESSAGE));
      }, UPLOAD_STALL_TIMEOUT_MS);
    }

    function rejectForNetwork() {
      settle(reject, new Error(wasOffline || navigator.onLine === false ? UPLOAD_OFFLINE_MESSAGE : UPLOAD_NETWORK_MESSAGE));
    }

    request.open("POST", `${API_BASE_URL}${path}`);
    request.setRequestHeader("Authorization", `Bearer ${token}`);

    function cleanup() {
      window.removeEventListener("offline", onOffline);
      if (offlinePollTimer) {
        clearInterval(offlinePollTimer);
        offlinePollTimer = null;
      }
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    }

    function onOffline() {
      wasOffline = true;
      request.abort();
      settle(reject, new Error(UPLOAD_OFFLINE_MESSAGE));
    }

    if (navigator.onLine === false) {
      settle(reject, new Error(UPLOAD_OFFLINE_MESSAGE));
      return;
    }

    window.addEventListener("offline", onOffline);
    offlinePollTimer = setInterval(() => {
      if (navigator.onLine === false) {
        onOffline();
      }
    }, 1000);
    resetStallTimer();

    request.upload.addEventListener("progress", (event) => {
      resetStallTimer();
      if (!event.lengthComputable || typeof onProgress !== "function") {
        return;
      }
      onProgress(Math.round((event.loaded / event.total) * 100));
    });

    request.upload.addEventListener("loadend", () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    });

    request.addEventListener("load", () => {
      const data = request.responseText ? JSON.parse(request.responseText) : null;

      if (request.status === 401) {
        localStorage.removeItem("speakeasy_token");
        localStorage.removeItem("speakeasy_user");
        localStorage.removeItem("speakeasy_session_expires_at");
        window.location.href = "main.html";
        settle(resolve, null);
        return;
      }

      if (request.status < 200 || request.status >= 300) {
        settle(reject, new Error(data?.detail || "Ошибка API"));
        return;
      }

      settle(resolve, data);
    });

    request.addEventListener("error", () => {
      rejectForNetwork();
    });

    request.addEventListener("abort", () => {
      if (!isSettled) {
        rejectForNetwork();
      }
    });

    request.send(formData);
  });
}

async function uploadPractice(file, mode = "process", onProgress) {
  const formData = new FormData();
  const mediaType = detectMediaType(file);
  if (selectedScenario === "podcast" && mediaType === "video") {
    throw new Error("Подкаст доступен только для аудио. Выберите аудиофайл или другой тип практики.");
  }

  formData.append("scenario", selectedScenario);
  formData.append("media_type", mediaType);
  formData.append("mode", mode);
  formData.append("file", file);

  return uploadWithProgress("/api/practices/upload", formData, onProgress);
}

async function processPractice(practiceId) {
  practiceMutationInFlight += 1;
  try {
    await apiRequest(`/api/practices/${practiceId}/process`, { method: "POST" });
    await loadPractices({ force: true });
  } finally {
    practiceMutationInFlight -= 1;
  }
}

async function deletePractice(practiceId) {
  practiceMutationInFlight += 1;
  try {
    await apiRequest(`/api/practices/${practiceId}`, { method: "DELETE" });
    await loadPractices({ force: true });
  } finally {
    practiceMutationInFlight -= 1;
  }
}

async function restorePractice(practiceId) {
  practiceMutationInFlight += 1;
  try {
    await apiRequest(`/api/practices/${practiceId}/restore`, { method: "POST" });
    await loadPractices({ force: true });
  } finally {
    practiceMutationInFlight -= 1;
  }
}

function openUploadModal(file, duration) {
  const mediaType = detectMediaType(file);
  if (selectedScenario === "podcast" && mediaType === "video") {
    showUploadError("Подкаст доступен только для аудио. Выберите аудиофайл или другой тип практики.");
    return;
  }
  pendingUpload = { file, duration };
  confirmScenario.textContent = scenarioTitle(selectedScenario);
  confirmFilename.textContent = file.name;
  confirmMedia.textContent = mediaType === "audio" ? "Аудио" : "Видео";
  confirmDuration.textContent = Number.isFinite(duration) ? formatDuration(duration) : "не определена";
  const processingLocked = hasProcessingPractice();
  uploadProcessButton.disabled = processingLocked;
  if (uploadProcessWarning) {
    uploadProcessWarning.hidden = !processingLocked;
  }
  uploadModal.hidden = false;
  document.body.classList.add("modal-open");
  (uploadProcessButton.disabled ? uploadDraftButton : uploadProcessButton).focus();
}

function closeUploadModal() {
  uploadModal.hidden = true;
  document.body.classList.remove("modal-open");
  pendingUpload = null;
  if (uploadProcessWarning) {
    uploadProcessWarning.hidden = true;
  }
}

async function confirmUpload(mode) {
  if (!pendingUpload) {
    return;
  }

  const file = pendingUpload.file;
  const uploadDuration = pendingUpload.duration;
  lastUploadAttempt = { file, duration: uploadDuration, mode };
  practiceMutationInFlight += 1;
  uploadDraftButton.disabled = true;
  uploadProcessButton.disabled = true;
  uploadDraftButton.textContent = mode === "draft" ? "Сохраняем..." : "В черновик";
  uploadProcessButton.textContent = mode === "process" ? "Обрабатываем..." : "Обработать";

  try {
    if (mode === "process") {
      activeUploadPreview = {
        id: "upload-preview",
        original_filename: file.name,
        scenario: selectedScenario,
        media_type: detectMediaType(file),
        created_at: new Date().toISOString(),
        status: "processing",
      };
      renderPractices(currentPractices);
      closeUploadModal();
    }

    const uploadedPractice = await uploadPractice(file, mode);

    if (mode === "process" && uploadedPractice) {
      const previewEl = historyList?.querySelector('[data-practice-id="upload-preview"]');
      if (previewEl) {
        previewEl.dataset.practiceId = String(uploadedPractice.id);
      }
      activeUploadPreview = null;
      currentPractices = [uploadedPractice, ...currentPractices.filter((p) => p.id !== uploadedPractice.id)];
      updateStats(currentPractices);
      managePolling(currentPractices);
      checkAndShowReminder(currentPractices);
    } else {
      activeUploadPreview = null;
      const requestId = ++practicesLoadRequestId;
      const practices = await apiRequest("/api/practices?include_deleted=true");
      if (practices && requestId === practicesLoadRequestId) {
        applyPractices(practices);
      }
    }
    closeUploadModal();
  } catch (error) {
    activeUploadPreview = null;
    renderPractices(currentPractices);
    showUploadError(error.message, true);
  } finally {
    practiceMutationInFlight = Math.max(0, practiceMutationInFlight - 1);
    uploadDraftButton.disabled = false;
    uploadProcessButton.disabled = hasProcessingPractice();
    uploadDraftButton.textContent = "В черновик";
    uploadProcessButton.textContent = "Обработать";
  }
}

function selectScenario(scenarioKey) {
  if (!scenarios[scenarioKey]) {
    scenarioKey = "presentation";
  }
  selectedScenario = scenarioKey;
  localStorage.setItem("speakeasy_selected_scenario", scenarioKey);

  scenarioButtons.forEach((button) => {
    const isSelected = button.dataset.scenario === scenarioKey;
    button.classList.toggle("is-active", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  });

  updateDescription(scenarioKey);
  updateMediaActions();
}

function updateMediaActions() {
  if (!videoRecordAction) {
    return;
  }

  const isPodcast = selectedScenario === "podcast";
  videoRecordAction.classList.toggle("is-disabled", isPodcast);
  videoRecordAction.setAttribute("aria-disabled", String(isPodcast));
  videoRecordAction.title = isPodcast ? "Подкаст доступен только для аудио" : "";
}

scenarioButtons.forEach((button) => {
  const scenarioKey = button.dataset.scenario;

  button.addEventListener("mouseenter", () => updateDescription(scenarioKey));
  button.addEventListener("focus", () => updateDescription(scenarioKey));

  button.addEventListener("mouseleave", () => updateDescription(selectedScenario));
  button.addEventListener("blur", () => updateDescription(selectedScenario));

  button.addEventListener("click", () => selectScenario(scenarioKey));
});

videoRecordAction?.addEventListener("click", (event) => {
  if (selectedScenario !== "podcast") {
    return;
  }
  event.preventDefault();
  showUploadError("Подкаст доступен только для аудиозаписи. Выберите «Аудио» или смените тип практики.");
});

historyTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    currentHistoryFilter = tab.dataset.historyFilter;
    historyTabs.forEach((currentTab) => {
      const isSelected = currentTab === tab;
      currentTab.classList.toggle("is-active", isSelected);
      currentTab.setAttribute("aria-pressed", String(isSelected));
    });
    renderPractices(currentPractices);
  });
});

historyList?.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) {
    return;
  }

  const item = actionButton.closest("[data-practice-id]");
  const practiceId = item?.dataset.practiceId;
  if (!practiceId) {
    return;
  }

  actionButton.disabled = true;
  try {
    if (actionButton.dataset.action === "process-practice") {
      actionButton.textContent = "Обрабатываем...";
      await processPractice(practiceId);
    }
    if (actionButton.dataset.action === "delete-practice") {
      await deletePractice(practiceId);
    }
    if (actionButton.dataset.action === "restore-practice") {
      await restorePractice(practiceId);
    }
  } catch (error) {
    showUploadError(error.message);
  } finally {
    actionButton.disabled = false;
  }
});

fileInput?.addEventListener("change", async () => {
  const file = fileInput.files?.[0];

  if (!file) {
    return;
  }

  hideUploadError();

  try {
    const duration = await validateFile(file);
    openUploadModal(file, duration);
  } catch (error) {
    showUploadError(error.message);
  } finally {
    fileInput.value = "";
  }
});

uploadCancelButton?.addEventListener("click", closeUploadModal);
uploadDraftButton?.addEventListener("click", () => confirmUpload("draft"));
uploadProcessButton?.addEventListener("click", () => confirmUpload("process"));
uploadErrorEl?.querySelector(".upload-retry-btn")?.addEventListener("click", retryUpload);
uploadModal?.addEventListener("click", (event) => {
  if (event.target === uploadModal) {
    closeUploadModal();
  }
});


function daysWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return "дней";
  if (mod10 === 1) return "день";
  if (mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}

function loadReminderSettings() {
  return {
    enabled: localStorage.getItem(REMINDER_ENABLED_KEY) === "true",
    interval: parseInt(localStorage.getItem(REMINDER_INTERVAL_KEY) || "7", 10),
  };
}


function syncBell() {}

function checkAndShowReminder(practices) {
  const { enabled, interval } = loadReminderSettings();
  if (!enabled) {
    localStorage.removeItem(REMINDER_ACTIVE_KEY);
    syncBell();
    return;
  }

  const dismissedAt = localStorage.getItem(REMINDER_DISMISSED_KEY);
  if (dismissedAt) {
    const daysSinceDismiss = (Date.now() - new Date(dismissedAt).getTime()) / 86400000;
    if (daysSinceDismiss < interval) {
      localStorage.removeItem(REMINDER_ACTIVE_KEY);
      syncBell();
      return;
    }
  }

  const active = practices.filter((p) => p.status !== "deleted");
  let message = null;

  if (!active.length) {
    message = "Ещё не было ни одной практики — самое время начать!";
  } else {
    const lastDate = active.reduce((latest, p) => {
      const d = new Date(p.created_at);
      return d > latest ? d : latest;
    }, new Date(0));
    const daysSinceLast = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
    if (daysSinceLast >= interval) {
      message = `Последняя практика была ${daysSinceLast} ${daysWord(daysSinceLast)} назад — пора записать новую!`;
    }
  }

  if (message) {
    localStorage.setItem(REMINDER_ACTIVE_KEY, message);
  } else {
    localStorage.removeItem(REMINDER_ACTIVE_KEY);
  }
  syncBell();
}

selectScenario(selectedScenario);
loadProfile().catch(() => {});
loadPractices().catch(() => {
  revealDashboard();
});
