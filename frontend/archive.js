const archiveList = document.querySelector("[data-archive-list]");
const archiveCount = document.querySelector("[data-archive-count]");
const archiveTabs = document.querySelectorAll("[data-archive-filter]");

const API_BASE_URL = (() => {
  if (!window.location.hostname || window.location.protocol === "file:") {
    return "http://192.168.1.8:8000";
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:8000`;
})();
const token = localStorage.getItem("speakeasy_token");

const scenarioNames = {
  presentation: "Презентация",
  pitch: "Бизнес-питч",
  podcast: "Подкаст",
  free: "Свободная практика",
};

let currentArchiveFilter = "all";
let currentPractices = [];

if (!token) {
  window.location.href = "main.html";
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

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(new Date(value));
}

function practiceActivityTime(practice) {
  return new Date(practice.deleted_at || practice.created_at).getTime() || 0;
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function archiveEmptyText(filter) {
  return {
    all: "В архиве пока пусто",
    done: "Готовых отчетов в архиве пока нет",
    drafts: "Черновиков и обработок в архиве пока нет",
    trash: "Корзина пуста",
  }[filter] || "Здесь пока пусто";
}

function trashDaysLeft(practice) {
  if (!practice.trash_expires_at) {
    return 0;
  }

  const diffMs = new Date(practice.trash_expires_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(diffMs / 86400000));
}

function daysWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return "дней";
  if (mod10 === 1) return "день";
  if (mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}

function trashRetentionText(practice) {
  const days = trashDaysLeft(practice);
  if (days <= 0) {
    return "Будет окончательно удалено в ближайшее время.";
  }
  return `Осталось ${days} ${daysWord(days)} до окончательного удаления.`;
}

function filteredArchiveItems(practices) {
  return [...practices].sort((a, b) => practiceActivityTime(b) - practiceActivityTime(a)).filter((practice) => {
    if (currentArchiveFilter === "done") {
      return practice.status === "done";
    }
    if (currentArchiveFilter === "drafts") {
      return practice.status === "draft" || practice.status === "processing";
    }
    if (currentArchiveFilter === "trash") {
      return practice.status === "deleted";
    }
    return true;
  });
}

function renderArchive(practices) {
  const items = filteredArchiveItems(practices);

  if (archiveCount) {
    archiveCount.textContent = `${items.length} ${items.length === 1 ? "запись" : "записей"}`;
  }

  if (!items.length) {
    archiveList.innerHTML = `<div class="history-empty">${archiveEmptyText(currentArchiveFilter)}</div>`;
    return;
  }

  const trashNotice = currentArchiveFilter === "trash" ? trashRetentionNotice() : "";

  archiveList.innerHTML = trashNotice + items
    .map((practice) => {
      const isDone = practice.status === "done";
      const isDeleted = practice.status === "deleted";
      const trashNote = isDeleted
        ? `<small class="trash-retention-note">${trashRetentionText(practice)}</small>`
        : "";
      const statusContent = practice.status === "processing"
        ? `<span class="status-badge-label">${statusLabel(practice.status)}</span>`
        : statusLabel(practice.status);

      return `
        <article class="history-item ${isDeleted ? "is-deleted" : ""}" data-practice-id="${practice.id}">
          <svg class="file-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          <div class="file-info">
            <h3>${escapeHtml(practice.original_filename)}</h3>
            <p>${scenarioNames[practice.scenario] || practice.scenario} • ${practice.media_type === "audio" ? "аудио" : "видео"} • ${formatDate(practice.created_at)}</p>
            ${trashNote}
          </div>
          <span class="status-badge ${statusClass(practice.status)}">${statusContent}</span>
          <div class="history-actions">
            ${isDone ? `<a class="history-action primary" href="analytics.html?practice_id=${practice.id}">Отчет</a>` : ""}
            ${isDeleted ? `<button class="history-action" type="button" data-action="restore-practice">Восстановить</button>` : `<button class="history-action danger" type="button" data-action="delete-practice">В корзину</button>`}
          </div>
        </article>
      `;
    })
    .join("");
}

function trashRetentionNotice() {
  return `
    <div class="trash-retention-banner">
      Записи в корзине хранятся 30 дней, после этого удаляются окончательно без возможности восстановления.
    </div>
  `;
}

async function loadArchive() {
  const practices = await apiRequest("/api/practices?include_deleted=true");
  if (practices) {
    currentPractices = practices;
    renderArchive(currentPractices);
  }
}

async function deletePractice(practiceId) {
  await apiRequest(`/api/practices/${practiceId}`, { method: "DELETE" });
  await loadArchive();
}

async function restorePractice(practiceId) {
  await apiRequest(`/api/practices/${practiceId}/restore`, { method: "POST" });
  await loadArchive();
}

archiveTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    currentArchiveFilter = tab.dataset.archiveFilter;
    archiveTabs.forEach((currentTab) => {
      const isSelected = currentTab === tab;
      currentTab.classList.toggle("is-active", isSelected);
      currentTab.setAttribute("aria-pressed", String(isSelected));
    });
    renderArchive(currentPractices);
  });
});

archiveList?.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;

  const item = actionButton.closest("[data-practice-id]");
  const practiceId = item?.dataset.practiceId;
  if (!practiceId) return;

  actionButton.disabled = true;
  try {
    if (actionButton.dataset.action === "delete-practice") {
      await deletePractice(practiceId);
    }
    if (actionButton.dataset.action === "restore-practice") {
      await restorePractice(practiceId);
    }
  } catch (error) {
    window.alert(error.message);
  } finally {
    actionButton.disabled = false;
  }
});

loadArchive().catch((error) => {
  archiveList.innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`;
});
