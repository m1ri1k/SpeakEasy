const SPEAKEASY_API_BASE_URL = (() => {
  if (!window.location.hostname || window.location.protocol === "file:") {
    return "http://192.168.1.8:8000";
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:8000`;
})();
const SPEAKEASY_TOKEN_KEY = "speakeasy_token";
const SPEAKEASY_USER_KEY = "speakeasy_user";
const SPEAKEASY_SESSION_EXPIRES_KEY = "speakeasy_session_expires_at";
const SPEAKEASY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SPEAKEASY_TOUCH_INTERVAL_MS = 60 * 1000;
let sessionExpiryTimer = null;
let lastSessionTouchAt = 0;

function clearSpeakEasySession() {
  localStorage.removeItem(SPEAKEASY_TOKEN_KEY);
  localStorage.removeItem(SPEAKEASY_USER_KEY);
  localStorage.removeItem(SPEAKEASY_SESSION_EXPIRES_KEY);
}

function getSpeakEasySessionExpiresAt() {
  const expiresAt = localStorage.getItem(SPEAKEASY_SESSION_EXPIRES_KEY);
  return expiresAt ? Date.parse(expiresAt) : Number.NaN;
}

function redirectToLogin() {
  window.location.href = "main.html";
}

function expireSpeakEasySession() {
  clearSpeakEasySession();
  redirectToLogin();
}

function scheduleSpeakEasySessionExpiry() {
  const token = localStorage.getItem(SPEAKEASY_TOKEN_KEY);
  const expiresAt = getSpeakEasySessionExpiresAt();

  if (!token || Number.isNaN(expiresAt)) {
    return;
  }

  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    expireSpeakEasySession();
    return;
  }

  clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = window.setTimeout(expireSpeakEasySession, remaining);
}

function extendLocalSpeakEasySession() {
  if (!localStorage.getItem(SPEAKEASY_TOKEN_KEY)) {
    return;
  }

  localStorage.setItem(SPEAKEASY_SESSION_EXPIRES_KEY, new Date(Date.now() + SPEAKEASY_IDLE_TIMEOUT_MS).toISOString());
  scheduleSpeakEasySessionExpiry();
}

async function touchSpeakEasySession() {
  const token = localStorage.getItem(SPEAKEASY_TOKEN_KEY);

  if (!token || Date.now() - lastSessionTouchAt < SPEAKEASY_TOUCH_INTERVAL_MS) {
    return;
  }

  lastSessionTouchAt = Date.now();

  try {
    const response = await fetch(`${SPEAKEASY_API_BASE_URL}/api/auth/touch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 401) {
      expireSpeakEasySession();
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (data.expires_at) {
      localStorage.setItem(SPEAKEASY_SESSION_EXPIRES_KEY, data.expires_at);
      scheduleSpeakEasySessionExpiry();
    }
  } catch {
    // Keep the local idle timer; the next API request will verify the server session.
  }
}

function handleSpeakEasyActivity() {
  extendLocalSpeakEasySession();
  touchSpeakEasySession();
}

function initSpeakEasySessionExpiry() {
  if (!localStorage.getItem(SPEAKEASY_TOKEN_KEY)) {
    return;
  }

  extendLocalSpeakEasySession();
  touchSpeakEasySession();

  ["click", "keydown", "mousemove", "scroll", "touchstart", "input"].forEach((eventName) => {
    window.addEventListener(eventName, handleSpeakEasyActivity, { passive: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      handleSpeakEasyActivity();
    }
  });
}

async function logoutSpeakEasy() {
  const token = localStorage.getItem(SPEAKEASY_TOKEN_KEY);

  if (token) {
    await fetch(`${SPEAKEASY_API_BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }).catch(() => {});
  }

  clearSpeakEasySession();
  redirectToLogin();
}

function initLogoutControls() {
  document.querySelectorAll("[data-action='logout']").forEach((button) => {
    button.addEventListener("click", logoutSpeakEasy);
  });
}

initSpeakEasySessionExpiry();
initLogoutControls();
