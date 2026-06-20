(function () {
  const API_BASE_URL = (() => {
    if (!window.location.hostname || window.location.protocol === "file:") {
      return "http://192.168.1.8:8000";
    }
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${window.location.hostname}:8000`;
  })();
  const REMINDER_ENABLED_KEY = "speakeasy_reminder_enabled";
  const REMINDER_INTERVAL_KEY = "speakeasy_reminder_interval";
  const REMINDER_ACTIVE_KEY = "speakeasy_reminder_active";
  const REMINDER_DISMISSED_KEY = "speakeasy_reminder_dismissed_at";
  const REMINDER_CHANGED_KEY = "speakeasy_reminder_changed_at";
  const DEFAULT_INTERVAL_DAYS = 7;

  let latestDueAt = null;

  function getToken() {
    return localStorage.getItem("speakeasy_token");
  }

  function getSettings() {
    const interval = Number(localStorage.getItem(REMINDER_INTERVAL_KEY));
    return {
      enabled: localStorage.getItem(REMINDER_ENABLED_KEY) === "true",
      intervalDays: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_DAYS,
      changedAt: parseDate(localStorage.getItem(REMINDER_CHANGED_KEY)),
    };
  }

  function parseDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function getPluralForm(value, one, few, many) {
    const normalized = Math.abs(value) % 100;
    const lastDigit = normalized % 10;
    if (normalized > 10 && normalized < 20) return many;
    if (lastDigit === 1) return one;
    if (lastDigit > 1 && lastDigit < 5) return few;
    return many;
  }

  function formatInterval(days) {
    if (days < 1) {
      const minutes = Math.max(1, Math.round(days * 24 * 60));
      return minutes === 1
        ? "минуты"
        : `${minutes} ${getPluralForm(minutes, "минуты", "минут", "минут")}`;
    }

    const roundedDays = Math.round(days);
    return `${roundedDays} ${getPluralForm(roundedDays, "дня", "дней", "дней")}`;
  }

  function wasDismissedAfter(date) {
    const dismissedAt = parseDate(localStorage.getItem(REMINDER_DISMISSED_KEY));
    return Boolean(dismissedAt && date && dismissedAt >= date);
  }

  function setBellMessage(message) {
    const bellDot = document.querySelector("[data-bell-dot]");
    const bellText = document.querySelector("[data-bell-text]");
    const bellDropdown = document.querySelector("[data-bell-dropdown]");

    if (message) {
      localStorage.setItem(REMINDER_ACTIVE_KEY, message);
    } else {
      localStorage.removeItem(REMINDER_ACTIVE_KEY);
      if (bellDropdown) bellDropdown.hidden = true;
    }

    if (bellDot) bellDot.hidden = !message;
    if (bellText) {
      bellText.textContent = message || "Новых уведомлений нет.";
    }
  }

  function getLatestPractice(practices) {
    return practices
      .filter((practice) => practice.status !== "deleted")
      .map((practice) => ({
        practice,
        createdAt: parseDate(practice.created_at),
      }))
      .filter((item) => item.createdAt)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  async function refreshPracticeReminder() {
    const { enabled, intervalDays, changedAt } = getSettings();
    const token = getToken();

    if (!enabled || !token) {
      latestDueAt = null;
      setBellMessage("");
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/practices?include_deleted=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        return;
      }

      const practices = await response.json();
      const latestPractice = getLatestPractice(Array.isArray(practices) ? practices : []);
      const now = new Date();
      const reminderStartedAt = changedAt || now;

      if (!latestPractice) {
        const dueAt = new Date(reminderStartedAt.getTime() + intervalDays * 24 * 60 * 60 * 1000);
        latestDueAt = dueAt;
        if (now >= dueAt && !localStorage.getItem(REMINDER_DISMISSED_KEY)) {
          setBellMessage("Самое время записать первую практику.");
        } else {
          setBellMessage("");
        }
        return;
      }

      const startAt = latestPractice.createdAt > reminderStartedAt ? latestPractice.createdAt : reminderStartedAt;
      const dueAt = new Date(startAt.getTime() + intervalDays * 24 * 60 * 60 * 1000);
      latestDueAt = dueAt;

      if (now >= dueAt && !wasDismissedAfter(dueAt)) {
        setBellMessage(`Прошло больше ${formatInterval(intervalDays)} без новой практики. Пора потренироваться.`);
      } else {
        setBellMessage("");
      }
    } catch (error) {
      console.warn("Не удалось обновить напоминание о практике", error);
    }
  }

  function initBell() {
    const bellWrap = document.querySelector("[data-bell-wrap]");
    const bellButton = document.querySelector("[data-bell-button]");
    const bellDropdown = document.querySelector("[data-bell-dropdown]");
    const bellDismiss = document.querySelector("[data-bell-dismiss]");

    if (!bellWrap || !bellButton) return;

    setBellMessage("");
    refreshPracticeReminder();

    bellButton.addEventListener("click", () => {
      refreshPracticeReminder();
      if (bellDropdown) bellDropdown.hidden = !bellDropdown.hidden;
    });

    bellDismiss?.addEventListener("click", () => {
      localStorage.setItem(REMINDER_DISMISSED_KEY, new Date().toISOString());
      setBellMessage("");
      if (bellDropdown) bellDropdown.hidden = true;
    });

    document.addEventListener("click", (event) => {
      if (!bellWrap.contains(event.target) && bellDropdown) {
        bellDropdown.hidden = true;
      }
    });

    window.addEventListener("storage", (event) => {
      if ([REMINDER_ENABLED_KEY, REMINDER_INTERVAL_KEY, REMINDER_DISMISSED_KEY, REMINDER_CHANGED_KEY].includes(event.key)) {
        refreshPracticeReminder();
      }
    });

    document.addEventListener("speakeasy:reminder-settings-changed", refreshPracticeReminder);
    window.setInterval(refreshPracticeReminder, 60 * 1000);
  }

  initBell();
})();
