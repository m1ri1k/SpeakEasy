const REMINDER_ENABLED_KEY = "speakeasy_reminder_enabled";
const REMINDER_INTERVAL_KEY = "speakeasy_reminder_interval";
const REMINDER_ACTIVE_KEY = "speakeasy_reminder_active";
const REMINDER_DISMISSED_KEY = "speakeasy_reminder_dismissed_at";
const REMINDER_CHANGED_KEY = "speakeasy_reminder_changed_at";

const token = localStorage.getItem("speakeasy_token");

if (!token) {
  window.location.href = "main.html";
}

const reminderEnabledInput = document.getElementById("reminderEnabled");
const reminderIntervalSelect = document.getElementById("reminderInterval");
const reminderIntervalRow = document.getElementById("reminderIntervalRow");

function loadSettings() {
  return {
    enabled: localStorage.getItem(REMINDER_ENABLED_KEY) === "true",
    interval: localStorage.getItem(REMINDER_INTERVAL_KEY) || "7",
  };
}

function setIntervalRowVisible(visible) {
  if (!reminderIntervalRow) return;
  reminderIntervalRow.style.display = visible ? "flex" : "none";
}

function applySettings({ enabled, interval }) {
  if (reminderEnabledInput) reminderEnabledInput.checked = enabled;
  if (reminderIntervalSelect) reminderIntervalSelect.value = interval;
  setIntervalRowVisible(enabled);
}

function notifyReminderSettingsChanged() {
  document.dispatchEvent(new CustomEvent("speakeasy:reminder-settings-changed"));
}

reminderEnabledInput?.addEventListener("change", () => {
  const enabled = reminderEnabledInput.checked;
  localStorage.setItem(REMINDER_ENABLED_KEY, String(enabled));
  localStorage.setItem(REMINDER_CHANGED_KEY, new Date().toISOString());
  setIntervalRowVisible(enabled);
  localStorage.removeItem(REMINDER_DISMISSED_KEY);
  if (!enabled) {
    localStorage.removeItem(REMINDER_ACTIVE_KEY);
  }
  notifyReminderSettingsChanged();
});

reminderIntervalSelect?.addEventListener("change", () => {
  localStorage.setItem(REMINDER_INTERVAL_KEY, reminderIntervalSelect.value);
  localStorage.setItem(REMINDER_CHANGED_KEY, new Date().toISOString());
  localStorage.removeItem(REMINDER_DISMISSED_KEY);
  notifyReminderSettingsChanged();
});

applySettings(loadSettings());
