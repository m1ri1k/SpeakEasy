const buttons = document.querySelectorAll("button");
const figmaAssets = document.querySelectorAll("img[data-fallback]");
const loginButton = document.querySelector("[data-action='login']");
const profileMenu = document.querySelector(".profile-menu");
const startButton = document.querySelector("[data-action='start']");
const tryButton = document.querySelector("[data-action='try']");
const heroActions = document.querySelector(".hero-actions");
const authModal = document.querySelector("#auth-modal");
const authDialog = document.querySelector(".auth-dialog");
const authForm = document.querySelector("#auth-form");
const authTitle = document.querySelector("#auth-title");
const authTabs = document.querySelectorAll("[data-auth-mode]");
const authCloseButtons = document.querySelectorAll("[data-auth-close]");
const authNameField = document.querySelector("[data-name-field]");
const authPasswordField = document.querySelector("[data-password-field]");
const authPasswordConfirmField = document.querySelector("[data-password-confirm-field]");
const authError = document.querySelector("[data-auth-error]");
const authStatus = document.querySelector("[data-auth-status]");
const authStatusText = document.querySelector("[data-auth-status-text]");
const authResetLink = document.querySelector("[data-auth-reset-link]");
const authSubmit = document.querySelector(".auth-submit");
const forgotPasswordButton = document.querySelector("[data-auth-forgot]");
const passwordToggle = document.querySelector("[data-password-toggle]");
const passwordConfirmToggle = document.querySelector("[data-password-confirm-toggle]");
const revealItems = document.querySelectorAll(
  ".hero-content, .hero-asset, .section-title-row, .step, .how-asset, .insights-heading, .insight-card, .report-preview, .audience-section h2, .audience-card, .audience-asset, .route-line"
);

const API_BASE_URL = (() => {
  if (!window.location.hostname || window.location.protocol === "file:") {
    return "http://192.168.1.8:8000";
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:8000`;
})();
const SESSION_EXPIRES_KEY = "speakeasy_session_expires_at";
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
let authMode = "login";
let forgotCooldownTimer = null;
let sessionExpiryTimer = null;
let lastSessionTouchAt = 0;

initSessionExpiry();
updateAuthUi();
openResetModalFromUrl();

figmaAssets.forEach((asset) => {
  asset.addEventListener("error", () => {
    const fallback = asset.dataset.fallback;

    if (fallback && asset.src.endsWith(".svg")) {
      asset.src = fallback;
      return;
    }

    asset.hidden = true;
  });
});

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    {
      rootMargin: "0px 0px -12% 0px",
      threshold: 0.12,
    }
  );

  revealItems.forEach((item, index) => {
    item.classList.add("reveal");
    item.style.setProperty("--reveal-delay", `${Math.min(index % 5, 4) * 90}ms`);
    revealObserver.observe(item);
  });
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

buttons.forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;

    if (action === "start" || action === "try") {
      if (hasActiveSession()) {
        window.location.href = "lk.html";
        return;
      }

      openAuthModal("register");
    }

    if (action === "login") {
      if (hasActiveSession()) {
        window.location.href = "lk.html";
        return;
      }

      openAuthModal("login");
    }

    if (action === "logout") {
      logout();
    }

  });
});

function updateAuthUi() {
  const isAuthenticated = hasActiveSession();
  const cachedUser = getCachedUser();

  document.body.classList.toggle("is-authenticated", isAuthenticated);

  if (loginButton) {
    loginButton.textContent = isAuthenticated ? "Кабинет" : "Войти";
    loginButton.classList.toggle("is-profile", isAuthenticated);
    loginButton.setAttribute("aria-label", isAuthenticated ? "Открыть личный кабинет" : "Войти");
  }

  if (profileMenu) {
    profileMenu.classList.toggle("is-authenticated", isAuthenticated);
  }

  if (startButton) {
    startButton.textContent = "Начать";
  }

  if (tryButton) {
    tryButton.textContent = "Попробовать";
    tryButton.classList.remove("user-pill");
  }

  if (heroActions) {
    heroActions.hidden = isAuthenticated;
  }

  document.body.classList.remove("is-main-loading");
}

function hasActiveSession() {
  const token = localStorage.getItem("speakeasy_token");
  const expiresAt = localStorage.getItem(SESSION_EXPIRES_KEY);

  if (!token) {
    return false;
  }

  if (!expiresAt) {
    return true;
  }

  if (Date.parse(expiresAt) <= Date.now()) {
    clearStoredSession();
    return false;
  }

  return true;
}

function clearStoredSession() {
  localStorage.removeItem("speakeasy_token");
  localStorage.removeItem("speakeasy_user");
  localStorage.removeItem(SESSION_EXPIRES_KEY);
}

function initSessionExpiry() {
  if (!localStorage.getItem("speakeasy_token")) {
    return;
  }

  extendLocalSession();
  touchSession();

  ["click", "keydown", "mousemove", "scroll", "touchstart", "input"].forEach((eventName) => {
    window.addEventListener(eventName, handleSessionActivity, { passive: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      handleSessionActivity();
    }
  });
}

function scheduleSessionExpiry() {
  const expiresAt = localStorage.getItem(SESSION_EXPIRES_KEY);
  const expiresAtTime = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtTime)) {
    return;
  }

  const remaining = expiresAtTime - Date.now();
  if (remaining <= 0) {
    clearStoredSession();
    return;
  }

  clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = window.setTimeout(() => {
    clearStoredSession();
    updateAuthUi();
  }, remaining);
}

function extendLocalSession() {
  if (!localStorage.getItem("speakeasy_token")) {
    return;
  }

  localStorage.setItem(SESSION_EXPIRES_KEY, new Date(Date.now() + SESSION_IDLE_TIMEOUT_MS).toISOString());
  scheduleSessionExpiry();
}

async function touchSession() {
  const token = localStorage.getItem("speakeasy_token");

  if (!token || Date.now() - lastSessionTouchAt < SESSION_TOUCH_INTERVAL_MS) {
    return;
  }

  lastSessionTouchAt = Date.now();

  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/touch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 401) {
      clearStoredSession();
      updateAuthUi();
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (data.expires_at) {
      localStorage.setItem(SESSION_EXPIRES_KEY, data.expires_at);
      scheduleSessionExpiry();
    }
  } catch {
    // Keep the local idle timer; the next API request will verify the server session.
  }
}

function handleSessionActivity() {
  extendLocalSession();
  touchSession();
}

function getCachedUser() {
  try {
    return JSON.parse(localStorage.getItem("speakeasy_user"));
  } catch {
    return null;
  }
}

async function logout() {
  const token = localStorage.getItem("speakeasy_token");

  if (token) {
    await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }).catch(() => {});
  }

  clearStoredSession();
  updateAuthUi();
}

function openAuthModal(mode = "login") {
  setAuthMode(mode);
  authModal.hidden = false;
  document.body.classList.add("modal-open");
  if (mode === "reset") {
    authForm.password.focus();
  } else {
    authForm.email.focus();
  }
}

function closeAuthModal() {
  authModal.hidden = true;
  document.body.classList.remove("modal-open");
  setAuthMessage("");
  setAuthStatus("");
}

function setAuthMode(mode) {
  clearForgotCooldown();
  authMode = mode;
  const isRegister = mode === "register";
  const isForgot = mode === "forgot";
  const isReset = mode === "reset";

  authTabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.authMode === mode);
  });

  authTitle.textContent = getAuthTitle(mode);
  authSubmit.textContent = getAuthSubmitText(mode);
  authNameField.hidden = !isRegister;
  authForm.name.required = isRegister;
  authPasswordField.hidden = isForgot;
  authForm.password.required = !isForgot;
  authPasswordConfirmField.hidden = !isReset;
  authForm.password_confirm.required = isReset;
  authForm.password.autocomplete = isRegister ? "new-password" : "current-password";
  if (isReset) {
    authForm.password.autocomplete = "new-password";
  }
  authTabs.forEach((tab) => {
    tab.hidden = isReset;
  });
  forgotPasswordButton.hidden = mode !== "login";
  setAuthMessage("");
  setAuthStatus("");
  resetPasswordVisibility();
}

function getAuthTitle(mode) {
  if (mode === "register") {
    return "Создать аккаунт";
  }
  if (mode === "forgot") {
    return "Восстановить пароль";
  }
  if (mode === "reset") {
    return "Задайте новый пароль";
  }
  return "Войти в SpeakEasy";
}

function getAuthSubmitText(mode) {
  if (mode === "register") {
    return "Зарегистрироваться";
  }
  if (mode === "forgot") {
    return "Отправить ссылку";
  }
  if (mode === "reset") {
    return "Сохранить пароль";
  }
  return "Войти";
}

function setAuthMessage(message, isSuccess = false) {
  authError.textContent = message;
  authError.classList.toggle("is-success", isSuccess);
}

function setAuthStatus(message, resetUrl = "") {
  authStatus.hidden = !message;
  authStatusText.textContent = message;
  authResetLink.hidden = !resetUrl;

  if (resetUrl) {
    authResetLink.href = resetUrl;
  } else {
    authResetLink.removeAttribute("href");
  }
}

function startForgotCooldown(seconds = 30) {
  let remaining = seconds;
  authSubmit.disabled = true;
  authSubmit.textContent = `Повторить через ${remaining} сек`;

  clearInterval(forgotCooldownTimer);
  forgotCooldownTimer = window.setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      clearInterval(forgotCooldownTimer);
      forgotCooldownTimer = null;
      authSubmit.disabled = false;
      authSubmit.textContent = getAuthSubmitText(authMode);
      return;
    }

    authSubmit.textContent = `Повторить через ${remaining} сек`;
  }, 1000);
}

function clearForgotCooldown() {
  if (forgotCooldownTimer) {
    clearInterval(forgotCooldownTimer);
    forgotCooldownTimer = null;
  }

  authSubmit.disabled = false;
  authSubmit.textContent = getAuthSubmitText(authMode);
}

function togglePasswordVisibility(input, button) {
  const isVisible = input.type === "text";
  input.type = isVisible ? "password" : "text";
  button.classList.toggle("is-visible", !isVisible);
  button.setAttribute("aria-label", isVisible ? "Показать пароль" : "Скрыть пароль");
  button.title = isVisible ? "Показать пароль" : "Скрыть пароль";
}

function resetPasswordVisibility() {
  [authForm.password, authForm.password_confirm].forEach((input) => {
    if (input) {
      input.type = "password";
    }
  });

  [passwordToggle, passwordConfirmToggle].forEach((button) => {
    if (button) {
      button.classList.remove("is-visible");
      button.setAttribute("aria-label", "Показать пароль");
      button.title = "Показать пароль";
    }
  });
}

function openResetModalFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("reset_token");

  if (!token) {
    return;
  }

  authForm.dataset.resetToken = token;
  openAuthModal("reset");
}

async function submitAuth(event) {
  event.preventDefault();

  const formData = new FormData(authForm);
  const password = String(formData.get("password"));

  if (authMode === "forgot") {
    await submitForgotPassword(formData);
    return;
  }

  if (authMode === "reset") {
    await submitResetPassword(formData);
    return;
  }

  const payload = {
    email: String(formData.get("email")).trim(),
    password,
  };

  if (authMode === "register") {
    payload.name = String(formData.get("name")).trim();
  }

  authSubmit.disabled = true;
  authSubmit.textContent = "Проверяем...";
  setAuthMessage("");
  setAuthStatus("");

  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/${authMode}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.detail || "Не получилось войти. Проверьте данные.");
    }

    localStorage.setItem("speakeasy_token", data.access_token);
    localStorage.setItem("speakeasy_user", JSON.stringify(data.user));
    if (data.expires_at) {
      localStorage.setItem(SESSION_EXPIRES_KEY, data.expires_at);
      initSessionExpiry();
    }
    updateAuthUi();
    window.location.href = "lk.html";
  } catch (error) {
    setAuthMessage(error.message);
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = getAuthSubmitText(authMode);
  }
}

async function submitForgotPassword(formData) {
  authSubmit.disabled = true;
  authSubmit.textContent = "Отправляем...";
  setAuthMessage("");
  setAuthStatus("");

  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/forgot-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: String(formData.get("email")).trim(),
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.detail || "Не получилось отправить ссылку. Попробуйте позже.");
    }

    const neutralMessage = data.message || "Если аккаунт существует, мы отправили ссылку для восстановления.";

    if (data.dev_reset_url) {
      setAuthStatus(
        "Почтовый сервер пока не настроен, поэтому письмо не отправлено. Для локальной проверки откройте тестовую ссылку ниже.",
        data.dev_reset_url
      );
    } else {
      setAuthStatus(`${neutralMessage} Проверьте входящие и папку «Спам».`);
    }

    startForgotCooldown(30);
  } catch (error) {
    setAuthMessage(error.message);
    authSubmit.disabled = false;
    authSubmit.textContent = getAuthSubmitText(authMode);
  } finally {
    if (!forgotCooldownTimer) {
      authSubmit.disabled = false;
      authSubmit.textContent = getAuthSubmitText(authMode);
    }
  }
}

async function submitResetPassword(formData) {
  const password = String(formData.get("password"));
  const passwordConfirm = String(formData.get("password_confirm"));

  if (password !== passwordConfirm) {
    setAuthMessage("Пароли не совпадают.");
    return;
  }

  authSubmit.disabled = true;
  authSubmit.textContent = "Сохраняем...";
  setAuthMessage("");

  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/reset-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: authForm.dataset.resetToken || "",
        password,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.detail || "Не получилось обновить пароль. Запросите новую ссылку.");
    }

    delete authForm.dataset.resetToken;
    window.history.replaceState({}, document.title, window.location.pathname);
    setAuthMode("login");
    authForm.reset();
    setAuthMessage(data.message || "Пароль обновлен. Теперь можно войти.", true);
  } catch (error) {
    setAuthMessage(error.message);
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = getAuthSubmitText(authMode);
  }
}

authTabs.forEach((tab) => {
  tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode));
});

forgotPasswordButton.addEventListener("click", () => setAuthMode("forgot"));

passwordToggle.addEventListener("click", () => togglePasswordVisibility(authForm.password, passwordToggle));
passwordConfirmToggle.addEventListener("click", () => togglePasswordVisibility(authForm.password_confirm, passwordConfirmToggle));

authCloseButtons.forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    closeAuthModal();
  });
});

authDialog.addEventListener("click", (event) => {
  event.stopPropagation();
});

authForm.addEventListener("submit", submitAuth);
