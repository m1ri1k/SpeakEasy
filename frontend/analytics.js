const API_BASE_URL = (() => {
  if (!window.location.hostname || window.location.protocol === "file:") {
    return "http://192.168.1.8:8000";
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:8000`;
})();
const token = localStorage.getItem("speakeasy_token");
const practiceId = new URLSearchParams(window.location.search).get("practice_id");
const downloadReportButton = document.querySelector("[data-download-report]");
let currentReport = null;

const scenarioNames = {
  presentation: "Презентация",
  pitch: "Бизнес-питч",
  podcast: "Подкаст",
  free: "Свободная практика",
};

const fillerWords = [
  "собственно говоря",
  "в некотором роде",
  "на самом деле",
  "таким образом",
  "как говорится",
  "в самом деле",
  "ничего себе",
  "без проблем",
  "в принципе",
  "в общем-то",
  "как сказать",
  "это самое",
  "в натуре",
  "в общем",
  "в целом",
  "всё такое",
  "да ладно",
  "ешкин кот",
  "как его",
  "как-то так",
  "не вопрос",
  "ну вот",
  "ну это",
  "так вот",
  "так далее",
  "так сказать",
  "типа того",
  "то есть",
  "буквально",
  "допустим",
  "достаточно",
  "конкретно",
  "например",
  "практически",
  "понимаешь",
  "фактически",
  "вообще",
  "видишь",
  "знаешь",
  "значит",
  "короче",
  "походу",
  "прикинь",
  "слушай",
  "слышишь",
  "а-а-а",
  "блин",
  "ведь",
  "вот",
  "итак",
  "нет",
  "прикол",
  "просто",
  "прямо",
  "скажем",
  "типа",
  "эм",
  "это",
  "э-э-э",
  "да",
  "ну",
].sort((a, b) => b.length - a.length);

if (!token) {
  window.location.href = "main.html";
}

if (!practiceId) {
  window.location.href = "lk.html";
}

async function apiRequest(path) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
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
    throw new Error(data.detail || "Не удалось загрузить отчет");
  }

  return response.json();
}

async function apiBlobRequest(path) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
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
    throw new Error(data.detail || "Не удалось скачать отчет");
  }

  return response.blob();
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function formatDuration(seconds) {
  if (!seconds) {
    return "длительность не определена";
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes} мин ${rest} сек` : `${rest} сек`;
}

function formatClock(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function scoreLabel(score) {
  if (score >= 85) {
    return "Отличный результат";
  }
  if (score >= 70) {
    return "Хороший результат";
  }
  if (score >= 55) {
    return "Есть зоны роста";
  }
  return "Нужна доработка";
}

function metricBadge(state) {
  if (state === "good") {
    return "В норме";
  }
  if (state === "unavailable") {
    return "Недоступно";
  }
  return "Вне нормы";
}

function metricScoreText(score) {
  return Number.isFinite(score) ? `${score}/100` : "нет данных";
}

function displayRecommendation(analytics) {
  if (analytics.score >= 100) {
    return {
      title: "Отличная работа",
      text: "Все ключевые метрики в норме. Сохраните текущий темп, громкость и структуру выступления.",
    };
  }

  return {
    title: recommendationTitle(analytics.metrics || []),
    text: analytics.recommendation,
  };
}

function recommendationTitle(metrics) {
  const warning = metrics.find((metric) => normalizedMetricState(metric) !== "good" && normalizedMetricState(metric) !== "unavailable");

  if (!warning) {
    return "Закрепите сильную подачу";
  }

  return `Фокус: ${warning.title.toLowerCase()}`;
}

function normalizedMetricState(metric) {
  if (!Number.isFinite(metric.score) || metric.value === "нет данных") {
    return "unavailable";
  }

  return metric.state;
}

function metricIconSvg(state) {
  if (state === "good") {
    return `
      <svg class="metric-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    `;
  }

  return `
    <svg class="metric-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  `;
}

function scoreForRange(value, normMin, normMax, maxDeviation) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (value >= normMin && value <= normMax) {
    return 100;
  }

  const deviation = value < normMin ? normMin - value : value - normMax;
  return Math.max(0, Math.round(100 - (deviation / maxDeviation) * 100));
}

function scoreForMetric(metric) {
  if (Number.isFinite(metric.score)) {
    return metric.score;
  }

  const title = metric.title.toLowerCase();
  const value = metric.value || "";

  if (title.includes("скорость")) {
    const speechRate = Number(value.match(/(\d+)\s*слов\/мин/)?.[1]);
    const rangeMatch = value.match(/норма\s+(\d+)-(\d+)/);
    return rangeMatch
      ? scoreForRange(speechRate, Number(rangeMatch[1]), Number(rangeMatch[2]), 40)
      : null;
  }

  if (title.includes("паузы")) {
    const averagePause = Number(value.match(/средняя\s+(\d+(?:[.,]\d+)?)\s*сек/)?.[1]?.replace(",", "."));
    const rangeMatch = value.match(/норма\s+(\d+(?:[.,]\d+)?)-(\d+(?:[.,]\d+)?)/);
    return rangeMatch
      ? scoreForRange(averagePause, Number(rangeMatch[1].replace(",", ".")), Number(rangeMatch[2].replace(",", ".")), 2)
      : null;
  }

  if (title.includes("паразит")) {
    if (value === "не найдены") {
      return 100;
    }

    const rate = Number(value.match(/(\d+(?:[.,]\d+)?)\/мин/)?.[1]?.replace(",", "."));
    const limit = Number(value.match(/≤\s*(\d+(?:[.,]\d+)?)\/мин/)?.[1]?.replace(",", "."));
    if (Number.isFinite(rate) && Number.isFinite(limit)) {
      return scoreForRange(rate, 0, limit, limit);
    }

    const total = [...value.matchAll(/:\s*(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    return total ? scoreForRange(total, 0, 2, 10) : null;
  }

  if (title.includes("громкость")) {
    const loudness = Number(value.match(/(-?\d+(?:\.\d+)?)\s*dBFS/)?.[1]);
    const rangeMatch = value.match(/норма\s+(-?\d+(?:\.\d+)?)\.\.\.(-?\d+(?:\.\d+)?)\s*dBFS/);
    return rangeMatch ? scoreForRange(loudness, Number(rangeMatch[1]), Number(rangeMatch[2]), 12) : scoreForRange(loudness, -24, -16, 12);
  }

  return null;
}

function formatDbfs(value) {
  return Number.isFinite(value) ? `${value} dBFS` : "нет данных";
}

function renderMetrics(metrics) {
  const metricGrid = document.querySelector(".metric-grid");

  metricGrid.innerHTML = metrics
    .map((metric, index) => {
      const state = normalizedMetricState(metric);
      const score = Number.isFinite(metric.score) ? metric.score : null;
      return `
        <article class="metric-card ${state === "good" ? "good" : state === "unavailable" ? "unavailable" : "warning"}">
          <div class="metric-top">
            ${metricIconSvg(state)}
            <span class="metric-badge">${metricBadge(state)}</span>
          </div>
          <strong class="metric-score">${metricScoreText(score)}</strong>
          <h2>${metric.title}</h2>
          <p>${metric.value}</p>
          <small>${metric.note || ""}</small>
        </article>
      `;
    })
    .join("");

}

function renderReport(practice, analytics) {
  currentReport = { practice, analytics };
  const recommendation = displayRecommendation(analytics);

  document.querySelector(".summary-copy h1").textContent = practice.original_filename;
  document.querySelector(".summary-text").textContent = recommendation.text;
  document.querySelector(".score-ring span").textContent = analytics.score;
  document.querySelector(".score-card strong").textContent = scoreLabel(analytics.score);
  document.querySelector(".score-card").setAttribute("aria-label", `Общая оценка ${analytics.score} из 100`);
  document.querySelector(".impression").textContent = `Общее впечатление: ${analytics.overall}.`;

  const strengthChips = document.querySelector(".strength-chips");
  strengthChips.innerHTML = (analytics.strengths || [])
    .map((s) => `<span>${s}</span>`)
    .join("");
  document.querySelector(".recommendation-card h2").textContent = recommendation.title;
  document.querySelector(".recommendation-card p:last-child").textContent = recommendation.text;

  document.querySelector(".report-meta").innerHTML = `
    <span>${formatDate(practice.created_at)}</span>
    <span>${formatDuration(practice.duration_seconds)}</span>
    <span>${scenarioNames[practice.scenario] || practice.scenario}</span>
  `;

  renderMetrics(analytics.metrics);
  renderRecording(practice, analytics);
  renderNextSteps(analytics.metrics, analytics.score);
  renderProgress(analytics.progress, analytics.score);
  document.body.classList.remove("is-report-loading");
}

async function downloadReport() {
  if (!currentReport) {
    return;
  }

  downloadReportButton.disabled = true;
  downloadReportButton.textContent = "Готовим PDF...";

  try {
    const blob = await apiBlobRequest(`/api/practices/${currentReport.practice.id}/report-pdf`);
    if (!blob) {
      return;
    }

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `speakeasy-report-${currentReport.practice.id}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    window.alert(error.message);
  } finally {
    downloadReportButton.disabled = false;
    downloadReportButton.textContent = "Скачать отчет";
  }
}

function renderRecording(practice, analytics) {
  const player = document.querySelector("[data-media-player]");
  const transcript = document.querySelector("[data-transcript-text]");
  const mediaUrl = `${API_BASE_URL}${practice.media_url}?token=${encodeURIComponent(token)}`;
  const loudnessDetails = getMetricDetails(analytics.metrics, "loudness_profile");
  const pauseDetails = getMetricDetails(analytics.metrics, "pause_profile");

  player.innerHTML =
    practice.media_type === "video"
      ? `<video controls src="${mediaUrl}"></video>`
      : `<audio controls src="${mediaUrl}"></audio>`;

  const media = player.querySelector("audio, video");
  normalizeMediaPlayerDuration(media, practice.duration_seconds);
  renderInteractiveRecordingTimeline(player, media, practice.duration_seconds, loudnessDetails, pauseDetails);
  renderTranscript(transcript, analytics);
}

function getMetricDetails(metrics, type) {
  return metrics.find((metric) => metric.details?.type === type)?.details || null;
}

function renderInteractiveRecordingTimeline(container, media, durationSeconds, loudnessDetails, pauseDetails) {
  if (!media || !loudnessDetails?.points?.length) {
    return;
  }

  const timelineDuration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : Math.max(...loudnessDetails.points.map((point) => point.time), 1);
  const timeline = document.createElement("div");
  timeline.className = "recording-timeline";
  timeline.innerHTML = `
    <div class="recording-timeline-heading">
      <div>
        <strong>Проверка по таймлайну</strong>
        <span>Кликните по графику или паузе, чтобы прослушать этот момент.</span>
      </div>
      <output data-sync-time>0:00</output>
    </div>
    <div class="recording-sync-chart" data-sync-chart>
      ${buildSyncedLoudnessChart(loudnessDetails, pauseDetails, timelineDuration)}
      <span class="recording-playhead" data-playhead></span>
    </div>
    <div class="recording-timeline-legend">
      <div class="tl-legend-item"><div class="tl-legend-swatch line"></div>Громкость</div>
      <div class="tl-legend-item"><div class="tl-legend-swatch norm"></div>Норма</div>
      <div class="tl-legend-item"><div class="tl-legend-swatch pause"></div>Длинная пауза</div>
    </div>
    ${buildPauseList(pauseDetails)}
  `;

  container.appendChild(timeline);

  const chart = timeline.querySelector("[data-sync-chart]");
  const playhead = timeline.querySelector("[data-playhead]");
  const syncTime = timeline.querySelector("[data-sync-time]");

  chart?.addEventListener("click", (event) => {
    const rect = chart.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    media.currentTime = ratio * timelineDuration;
    media.play().catch(() => {});
  });

  timeline.querySelectorAll("[data-seek-time]").forEach((button) => {
    button.addEventListener("click", () => {
      media.currentTime = Number(button.dataset.seekTime || 0);
      media.play().catch(() => {});
    });
  });

  const updatePlayhead = () => {
    const ratio = Math.max(0, Math.min(1, media.currentTime / timelineDuration));
    playhead.style.left = `${ratio * 100}%`;
    syncTime.textContent = formatClock(media.currentTime);

    timeline.querySelectorAll("[data-pause-end]").forEach((button) => {
      const start = Number(button.dataset.seekTime);
      const end   = Number(button.dataset.pauseEnd);
      button.classList.toggle("is-active", media.currentTime >= start && media.currentTime <= end);
    });
  };

  media.addEventListener("timeupdate", updatePlayhead);
  media.addEventListener("seeked", updatePlayhead);
  media.addEventListener("loadedmetadata", updatePlayhead);
  updatePlayhead();
}

function buildSyncedLoudnessChart(loudnessDetails, pauseDetails, durationSeconds) {
  const points = loudnessDetails.points.filter((point) => Number.isFinite(point.time) && Number.isFinite(point.dbfs));
  const width = 720;
  const height = 220;
  const plot = { left: 48, top: 22, right: 20, bottom: 42 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const minValue = -60;
  const maxValue = 0;
  const yFor = (dbfs) => plot.top + ((maxValue - Math.max(minValue, Math.min(maxValue, dbfs))) / (maxValue - minValue)) * plotHeight;
  const xFor = (time) => plot.left + (Math.max(0, Math.min(durationSeconds, time)) / durationSeconds) * plotWidth;
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xFor(point.time).toFixed(1)} ${yFor(point.dbfs).toFixed(1)}`)
    .join(" ");
  const normTop = yFor(loudnessDetails.norm_max);
  const normBottom = yFor(loudnessDetails.norm_min);
  const pauseRects = getOutOfNormPauses(pauseDetails).long
    .map((pause) => {
      const x = xFor(pause.start);
      const w = Math.max(xFor(pause.end) - x, 2);
      return `<rect class="sync-pause-band" x="${x.toFixed(1)}" y="${plot.top}" width="${w.toFixed(1)}" height="${plotHeight}" />`;
    })
    .join("");

  return `
    <svg class="sync-loudness-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Громкость и длинные паузы по времени">
      <rect class="loudness-norm-band" x="${plot.left}" y="${normTop}" width="${plotWidth}" height="${Math.max(normBottom - normTop, 1)}" />
      ${pauseRects}
      <line class="loudness-axis" x1="${plot.left}" y1="${plot.top + plotHeight}" x2="${plot.left + plotWidth}" y2="${plot.top + plotHeight}" />
      <line class="loudness-axis" x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.top + plotHeight}" />
      <text class="loudness-label" x="8" y="${yFor(loudnessDetails.norm_max) + 4}">${formatDbfs(loudnessDetails.norm_max)}</text>
      <text class="loudness-label" x="8" y="${yFor(loudnessDetails.norm_min) + 4}">${formatDbfs(loudnessDetails.norm_min)}</text>
      <text class="loudness-time" x="${plot.left}" y="${height - 12}">0:00</text>
      <text class="loudness-time" x="${plot.left + plotWidth}" y="${height - 12}" text-anchor="end">${formatClock(durationSeconds)}</text>
      <path class="loudness-line" d="${linePath}" />
    </svg>
  `;
}

function buildPauseList(pauseDetails) {
  const { long, normMax } = getOutOfNormPauses(pauseDetails);

  if (!long.length) {
    return `<p class="pause-empty">Длинных пауз больше ${formatPauseLimit(normMax)} сек не найдено.</p>`;
  }

  return `
    <div class="pause-jump-list" aria-label="Длинные паузы">
      <strong>Длинные паузы больше ${formatPauseLimit(normMax)} сек</strong>
      ${buildPauseButtonGroup("", long)}
    </div>
  `;

  if (!long.length) {
    return `<p class="pause-empty">Паузы вне нормы ${formatPauseLimit(normMin)}-${formatPauseLimit(normMax)} сек не найдены.</p>`;
  }

  return `
    <div class="pause-jump-list" aria-label="Паузы вне нормы">
      <strong>Паузы вне нормы ${formatPauseLimit(normMin)}-${formatPauseLimit(normMax)} сек</strong>
      ${buildPauseButtonGroup("Длинные", long)}
      ${buildPauseButtonGroup("Короткие", short)}
    </div>
  `;

  const longPauses = pauseDetails?.long_pauses || [];

  if (!longPauses.length) {
    return `<p class="pause-empty">Длинных пауз не найдено.</p>`;
  }

  return `
    <div class="pause-jump-list" aria-label="Длинные паузы">
      <strong>Длинные паузы</strong>
      <div>
        ${longPauses.slice(0, 8).map((pause) => `
          <button type="button" data-seek-time="${pause.start}">
            ${formatClock(pause.start)} · ${pause.duration.toFixed(1)} сек
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function getOutOfNormPauses(pauseDetails) {
  const pauses = Array.isArray(pauseDetails?.pauses) ? pauseDetails.pauses : [];
  const normMin = Number.isFinite(pauseDetails?.norm_min) ? Number(pauseDetails.norm_min) : 0.3;
  const normMax = Number.isFinite(pauseDetails?.norm_max) ? Number(pauseDetails.norm_max) : 5.0;

  return {
    normMin,
    normMax,
    short: pauses.filter((pause) => Number(pause.duration) < normMin),
    long: pauses.filter((pause) => Number(pause.duration) > normMax),
  };
}

function buildPauseButtonGroup(label, pauses) {
  if (!pauses.length) {
    return "";
  }

  return `
    <div class="pause-jump-group">
      ${label ? `<span>${label}</span>` : ""}
      <div>
        ${pauses.slice(0, 8).map((pause) => `
          <button type="button" data-seek-time="${pause.start}" data-pause-end="${Number(pause.start) + Number(pause.duration)}">
            ${formatClock(pause.start)} · ${Number(pause.duration).toFixed(1)} сек
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function formatPauseLimit(value) {
  return Number(value).toFixed(1);
}

function normalizeMediaPlayerDuration(media, expectedDuration) {
  if (!media) {
    return;
  }

  media.addEventListener("loadedmetadata", () => {
    const hasExpectedDuration = Number.isFinite(expectedDuration) && expectedDuration > 0;
    const durationLooksWrong =
      !Number.isFinite(media.duration) ||
      media.duration <= 0 ||
      (hasExpectedDuration && Math.abs(media.duration - expectedDuration) > 2);

    if (!durationLooksWrong) {
      return;
    }

    const restoreStart = () => {
      media.removeEventListener("timeupdate", restoreStart);
      media.currentTime = 0;
    };

    media.addEventListener("timeupdate", restoreStart);
    media.currentTime = Number.MAX_SAFE_INTEGER;
  }, { once: true });
}

function renderTranscript(container, analytics) {
  const blocks = analytics.transcript_blocks?.length
    ? analytics.transcript_blocks
    : analytics.transcript?.trim()
      ? [{ type: "text", text: analytics.transcript }]
      : [];

  if (!blocks.length) {
    container.textContent = "GigaAM не распознал речь в этой записи или транскрибация пока недоступна.";
    return;
  }

  container.replaceChildren();

  blocks.forEach((block, index) => {
    if (block.type === "pause") {
      return;
    }

    appendHighlightedText(container, `${index > 0 ? " " : ""}${block.text}`);
  });
}

function appendHighlightedText(container, text) {
  const pattern = new RegExp(
    `(^|[^A-Za-zА-Яа-яЁё])(${fillerWords.map(escapeRegExp).join("|")})(?=$|[^A-Za-zА-Яа-яЁё])`,
    "giu"
  );
  let lastIndex = 0;

  text.replace(pattern, (match, prefix, word, offset) => {
    const wordOffset = offset + prefix.length;

    if (wordOffset > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, wordOffset)));
    }

    const mark = document.createElement("mark");
    mark.className = "filler-highlight";
    mark.textContent = word;
    container.appendChild(mark);
    lastIndex = wordOffset + word.length;
    return match;
  });

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderNextSteps(metrics, score) {
  const nextSteps = document.querySelector(".next-steps");
  const nextStepGrid = document.querySelector(".next-step-grid");

  if (score >= 100) {
    nextSteps.hidden = true;
    nextStepGrid.innerHTML = "";
    return;
  }

  nextSteps.hidden = false;
  const availableMetrics = metrics.filter((metric) => normalizedMetricState(metric) !== "unavailable");
  const warnings = availableMetrics.filter((metric) => normalizedMetricState(metric) !== "good");
  const items = (warnings.length ? warnings : availableMetrics).slice(0, 3);

  nextStepGrid.innerHTML = items
    .map(
      (metric, index) => `
        <article>
          <span>${index + 1}</span>
          <h3>${metric.title}</h3>
          <p>${metric.value}</p>
        </article>
      `
    )
    .join("");
}

function renderProgress(progress, score) {
  const progressSummary = document.querySelector(".progress-summary");
  const chartWrap = document.querySelector(".chart-wrap");
  const points = normalizeProgress(progress, score);
  const bestScore = Math.max(score, ...progress.map((item) => item.score));
  const firstScore = points[0]?.score ?? score;
  const delta = score - firstScore;
  const deltaText = delta > 0 ? `+${delta}` : String(delta);

  progressSummary.innerHTML = `
    <span><strong>${deltaText}</strong> к первой практике</span>
    <span><strong>${bestScore}</strong> лучший результат</span>
  `;

  chartWrap.innerHTML = buildProgressChart(points);
}

function normalizeProgress(progress, fallbackScore) {
  const points = Array.isArray(progress) ? progress.filter((item) => Number.isFinite(item.score)) : [];

  if (points.length) {
    return points;
  }

  return [
    {
      date: new Intl.DateTimeFormat("ru-RU").format(new Date()),
      score: fallbackScore,
    },
  ];
}

function buildProgressChart(points) {
  const width = 1040;
  const height = 430;
  const plot = {
    left: 88,
    top: 54,
    right: 72,
    bottom: 82,
  };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const pointCount = points.length;
  const coordinates = points.map((point, index) => {
    const x = pointCount === 1 ? plot.left + plotWidth / 2 : plot.left + (plotWidth / (pointCount - 1)) * index;
    const y = plot.top + plotHeight - (Math.max(0, Math.min(point.score, 100)) / 100) * plotHeight;
    return { ...point, x, y };
  });
  const linePath = coordinates.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
  const areaPath =
    pointCount > 1
      ? `${linePath}L${coordinates.at(-1).x} ${plot.top + plotHeight}L${coordinates[0].x} ${plot.top + plotHeight}Z`
      : "";
  const labels = coordinates
    .map(
      (point) => `
        <text x="${point.x}" y="${height - 36}" text-anchor="middle">${point.date}</text>
      `
    )
    .join("");
  const markers = coordinates
    .map(
      (point) => {
        const marker = `
          <line class="point-guide" x1="${point.x}" y1="${point.y}" x2="${point.x}" y2="${plot.top + plotHeight}" />
          <circle class="point-dot" cx="${point.x}" cy="${point.y}" r="9" />
          <text class="point-score" x="${point.x}" y="${point.y - 18}" text-anchor="middle">${point.score}</text>
        `;

        return point.practice_id
          ? `<a class="chart-point-link" href="analytics.html?practice_id=${point.practice_id}" aria-label="Открыть практику от ${point.date}, оценка ${point.score}">${marker}</a>`
          : `<g>${marker}</g>`;
      }
    )
    .join("");

  return `
    <svg class="progress-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="График прогресса по практикам с одинаковым названием файла">
      <defs>
        <linearGradient id="progressFill" x1="120" y1="320" x2="900" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#9ad9a4" stop-opacity="0.45" />
          <stop offset="0.55" stop-color="#c7f1dd" stop-opacity="0.45" />
          <stop offset="1" stop-color="#5482e6" stop-opacity="0.35" />
        </linearGradient>
        <linearGradient id="progressStroke" x1="120" y1="320" x2="900" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#49a47c" />
          <stop offset="1" stop-color="#2563eb" />
        </linearGradient>
      </defs>

      <line x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.top + plotHeight}" class="axis-line" />
      <line x1="${plot.left}" y1="${plot.top + plotHeight}" x2="${plot.left + plotWidth}" y2="${plot.top + plotHeight}" class="axis-line" />
      <line x1="${plot.left}" y1="${plot.top + plotHeight * 0.25}" x2="${plot.left + plotWidth}" y2="${plot.top + plotHeight * 0.25}" class="grid-line" />
      <line x1="${plot.left}" y1="${plot.top + plotHeight * 0.5}" x2="${plot.left + plotWidth}" y2="${plot.top + plotHeight * 0.5}" class="grid-line" />
      <line x1="${plot.left}" y1="${plot.top + plotHeight * 0.75}" x2="${plot.left + plotWidth}" y2="${plot.top + plotHeight * 0.75}" class="grid-line" />

      ${areaPath ? `<path class="chart-area" d="${areaPath}" />` : ""}
      ${pointCount > 1 ? `<path class="chart-line" d="${linePath}" />` : ""}

      <g class="chart-points">${markers}</g>
      <g class="chart-labels">${labels}</g>
    </svg>
  `;
}

async function loadReport() {
  try {
    const [practice, analytics] = await Promise.all([
      apiRequest(`/api/practices/${practiceId}`),
      apiRequest(`/api/practices/${practiceId}/analytics`),
    ]);

    if (practice && analytics) {
      renderReport(practice, analytics);
    }
  } catch (error) {
    window.alert(error.message);
    window.location.href = "lk.html";
  }
}

downloadReportButton?.addEventListener("click", downloadReport);

loadReport();
