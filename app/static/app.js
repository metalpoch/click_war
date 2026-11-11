/* CLICK//WAR — frontend sin frameworks.
   El servidor manda: cada click se confirma con POST /api/click.
   La UI va por delante con un contador optimista y una cola pequeña. */

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  me: null,
  config: { oauth_configured: false, dev_login: false },
  sound: readSoundPreference(),
  serverScore: 0,
  queued: 0,
  inflight: 0,
  rank: null,
  combo: 0,
  lastClickAt: 0,
  sessionClicks: 0,
  board: null,
  boardSignature: "",
  modalOpen: false,
  lastFocus: null,
  live: true,
  clickErrorShown: false,
  sessionLostNotified: false,
};

const MAX_INFLIGHT = 6;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const numberFormat = new Intl.NumberFormat("es-ES");

const els = {
  clicker: $("#clicker"),
  clickZone: $(".click-zone"),
  arena: $(".arena"),
  score: $("#score-number"),
  rank: $("#rank-badge"),
  handle: $("#user-handle"),
  combo: $("#combo"),
  hint: $("#click-hint"),
  floaters: $("#floaters"),
  authSlot: $("#auth-slot"),
  soundToggle: $("#sound-toggle"),
  soundLabel: $(".sound-label"),
  statPlayers: $("#stat-players"),
  statClicks: $("#stat-clicks"),
  statRank: $("#stat-rank"),
  boardBody: $("#leaderboard-body"),
  boardTable: $(".score-table"),
  boardEmpty: $("#leaderboard-empty"),
  boardUpdated: $("#board-updated"),
  live: $("#live-indicator"),
  modal: $("#login-modal"),
  githubLogin: $("#github-login"),
  oauthNote: $("#oauth-note"),
  devBlock: $("#dev-login-block"),
  devForm: $("#dev-form"),
  devName: $("#dev-name"),
  toastRegion: $("#toast-region"),
  heroCtaLabel: $(".hero-cta .btn-label"),
  year: $("#year"),
};

let comboTimer = 0;
let hitTimer = 0;

/* ---------- helpers ---------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function formatNumber(value) {
  return numberFormat.format(Math.max(0, Number(value) || 0));
}

function formatScore(value) {
  const number = Math.max(0, Number(value) || 0);
  return number < 1000 ? String(number).padStart(4, "0") : numberFormat.format(number);
}

function formatRank(rank) {
  if (!rank) return "#—";
  return `#${String(rank).padStart(2, "0")}`;
}

function readSoundPreference() {
  try {
    return window.localStorage.getItem("cw_sound") !== "off";
  } catch {
    return true;
  }
}

function persistSoundPreference() {
  try {
    window.localStorage.setItem("cw_sound", state.sound ? "on" : "off");
  } catch {
    /* sin storage, sin drama */
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  });

  if (!response.ok) {
    let detail = "Algo salió mal";
    try {
      const payload = await response.json();
      if (typeof payload.detail === "string") detail = payload.detail;
    } catch {
      /* respuesta sin JSON */
    }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }

  return response.status === 204 ? null : response.json();
}

function toast(message, isError = false) {
  const element = document.createElement("div");
  element.className = `toast${isError ? " is-error" : ""}`;
  element.textContent = message;
  els.toastRegion.append(element);

  while (els.toastRegion.children.length > 3) {
    els.toastRegion.firstElementChild.remove();
  }

  window.setTimeout(() => {
    element.style.transition = "opacity .2s ease, transform .2s ease";
    element.style.opacity = "0";
    element.style.transform = "translateY(6px)";
    window.setTimeout(() => element.remove(), 220);
  }, 4000);
}

function avatarMarkup(user, extraClass = "") {
  const classes = `avatar ${extraClass}`.trim();
  if (user.avatar_url) {
    return `<img class="${classes}" src="${escapeHtml(user.avatar_url)}" alt="" width="34" height="34" loading="lazy" referrerpolicy="no-referrer" data-name="${escapeHtml(user.username)}" />`;
  }
  const initial = (user.username || "?").trim().charAt(0) || "?";
  return `<span class="${classes} avatar-fallback" aria-hidden="true">${escapeHtml(initial.toUpperCase())}</span>`;
}

/* ---------- estado de sesión ---------- */

function setLoggedOut() {
  state.me = null;
  state.serverScore = 0;
  state.queued = 0;
  state.inflight = 0;
  state.rank = null;
  state.combo = 0;
  els.score.textContent = "0000";
  els.score.dataset.size = "lg";
  els.rank.textContent = "#—";
  els.handle.textContent = "@INVITADO";
  els.hint.textContent = "ENTRA CON GITHUB PARA QUE TUS CLICKS CUENTEN";
  els.clicker.classList.add("is-locked");
  els.clicker.setAttribute("aria-disabled", "true");
  els.clicker.setAttribute("aria-label", "Inicia sesión para jugar");
  els.heroCtaLabel.textContent = "ENTRAR CON GITHUB";
  renderCombo();
  renderAuth();
  updateRankStat();
  if (state.board) renderLeaderboard(state.board, true);
}

function setLoggedIn(me) {
  state.me = me;
  state.serverScore = Number(me.score) || 0;
  state.rank = me.rank;
  state.queued = 0;
  state.inflight = 0;
  state.sessionLostNotified = false;
  els.clicker.classList.remove("is-locked");
  els.clicker.setAttribute("aria-disabled", "false");
  els.clicker.setAttribute("aria-label", "Haz click para sumar un punto");
  els.handle.textContent = `@${me.username}`;
  els.hint.textContent = "DALE. EL BOTÓN NO SE VA A PRESIONAR SOLO.";
  els.heroCtaLabel.textContent = "A DARLE";
  updateScore(false);
  updateRank();
  renderAuth();
  if (state.board) renderLeaderboard(state.board, true);
}

function renderAuth() {
  if (state.me) {
    const me = state.me;
    els.authSlot.innerHTML = `
      <div class="user-chip">
        ${avatarMarkup(me, "chip-avatar")}
        <span class="chip-name">@${escapeHtml(me.username)}</span>
        <button class="chip-logout" type="button" data-logout aria-label="Cerrar sesión" title="Cerrar sesión">✕</button>
      </div>`;
  } else {
    els.authSlot.innerHTML = `<button class="btn btn-sm" type="button" data-open-login>ENTRAR ↗</button>`;
  }
}

async function logout() {
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    window.location.assign("/");
  }
}

/* ---------- puntaje ---------- */

function currentTotal() {
  return state.serverScore + state.queued + state.inflight;
}

function updateScore(animate = true) {
  const total = currentTotal();
  els.score.textContent = formatScore(total);
  const digits = String(total).length;
  els.score.dataset.size = digits > 13 ? "xs" : digits > 10 ? "sm" : digits > 7 ? "md" : "lg";
  updateRankStat();
  refreshMeScore();

  if (animate) {
    els.score.classList.remove("is-bumping");
    void els.score.offsetWidth;
    els.score.classList.add("is-bumping");
  }
}

function refreshMeScore() {
  if (!state.me) return;
  const value = formatNumber(currentTotal());
  document.querySelectorAll("tr[data-me] .score-cell").forEach((cell) => {
    cell.textContent = value;
  });
}

function updateRank() {
  els.rank.textContent = formatRank(state.rank);
  updateRankStat();
}

function updateRankStat() {
  els.statRank.textContent = state.me && state.rank ? formatRank(state.rank) : "—";
}

function renderCombo() {
  const combo = state.combo;
  els.combo.textContent = `COMBO ×${combo > 1 ? combo : 1}`;
  els.combo.classList.toggle("is-hot", combo >= 5);
}

/* ---------- clicker ---------- */

function handleClick(clientX, clientY) {
  if (!state.me) {
    openLogin();
    return;
  }

  state.sessionClicks += 1;
  state.queued += 1;
  const now = performance.now();
  state.combo = now - state.lastClickAt < 1100 ? state.combo + 1 : 1;
  state.lastClickAt = now;
  window.clearTimeout(comboTimer);
  comboTimer = window.setTimeout(() => {
    state.combo = 0;
    renderCombo();
  }, 1150);
  renderCombo();

  updateScore();
  playClickSound(state.combo);
  spawnFloater(clientX, clientY);
  spawnShockwave(clientX, clientY);
  flashClicker();

  if (state.sessionClicks % 100 === 0) {
    toast(`${state.sessionClicks} CLICKS. LA MUÑECA ESTÁ CALIENTE.`);
    shakeArena();
  }

  if (state.sessionClicks % 20 === 0) {
    void loadLeaderboard();
  }

  pump();
}

function flashClicker() {
  els.clicker.classList.remove("is-hit");
  void els.clicker.offsetWidth;
  els.clicker.classList.add("is-hit");
  window.clearTimeout(hitTimer);
  hitTimer = window.setTimeout(() => els.clicker.classList.remove("is-hit"), 160);
}

function spawnFloater(clientX, clientY) {
  if (reducedMotion) return;

  const rect = els.clickZone.getBoundingClientRect();
  const floater = document.createElement("span");
  floater.className = `floater${state.combo >= 5 ? " is-combo" : ""}`;
  floater.textContent = state.combo >= 5 ? `×${state.combo}` : "+1";
  floater.style.left = `${clientX - rect.left}px`;
  floater.style.top = `${clientY - rect.top}px`;
  floater.style.setProperty("--drift", `${Math.round(Math.random() * 34 - 17)}px`);
  els.floaters.append(floater);
  floater.addEventListener("animationend", () => floater.remove());

  while (els.floaters.children.length > 24) {
    els.floaters.firstElementChild.remove();
  }
}

function spawnShockwave(clientX, clientY) {
  if (reducedMotion) return;

  const rect = els.clickZone.getBoundingClientRect();
  const wave = document.createElement("span");
  wave.className = "shockwave";
  wave.style.left = `${clientX - rect.left}px`;
  wave.style.top = `${clientY - rect.top}px`;
  els.clickZone.append(wave);
  wave.addEventListener("animationend", () => wave.remove());
}

function shakeArena() {
  if (reducedMotion) return;
  els.arena.classList.remove("is-shaking");
  void els.arena.offsetWidth;
  els.arena.classList.add("is-shaking");
  window.setTimeout(() => els.arena.classList.remove("is-shaking"), 500);
}

function pump() {
  while (state.me && state.inflight < MAX_INFLIGHT && state.queued > 0) {
    state.queued -= 1;
    state.inflight += 1;
    void sendClick();
  }
  updateRankStat();
}

async function sendClick() {
  try {
    const result = await api("/api/click", { method: "POST" });
    if (!state.me) return;
    state.serverScore = Math.max(state.serverScore, Number(result.score) || 0);
    state.rank = result.rank;
    updateScore(false);
    updateRank();
  } catch (error) {
    if (error.status === 401) {
      handleSessionLost();
    } else if (!state.clickErrorShown) {
      state.clickErrorShown = true;
      toast("No se pudo guardar el click. Revisa tu conexión.", true);
      window.setTimeout(() => {
        state.clickErrorShown = false;
      }, 4000);
    }
  } finally {
    if (state.me) {
      state.inflight = Math.max(0, state.inflight - 1);
      updateScore(false);
      pump();
    }
  }
}

function handleSessionLost() {
  if (state.sessionLostNotified) return;
  state.sessionLostNotified = true;
  setLoggedOut();
  toast("Tu sesión caducó. Entra otra vez.", true);
  openLogin();
}

/* ---------- sonido ---------- */

let audioContext = null;

function playClickSound(combo) {
  if (!state.sound) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") void audioContext.resume();
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(150 + Math.min(combo, 24) * 11, now);
    oscillator.frequency.exponentialRampToValueAtTime(72, now + 0.055);
    gain.gain.setValueAtTime(0.055, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.075);
  } catch {
    /* si el navegador no deja audio, que se calle */
  }
}

function updateSoundUi() {
  els.soundToggle.classList.toggle("is-muted", !state.sound);
  els.soundToggle.setAttribute("aria-pressed", String(state.sound));
  els.soundLabel.textContent = state.sound ? "SONIDO" : "MUDO";
}

function toggleSound() {
  state.sound = !state.sound;
  persistSoundPreference();
  updateSoundUi();
  if (state.sound) playClickSound(1);
}

/* ---------- ranking ---------- */

async function loadLeaderboard(force = false) {
  if (document.hidden) return;
  try {
    const data = await api("/api/leaderboard?limit=10");
    state.board = data;
    setLive(true);
    renderLeaderboard(data, force);
    const time = new Date().toLocaleTimeString("es-ES", { hour12: false });
    els.boardUpdated.textContent = `ACTUALIZADO ${time}`;
  } catch {
    setLive(false);
    els.boardUpdated.textContent = "SIN CONEXIÓN — REINTENTANDO";
  }
}

function setLive(online) {
  if (state.live === online) return;
  state.live = online;
  els.live.classList.toggle("is-offline", !online);
  els.live.lastChild.textContent = online ? " EN VIVO" : " SIN CONEXIÓN";
}

function renderLeaderboard(data, force = false) {
  const signature = JSON.stringify({ players: data.players, totals: [data.total_players, data.total_clicks] });
  const meName = state.me ? state.me.username.toLowerCase() : "";
  const changed = signature !== state.boardSignature || force;
  state.boardSignature = signature;

  els.statPlayers.textContent = formatNumber(data.total_players);
  els.statClicks.textContent = formatNumber(data.total_clicks);
  updateRankStat();

  if (!changed) return;

  const players = data.players || [];
  els.boardTable.hidden = players.length === 0;
  els.boardEmpty.hidden = players.length !== 0;

  if (players.length === 0) {
    els.boardBody.innerHTML = "";
    return;
  }

  const leader = players[0];
  const ownTotal = currentTotal();
  const rows = players.map((player, index) => {
    const isMe = Boolean(meName) && player.username.toLowerCase() === meName;
    const score = isMe ? Math.max(player.score, ownTotal) : player.score;
    const gap = Math.max(0, leader.score - score);
    const gapText = index === 0 ? '<span class="gap-leader">LÍDER</span>' : `−${formatNumber(gap)}`;
    return `
      <tr class="player-row${index === 0 ? " is-top" : ""}"${isMe ? ' data-me="true"' : ""}>
        <td class="rank-cell">${String(player.rank).padStart(2, "0")}${index === 0 ? '<span class="rank-star">✱</span>' : ""}</td>
        <td>
          <div class="player-cell">
            ${avatarMarkup(player)}
            <span class="player-name">${escapeHtml(player.username)}${isMe ? '<span class="you-badge">TÚ</span>' : ""}</span>
          </div>
        </td>
        <td class="score-cell">${formatNumber(score)}</td>
        <td class="gap-cell col-gap">${gapText}</td>
      </tr>`;
  });

  const meInTop = state.me && players.some((player) => player.username.toLowerCase() === meName);
  if (state.me && !meInTop) {
    const gap = Math.max(0, leader.score - ownTotal);
    rows.push(`
      <tr class="me-row" data-me="true">
        <td class="rank-cell">${String(state.rank ?? state.me.rank).padStart(2, "0")}</td>
        <td>
          <div class="player-cell">
            ${avatarMarkup(state.me)}
            <span class="player-name"><span><span class="me-label">TU POSICIÓN</span>${escapeHtml(state.me.username)}</span></span>
          </div>
        </td>
        <td class="score-cell">${formatNumber(ownTotal)}</td>
        <td class="gap-cell col-gap">−${formatNumber(gap)}</td>
      </tr>`);
  }

  els.boardBody.innerHTML = rows.join("");
}

/* ---------- login ---------- */

function openLogin() {
  if (state.modalOpen) return;
  if (state.me) {
    els.clicker.focus({ preventScroll: true });
    els.clicker.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    return;
  }
  state.lastFocus = document.activeElement;
  state.modalOpen = true;
  els.modal.hidden = false;
  document.body.style.overflow = "hidden";
  const target = state.config.oauth_configured ? els.githubLogin : els.devBlock.hidden ? $(".modal-close") : els.devName;
  window.setTimeout(() => target?.focus(), 30);
}

function closeLogin() {
  if (!state.modalOpen) return;
  state.modalOpen = false;
  els.modal.hidden = true;
  document.body.style.overflow = "";
  if (state.lastFocus instanceof HTMLElement) state.lastFocus.focus({ preventScroll: true });
}

function applyConfig(config) {
  state.config = { ...state.config, ...config };
  els.oauthNote.hidden = state.config.oauth_configured;
  els.devBlock.hidden = !state.config.dev_login;

  if (!state.config.oauth_configured) {
    els.githubLogin.removeAttribute("href");
    els.githubLogin.setAttribute("aria-disabled", "true");
    els.githubLogin.style.opacity = "0.45";
    els.githubLogin.style.pointerEvents = "none";
  }
}

function submitDevLogin(event) {
  event.preventDefault();
  const name = els.devName.value.trim();
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(name)) {
    toast("Nombre inválido: usa letras, números, guion o guion bajo.", true);
    return;
  }
  window.location.assign(`/auth/dev?name=${encodeURIComponent(name)}`);
}

/* ---------- eventos ---------- */

function bindEvents() {
  els.clicker.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    els.clicker.focus({ preventScroll: true });
    handleClick(event.clientX, event.clientY);
  });

  document.addEventListener(
    "error",
    (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.classList.contains("avatar")) return;
      const fallback = document.createElement("span");
      fallback.className = `avatar avatar-fallback${image.classList.contains("chip-avatar") ? " chip-avatar" : ""}`;
      fallback.setAttribute("aria-hidden", "true");
      fallback.textContent = ((image.dataset.name || "?").trim().charAt(0) || "?").toUpperCase();
      image.replaceWith(fallback);
    },
    true,
  );

  els.clicker.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const rect = els.clicker.getBoundingClientRect();
    handleClick(rect.left + rect.width / 2, rect.top + rect.height / 2);
  });

  els.soundToggle.addEventListener("click", toggleSound);
  els.devForm.addEventListener("submit", submitDevLogin);

  els.modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-login]")) closeLogin();
  });

  els.githubLogin.addEventListener("click", (event) => {
    if (!state.config.oauth_configured) {
      event.preventDefault();
      toast("Configura GitHub OAuth en el .env para entrar.", true);
    }
  });

  document.addEventListener("click", (event) => {
    const loginTrigger = event.target.closest("[data-open-login]");
    if (loginTrigger) {
      event.preventDefault();
      if (state.me) {
        els.clicker.focus({ preventScroll: true });
        els.clicker.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      } else {
        openLogin();
      }
      return;
    }

    if (event.target.closest("[data-logout]")) {
      event.preventDefault();
      void logout();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.modalOpen) closeLogin();
    if (event.key !== "Tab" || !state.modalOpen) return;

    const focusable = [...els.modal.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void loadLeaderboard(true);
  });
}

/* ---------- arranque ---------- */

async function syncMe() {
  if (!state.me || document.hidden || state.queued > 0 || state.inflight > 0) return;
  try {
    const me = await api("/api/me");
    state.serverScore = Number(me.score) || 0;
    state.rank = me.rank;
    state.me = { ...state.me, ...me };
    updateScore(false);
    updateRank();
    if (state.board) renderLeaderboard(state.board, true);
  } catch (error) {
    if (error.status === 401) handleSessionLost();
  }
}

async function init() {
  bindEvents();
  updateSoundUi();
  els.year.textContent = String(new Date().getFullYear());

  const [configResult, meResult] = await Promise.allSettled([
    api("/api/config"),
    api("/api/me"),
  ]);

  if (configResult.status === "fulfilled") {
    applyConfig(configResult.value);
  } else {
    applyConfig({ oauth_configured: false, dev_login: false });
    toast("No se pudo cargar la configuración del servidor.", true);
  }

  if (meResult.status === "fulfilled") {
    setLoggedIn(meResult.value);
  } else {
    setLoggedOut();
  }

  await loadLeaderboard(true);

  window.setInterval(() => void loadLeaderboard(), 5000);
  window.setInterval(() => void syncMe(), 20000);

  const params = new URLSearchParams(window.location.search);
  if (params.get("auth") === "cancelled") {
    toast("Acceso cancelado. Sin rencor.");
  } else if (params.get("auth") === "error") {
    toast("No se pudo completar el login con GitHub.", true);
  }
  if (params.has("auth")) {
    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  }
}

void init();
