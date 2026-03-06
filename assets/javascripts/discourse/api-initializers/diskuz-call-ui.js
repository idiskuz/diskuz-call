import { apiInitializer } from "discourse/lib/api";
import { ajax } from "discourse/lib/ajax";
import MessageBus from "message-bus-client";

const DEBUG = true; // log in console (F12) per verificare flusso e eventi
function log(...args) {
  if (DEBUG) console.log("[diskuz-call]", ...args);
}

  const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ];

  function getIceServers() {
    const custom = window.DiskuzCallIceServers;
    if (Array.isArray(custom) && custom.length > 0) {
      const valid = custom.filter((s) => s && (s.urls || s.url));
      if (valid.length > 0) {
        log("[*] ICE: using custom servers from admin (count:", valid.length, ")");
        return valid;
      }
    }
    log("[*] ICE: using default STUN (3x Google)");
    return DEFAULT_ICE_SERVERS;
  }

  function waitForDiskuzCallSend(maxMs) {
  return new Promise((resolve) => {
    if (typeof window.DiskuzCallSend === "function") {
      resolve(window.DiskuzCallSend);
      return;
    }
    const start = Date.now();
    const t = setInterval(() => {
      if (typeof window.DiskuzCallSend === "function") {
        clearInterval(t);
        resolve(window.DiskuzCallSend);
        return;
      }
      if (Date.now() - start >= maxMs) {
        clearInterval(t);
        resolve(null);
      }
    }, 100);
  });
}

export default apiInitializer("0.8", (api) => {
  log("diskuz-call-ui (plugin) initializer running");

  if (typeof window.DiskuzCallSend !== "function") {
    window.DiskuzCallSend = (data) => {
      const { to_user_id, type, ...rest } = data;
      return ajax("/diskuz-call/signal", {
        type: "POST",
        data: { target_user_id: to_user_id, signal_type: type, payload: rest },
      });
    };
    log("diskuz-call-ui: DiskuzCallSend fallback registered");
  }

  let btn = null;
  let widget = null;
  let callUI = null;
  let proximityOverlay = null;
  let historyPanel = null;
  let toastContainer = null;

  let callStatus = "available"; // "available" | "busy" | "not_available"
  let callHistory = [];
  let currentUserId = null;
  let currentUserUsername = null; // per evitare fetch /u/me.json su ogni nodo che contiene il mio username (429)

  let currentCall = {
    active: false,
    direction: null,
    username: null,
    userId: null,
    isRinging: false,
    offerSdp: null,
    avatarTemplate: null,
  };

  const HISTORY_KEY = "diskuz_call_history";
  const STATUS_KEY = "diskuz_call_status";
  const USER_RESOLVE_CACHE_TTL_MS = 60000;
  const userResolveCache = {};
  function resolveUserByUsername(username) {
    let key = (username || "").toLowerCase().trim().replace(/\.json$/i, "");
    if (!key) return Promise.resolve(null);
    if (currentUserUsername && key === currentUserUsername) return Promise.resolve(null);
    const entry = userResolveCache[key];
    if (entry && Date.now() < entry.expires) return Promise.resolve(entry.data);
    return fetch(`/u/${encodeURIComponent(key)}.json`)
      .then((res) => {
        if (res.status === 429) throw new Error("RATE_LIMIT");
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (data && data.user) {
          userResolveCache[key] = { data, expires: Date.now() + USER_RESOLVE_CACHE_TTL_MS };
          return data;
        }
        return null;
      })
      .catch((e) => {
        if (e.message === "RATE_LIMIT") throw e;
        return null;
      });
  }
  const MSG_CALL_UNAVAILABLE =
    document.documentElement.lang === "it"
      ? "Utente non disponibile o non collegato."
      : "User not available or not connected.";

  function getSignalErrorReason(err) {
    if (!err) return null;
    const j = err.responseJSON || err.payload || err;
    return (j && (j.reason || j.message)) || err.reason || err.message || null;
  }

  function messageForSignalReason(reason, nickname) {
    const it = document.documentElement.lang === "it";
    const name = (nickname || "").trim() || "this user";
    switch (reason) {
      case "follow_required":
        return it
          ? "Per chiamare " + name + " dovete seguirvi a vicenda."
          : "To call " + name + " you need to follow each other.";
      case "target_not_in_allowed_groups":
        return it ? "L'utente non può ricevere chiamate (gruppi)." : "User cannot receive calls (groups).";
      case "caller_not_in_allowed_groups":
        return it ? "Non sei nei gruppi abilitati alle chiamate." : "You are not in the groups allowed for calls.";
      default:
        return MSG_CALL_UNAVAILABLE;
    }
  }

  /* --- AUDIO UNLOCK (browsers require user gesture before playing) --- */
  let incomingCallAudioContext = null;
  function unlockAudioForIncomingSound() {
    if (incomingCallAudioContext) return;
    try {
      incomingCallAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (incomingCallAudioContext.state === "suspended") {
        incomingCallAudioContext.resume();
      }
    } catch (e) {
      console.warn("diskuz-call: could not create AudioContext", e);
    }
  }

  /* --- INCOMING CALL SOUND (admin setting; works after user has interacted with page) --- */
  function playIncomingCallSound() {
    const sound = (typeof window.DiskuzCallIncomingSound !== "undefined" && window.DiskuzCallIncomingSound) ? window.DiskuzCallIncomingSound : "default";
    if (sound === "none") return;
    const customUrl = (typeof window.DiskuzCallCustomRingtoneUrl !== "undefined" && window.DiskuzCallCustomRingtoneUrl) ? window.DiskuzCallCustomRingtoneUrl : "";
    if (sound === "custom" && customUrl) {
      try {
        let url = customUrl.trim();
        if (!/^https?:\/\//i.test(url)) {
          if (url.startsWith("//")) url = window.location.protocol + url;
          else if (url.startsWith("/")) url = window.location.origin + url;
          else if (/^[a-z0-9.-]+\//i.test(url) || !url.includes("/")) url = "https://" + url.replace(/^\/+/, "");
          else url = window.location.origin + "/" + url.replace(/^\/+/, "");
        }
        const a = new Audio(url);
        a.volume = 0.8;
        a.play().catch((err) => log("diskuz-call: custom ringtone play failed", err));
      } catch (e) {
        console.warn("diskuz-call: could not play custom ringtone", e);
      }
      return;
    }
    try {
      const ctx = incomingCallAudioContext || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") {
        ctx.resume().then(() => playIncomingCallBeep(ctx)).catch(() => {});
      } else {
        playIncomingCallBeep(ctx);
      }
    } catch (e) {
      console.warn("diskuz-call: could not play incoming sound", e);
    }
  }

  function playIncomingCallBeep(ctx) {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {
      console.warn("diskuz-call: beep failed", e);
    }
  }

  function playIncomingCallRing() {
    const sound = (typeof window.DiskuzCallIncomingSound !== "undefined" && window.DiskuzCallIncomingSound) ? window.DiskuzCallIncomingSound : "default";
    if (sound === "none") return;
    const customUrl = (typeof window.DiskuzCallCustomRingtoneUrl !== "undefined" && window.DiskuzCallCustomRingtoneUrl) ? window.DiskuzCallCustomRingtoneUrl : "";
    if (sound === "custom" && customUrl) {
      playIncomingCallSound();
      const t2 = setTimeout(playIncomingCallSound, 800);
      const t3 = setTimeout(playIncomingCallSound, 1600);
      return;
    }
    playIncomingCallSound();
    setTimeout(playIncomingCallSound, 400);
    setTimeout(playIncomingCallSound, 800);
  }

  /* --- BROWSER NOTIFICATION (when user has allowed notifications) --- */
  function showBrowserNotification(fromUsername) {
    if (!window.Notification || Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") showBrowserNotification(fromUsername);
      });
      return;
    }
    try {
      const n = new Notification("Incoming call", {
        body: fromUsername ? "From " + fromUsername : "Voice call",
        icon: "/favicon.ico",
        tag: "diskuz-call-incoming",
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      setTimeout(() => n.close(), 8000);
    } catch (e) {
      console.warn("diskuz-call: browser notification failed", e);
    }
  }

  /* --- TOASTS --- */
  function ensureToastContainer() {
    if (toastContainer) return;
    toastContainer = document.createElement("div");
    toastContainer.id = "diskuz-call-toasts";
    toastContainer.style.position = "fixed";
    toastContainer.style.bottom = "20px";
    toastContainer.style.left = "50%";
    toastContainer.style.transform = "translateX(-50%)";
    toastContainer.style.zIndex = "100000";
    toastContainer.style.display = "flex";
    toastContainer.style.flexDirection = "column";
    toastContainer.style.gap = "6px";
    document.body.appendChild(toastContainer);
  }

  function showToast(message, durationMs) {
    ensureToastContainer();
    const duration = durationMs != null ? durationMs : 2500;
    const t = document.createElement("div");
    t.textContent = message;
    t.style.background = "rgba(15,23,42,0.95)";
    t.style.color = "#fff";
    t.style.padding = "8px 12px";
    t.style.borderRadius = "999px";
    t.style.fontSize = "13px";
    t.style.boxShadow = "0 4px 12px rgba(0,0,0,0.35)";
    t.style.opacity = "0";
    t.style.transform = "translateY(10px)";
    t.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    toastContainer.appendChild(t);
    requestAnimationFrame(() => {
      t.style.opacity = "1";
      t.style.transform = "translateY(0)";
    });
    setTimeout(() => {
      t.style.opacity = "0";
      t.style.transform = "translateY(10px)";
      setTimeout(() => {
        t.remove();
      }, 200);
    }, duration);
  }

  /* --- HISTORY STORAGE --- */
  function loadHistory() {
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (raw) {
        callHistory = JSON.parse(raw);
      } else {
        callHistory = [];
      }
    } catch (e) {
      callHistory = [];
    }
  }

  function saveHistory() {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(callHistory));
    } catch (e) {
      // ignore
    }
  }

  function addHistoryEntry(entry) {
    const at = entry.at || new Date().toISOString();
    const durationSeconds = entry.durationSeconds != null ? entry.durationSeconds : null;
    callHistory.unshift({
      direction: entry.direction,
      result: entry.result,
      username: entry.username,
      at,
      durationSeconds: durationSeconds ?? undefined,
    });
    if (callHistory.length > 50) {
      callHistory = callHistory.slice(0, 50);
    }
    saveHistory();
    renderHistoryList();
  }

  function formatTimeHHmm(date) {
    const d = date instanceof Date ? date : new Date(date);
    const h = d.getHours();
    const m = d.getMinutes();
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function formatDuration(seconds) {
    if (seconds == null || seconds < 0) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  let notificationsTab = "received";

  /* --- NOTIFICATIONS (ex Call History) UI --- */
  function createHistoryPanel() {
    if (historyPanel) return;

    const isIt = document.documentElement.lang === "it";
    historyPanel = document.createElement("div");
    historyPanel.id = "diskuz-call-history";
    historyPanel.innerHTML = `
      <div class="diskuz-history-header">
        <strong>${isIt ? "Notifiche" : "Notifications"}</strong>
        <button id="diskuz-call-history-close" type="button" aria-label="Close" class="diskuz-history-close-btn">✕</button>
      </div>
      <div class="diskuz-notifications-tabs">
        <button type="button" class="diskuz-ntab active" data-tab="received">${isIt ? "Ricevute" : "Received"}</button>
        <button type="button" class="diskuz-ntab" data-tab="sent">${isIt ? "Inviate" : "Sent"}</button>
        <button type="button" class="diskuz-ntab" data-tab="recent">${isIt ? "Contatti recenti" : "Recent contacts"}</button>
        <button type="button" class="diskuz-ntab" data-tab="missed">${isIt ? "Perse" : "Missed"}</button>
      </div>
      <div id="diskuz-call-history-list"></div>
    `;

    document.body.appendChild(historyPanel);

    const closeBtn = historyPanel.querySelector("#diskuz-call-history-close");
    closeBtn.addEventListener("click", function () {
      historyPanel.classList.remove("open");
    });

    historyPanel.querySelectorAll(".diskuz-ntab").forEach((t) => {
      t.addEventListener("click", function () {
        const tab = this.getAttribute("data-tab");
        if (!tab) return;
        notificationsTab = tab;
        historyPanel.querySelectorAll(".diskuz-ntab").forEach((b) => b.classList.remove("active"));
        this.classList.add("active");
        renderHistoryList();
      });
    });

    renderHistoryList();
  }

  function renderHistoryList() {
    if (!historyPanel) return;
    const listEl = historyPanel.querySelector("#diskuz-call-history-list");
    if (!listEl) return;

    const isIt = document.documentElement.lang === "it";
    const emptyMsg = isIt ? "Nessuna chiamata." : "No calls yet.";

    let items = [];
    if (notificationsTab === "received") {
      items = callHistory.filter((h) => h.direction === "incoming");
    } else if (notificationsTab === "sent") {
      items = callHistory.filter((h) => h.direction === "outgoing");
    } else if (notificationsTab === "missed") {
      items = callHistory.filter((h) => h.direction === "incoming" && (h.result === "missed" || h.result === "rejected" || h.result === "busy" || h.result === "not_available"));
    } else if (notificationsTab === "recent") {
      const seen = new Set();
      items = callHistory.filter((h) => {
        const u = (h.username || "").toLowerCase().trim();
        if (!u || seen.has(u)) return false;
        seen.add(u);
        return true;
      });
    }

    if (!items.length) {
      listEl.innerHTML = `<div class="diskuz-history-empty">${emptyMsg}</div>`;
      return;
    }

    const rows = items
      .map((h) => {
        const date = new Date(h.at);
        const timeStr = formatTimeHHmm(date);
        let icon = "📤";
        if (h.direction === "incoming") icon = "📥";
        if (h.result === "missed" || h.result === "rejected") icon = "📵";
        const durationStr = h.result === "ended" && h.durationSeconds != null ? formatDuration(h.durationSeconds) : "";
        const meta = durationStr ? `${timeStr} • ${durationStr}` : `${h.result} • ${timeStr}`;

        return `
          <div class="diskuz-history-item" data-username="${(h.username || "").replace(/"/g, "&quot;")}">
            <div class="diskuz-history-row">
              <span class="diskuz-history-icon">${icon}</span>
              <button type="button" class="diskuz-history-username">${(h.username || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</button>
            </div>
            <div class="diskuz-history-meta">${meta}</div>
          </div>
        `;
      })
      .join("");

    listEl.innerHTML = rows;
    listEl.querySelectorAll(".diskuz-history-username").forEach((btn) => {
      btn.addEventListener("click", function () {
        const item = this.closest(".diskuz-history-item");
        const username = item && item.getAttribute("data-username");
        if (!username) return;
        resolveUserByUsername(username).then((data) => {
          if (!data || !data.user) {
            showToast("User not found.");
            return;
          }
          const u = data.user;
          if (u.id === currentUserId) {
            showToast("You cannot call yourself.");
            return;
          }
          startOutgoingCall(u.username, u.id, u.avatar_template);
          toggleHistoryPanel();
          toggleWidgetForceClose();
        }).catch(() => showToast("Connection error."));
      });
    });
  }

  function toggleHistoryPanel() {
    createHistoryPanel();
    if (historyPanel.classList.contains("open")) {
      historyPanel.classList.remove("open");
    } else {
      if (!isMobileDevice() && widget && widget.offsetParent !== null) {
        const wr = widget.getBoundingClientRect();
        historyPanel.style.left = wr.left + "px";
        historyPanel.style.right = "auto";
        historyPanel.style.width = Math.min(wr.width, 320) + "px";
        historyPanel.style.bottom = "auto";
        historyPanel.style.top = (wr.bottom + 6) + "px";
        historyPanel.classList.add("diskuz-notifications-attached");
      } else {
        historyPanel.style.left = "";
        historyPanel.style.right = "20px";
        historyPanel.style.width = "";
        historyPanel.style.bottom = "100px";
        historyPanel.style.top = "auto";
        historyPanel.classList.remove("diskuz-notifications-attached");
      }
      historyPanel.classList.add("open");
    }
  }

  /* --- FLOATING BUTTON (sempre visibile in basso a destra se loggato; nascosto solo se status ha risposto "non abilitato") --- */
  function updateCallFeatureVisibility() {
    const statusLoaded = !!(typeof window.DiskuzCallStatusLoaded !== "undefined" && window.DiskuzCallStatusLoaded);
    const allowed = !!(typeof window.DiskuzCallAllowed !== "undefined" && window.DiskuzCallAllowed);
    const show = !statusLoaded || allowed;
    if (btn) btn.style.display = show ? "" : "none";
    if (widget) {
      widget.style.display = show ? "" : "none";
      if (!show && widget.classList.contains("open")) widget.classList.remove("open");
    }
  }

  function createFloatingButton() {
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "diskuz-call-btn";
      btn.innerHTML = `<span class="diskuz-call-btn-icon" aria-hidden="true">📱</span><span class="diskuz-call-btn-label">Call</span>`;
      document.body.appendChild(btn);
      btn.addEventListener("click", function () {
        const isIncomingRinging =
          (currentCall.active && currentCall.direction === "incoming" && currentCall.isRinging) ||
          (btn && btn.classList.contains("diskuz-call-incoming"));
        if (isIncomingRinging) {
          if (widget && widget.classList.contains("open")) toggleWidgetForceClose();
          showIncomingCallUI(currentCall.username || "Unknown", currentCall.avatarTemplate);
          if (callUI && callUI.parentNode) callUI.parentNode.appendChild(callUI);
          if (callUI) callUI.style.zIndex = "100001";
          return;
        }
        if (currentCall.active && callUI) {
          toggleCallUIVisibility();
          return;
        }
        unlockAudioForIncomingSound();
        toggleWidget();
      });
      updateCallFeatureVisibility();
    }
  }

  function toggleCallUIVisibility() {
    if (!callUI || !currentCall.active) return;
    if (callUI.classList.contains("diskuz-call-minimized")) {
      callUI.classList.remove("diskuz-call-minimized");
      callUI.style.display = "block";
      callUI.classList.add("open");
    } else {
      callUI.classList.add("diskuz-call-minimized");
      callUI.classList.remove("open");
      callUI.style.display = "none";
    }
  }

  /* --- USER STATUS --- */
  function setStatus(newStatus) {
    callStatus = newStatus;
    const availableBtn = widget && widget.querySelector("#diskuz-status-available");
    const busyBtn = widget && widget.querySelector("#diskuz-status-busy");
    const notAvailBtn = widget && widget.querySelector("#diskuz-status-not-available");

    [availableBtn, busyBtn, notAvailBtn].forEach((b) => {
      if (!b) return;
      b.classList.remove("active");
    });

    if (newStatus === "available" && availableBtn) availableBtn.classList.add("active");
    if (newStatus === "busy" && busyBtn) busyBtn.classList.add("active");
    if (newStatus === "not_available" && notAvailBtn) notAvailBtn.classList.add("active");
  }

  /* --- USERNAME WIDGET --- */
  function createWidget() {
    if (!widget) {
      widget = document.createElement("div");
      widget.id = "diskuz-call-widget";

      widget.innerHTML = `
        <div class="diskuz-widget-top-bar" style="display:flex;align-items:center;margin:-16px -16px 12px -16px;padding:8px 12px;border-bottom:1px solid rgba(0,0,0,0.08);cursor:move;user-select:none;">
          <span class="diskuz-widget-drag-handle" style="color:#666;font-size:14px;">⋮⋮</span>
        </div>
        <h3 class="diskuz-widget-title" style="display:flex;align-items:center;justify-content:space-between;margin:0 0 10px 0;font-size:18px;font-weight:600;color:#333;">Call a friend</h3>
        <div class="diskuz-call-input-wrap" style="position:relative;margin-bottom:12px;">
          <input id="diskuz-call-input" type="text" placeholder="Enter username" class="diskuz-call-input-animated">
        </div>
        <button id="diskuz-call-start">Call</button>
        <div id="diskuz-call-error"></div>

        <div style="margin-top:10px;font-size:13px;color:#555;">Status:</div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button id="diskuz-status-available" class="diskuz-status-btn">Online</button>
          <button id="diskuz-status-busy" class="diskuz-status-btn">Busy</button>
          <button id="diskuz-status-not-available" class="diskuz-status-btn">Offline</button>
        </div>

        <button id="diskuz-call-history-btn" style="margin-top:10px;width:100%;padding:6px 8px;font-size:13px;border-radius:8px;border:1px solid #ddd;background:#f9fafb;cursor:pointer;">
          Notifications
        </button>
      `;

      document.body.appendChild(widget);

      const topBar = widget.querySelector(".diskuz-widget-top-bar");
      if (topBar && !isMobileDevice()) {
        let wDragStartX = 0, wDragStartY = 0, wDragStartLeft = 0, wDragStartTop = 0;
        topBar.addEventListener("mousedown", function (e) {
          e.preventDefault();
          wDragStartX = e.clientX;
          wDragStartY = e.clientY;
          const left = parseInt(widget.style.left, 10);
          const top = parseInt(widget.style.top, 10);
          wDragStartLeft = isNaN(left) ? (window.innerWidth - 300) : left;
          wDragStartTop = isNaN(top) ? 200 : top;
          function onWMove(ev) {
            widget.style.left = Math.max(0, wDragStartLeft + ev.clientX - wDragStartX) + "px";
            widget.style.top = Math.max(0, wDragStartTop + ev.clientY - wDragStartY) + "px";
            widget.style.right = "auto";
            widget.style.bottom = "auto";
          }
          function onWEnd() {
            document.removeEventListener("mousemove", onWMove);
            document.removeEventListener("mouseup", onWEnd);
          }
          document.addEventListener("mousemove", onWMove);
          document.addEventListener("mouseup", onWEnd);
        });
      }

      const input = widget.querySelector("#diskuz-call-input");
      const startBtn = widget.querySelector("#diskuz-call-start");
      const errorBox = widget.querySelector("#diskuz-call-error");
      const historyBtn = widget.querySelector("#diskuz-call-history-btn");

      const availableBtn = widget.querySelector("#diskuz-status-available");
      const busyBtn = widget.querySelector("#diskuz-status-busy");
      const notAvailBtn = widget.querySelector("#diskuz-status-not-available");

      startBtn.addEventListener("click", async () => {
        const username = input.value.trim();
        errorBox.style.display = "none";
        errorBox.textContent = "";

        if (!username) {
          showError("Please enter a username.");
          return;
        }

        if (callStatus === "busy" || callStatus === "not_available") {
          showError("You cannot start a call while not available.");
          return;
        }

        log("Call button clicked, resolving user:", username);
        try {
          const data = await resolveUserByUsername(username);
          if (!data || !data.user) {
            showError("User not found.");
            return;
          }
          const userId = data.user.id;
          if (userId != null && userId === currentUserId) {
            showError("You cannot call yourself.");
            return;
          }
          log("Starting call to", username, "userId", userId);
          startOutgoingCall(username, userId, data.user.avatar_template);
          toggleWidgetForceClose();
        } catch (e) {
          if (e.message === "RATE_LIMIT") {
            showError("Too many requests. Please wait a moment and try again.");
          } else {
            showError("Connection error.");
          }
        }
      });

      function showError(msg) {
        errorBox.textContent = msg;
        errorBox.style.display = "block";
        widget.classList.add("shake");
        setTimeout(function () {
          widget.classList.remove("shake");
        }, 400);
      }

      historyBtn.addEventListener("click", function () {
        toggleHistoryPanel();
      });

      availableBtn.addEventListener("click", function () {
        setStatus("available");
        try { window.localStorage.setItem(STATUS_KEY, "available"); } catch (e) {}
      });
      busyBtn.addEventListener("click", function () {
        setStatus("busy");
        try { window.localStorage.setItem(STATUS_KEY, "busy"); } catch (e) {}
      });
      notAvailBtn.addEventListener("click", function () {
        setStatus("not_available");
        try { window.localStorage.setItem(STATUS_KEY, "not_available"); } catch (e) {}
      });

      try {
        const saved = window.localStorage.getItem(STATUS_KEY);
        if (saved === "busy" || saved === "not_available" || saved === "available") callStatus = saved;
      } catch (e) {}
      setStatus(callStatus);
    }
  }

  /* --- PROXIMITY OVERLAY --- */
  function ensureProximityOverlay() {
    if (!proximityOverlay) {
      proximityOverlay = document.createElement("div");
      proximityOverlay.id = "diskuz-call-proximity-overlay";
      document.body.appendChild(proximityOverlay);

      proximityOverlay.addEventListener("click", function () {
        proximityOverlay.style.display = "none";
      });
    }
  }

  function activateEarMode() {
    ensureProximityOverlay();
    if (proximityOverlay && proximityOverlay.parentNode) {
      proximityOverlay.parentNode.appendChild(proximityOverlay);
    }
    proximityOverlay.style.display = "block";
  }

  /* --- CALL UI --- */
  function createCallUI() {
    if (!callUI) {
      callUI = document.createElement("div");
      callUI.id = "diskuz-call-ui";

      callUI.innerHTML = `
        <div class="call-top-bar">
          <div class="call-drag-handle" title="Trascina per spostare" aria-label="Drag to move">
            <span class="call-top-bar-title">diskuz Call</span>
            <span class="call-top-bar-by">by diskuz.com</span>
          </div>
        </div>
        <div class="call-inner">
          <div class="avatar"></div>
          <div class="username"></div>
          <div class="status">Calling...</div>
          <div class="diskuz-call-watermark" aria-hidden="true">
            <div class="diskuz-call-watermark-inner">
              <div class="diskuz-call-watermark-title">diskuz Call</div>
              <div class="diskuz-call-watermark-by">by diskuz.com</div>
              <div class="diskuz-call-watermark-slogan">Real Conversations, No Algorithms :-)</div>
            </div>
          </div>
          <div class="duration" aria-label="Call duration">00:00</div>

          <div class="diskuz-call-controls-block">
            <button type="button" class="diskuz-call-toggle-controls diskuz-call-hide-btn" aria-label="Hide call controls"></button>
            <div class="controls">
              <button class="btn mute">Mute</button>
              <button class="btn speaker">Speaker</button>
              <button class="btn hangup">Hang up</button>
            </div>
          </div>
          <button type="button" class="diskuz-call-show-controls" aria-label="Show call controls" style="display:none;"></button>

          <button class="ear-mode">Ear mode</button>
        </div>
      `;

      document.body.appendChild(callUI);

      const hangupBtn = callUI.querySelector(".hangup");
      const muteBtn = callUI.querySelector(".mute");
      const speakerBtn = callUI.querySelector(".speaker");
      const earBtn = callUI.querySelector(".ear-mode");

      muteBtn.setAttribute("aria-pressed", "false");
      muteBtn.setAttribute("aria-label", "Mute microphone");
      speakerBtn.setAttribute("aria-pressed", "false");
      speakerBtn.setAttribute("aria-label", "Speaker / audio output");

      hangupBtn.addEventListener("click", function () {
        endCurrentCall("ended");
      });

      muteBtn.addEventListener("click", function () {
        const isMuted = muteBtn.classList.toggle("active");
        if (rtcLocalStream) {
          rtcLocalStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
        }
        muteBtn.setAttribute("aria-pressed", muteBtn.classList.contains("active"));
        muteBtn.textContent = isMuted ? "Muted" : "Mute";
      });

      speakerBtn.addEventListener("click", async function () {
        ensureRemoteAudio();
        if (!setSinkIdSupported()) {
          showToast("Audio output is controlled by your device.");
          return;
        }
        await cycleSpeakerOutput();
        const active = speakerOn;
        speakerBtn.classList.toggle("active", active);
        speakerBtn.setAttribute("aria-pressed", String(active));
        if (isMobileDevice()) {
          showToast("If the speaker button does not work properly, adjust the call volume manually using your device's volume keys or sound settings.", 10000);
        }
      });

      if (earBtn) earBtn.style.display = isMobileDevice() ? "" : "none";
      earBtn.addEventListener("click", function () {
        activateEarMode();
      });

      const hideBtn = callUI.querySelector(".diskuz-call-hide-btn");
      const showBtn = callUI.querySelector(".diskuz-call-show-controls");
      const isIt = document.documentElement.lang === "it";
      const hideText = isIt ? "Nascondi pulsanti" : "Hide buttons";
      const showText = isIt ? "Mostra pulsanti" : "Show buttons";
      if (hideBtn) {
        hideBtn.textContent = hideText;
        hideBtn.style.display = "flex";
      }
      if (showBtn) {
        showBtn.textContent = showText;
        showBtn.style.display = "none";
        showBtn.classList.add("diskuz-call-toggle-controls");
      }
      function updateToggleVisibility() {
        const hidden = callUI.classList.contains("diskuz-call-controls-hidden");
        if (hideBtn) hideBtn.style.display = hidden ? "none" : "flex";
        if (showBtn) {
          showBtn.style.display = hidden ? "flex" : "none";
          showBtn.style.marginTop = "auto";
          showBtn.style.width = "100%";
          showBtn.style.padding = "10px";
          showBtn.style.borderRadius = "999px";
          showBtn.style.border = "none";
          showBtn.style.background = "rgba(15, 23, 42, 0.7)";
          showBtn.style.color = "#fff";
          showBtn.style.fontSize = "14px";
          showBtn.style.cursor = "pointer";
          showBtn.style.justifyContent = "center";
        }
      }
      if (hideBtn) {
        hideBtn.addEventListener("click", function () {
          callUI.classList.add("diskuz-call-controls-hidden");
          updateToggleVisibility();
        });
      }
      if (showBtn) {
        showBtn.addEventListener("click", function () {
          callUI.classList.remove("diskuz-call-controls-hidden");
          updateToggleVisibility();
        });
      }

      let startY = 0;
      let currentY = 0;
      let dragging = false;

      callUI.addEventListener("touchstart", function (e) {
        if (!e.touches || e.touches.length === 0) return;
        startY = e.touches[0].clientY;
        currentY = startY;
        dragging = true;
      });

      callUI.addEventListener("touchmove", function (e) {
        if (!dragging || !e.touches || e.touches.length === 0) return;
        currentY = e.touches[0].clientY;
        const diff = currentY - startY;
        if (diff > 0) {
          callUI.style.transform = "translateY(" + diff + "px)";
        }
      });

      callUI.addEventListener("touchend", function () {
        if (!dragging) return;
        dragging = false;
        const diff = currentY - startY;
        if (diff > 80) {
          endCurrentCall("ended");
        } else {
          callUI.style.transform = "";
        }
      });

      const topBar = callUI.querySelector(".call-top-bar");
      const dragHandle = callUI.querySelector(".call-drag-handle");
      if (topBar && dragHandle) {
        if (isMobileDevice()) {
          topBar.style.cursor = "";
        } else {
          let dragStartX = 0, dragStartY = 0, dragStartLeft = 0, dragStartTop = 0;
          function onDragMove(e) {
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            callUI.style.left = Math.max(0, dragStartLeft + dx) + "px";
            callUI.style.top = Math.max(0, dragStartTop + dy) + "px";
          }
          function onDragEnd() {
            document.removeEventListener("mousemove", onDragMove);
            document.removeEventListener("mouseup", onDragEnd);
          }
          topBar.addEventListener("mousedown", function (e) {
            e.preventDefault();
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const left = parseInt(callUI.style.left, 10);
            const top = parseInt(callUI.style.top, 10);
            dragStartLeft = isNaN(left) ? (window.innerWidth - 340) : left;
            dragStartTop = isNaN(top) ? 60 : top;
            document.addEventListener("mousemove", onDragMove);
            document.addEventListener("mouseup", onDragEnd);
          });
        }
      }
    }
  }

  function updateCallUI(username, avatarTemplate, statusText) {
    createCallUI();

    const inner = callUI && callUI.querySelector(".call-inner");
    const oldIncoming = inner && inner.querySelector(".incoming-row");
    if (oldIncoming) oldIncoming.remove();

    const avatarUrl = avatarTemplate ? avatarTemplate.replace("{size}", "120") : null;
    const avatarEl = callUI.querySelector(".avatar");
    const usernameEl = callUI.querySelector(".username");
    const statusEl = callUI.querySelector(".status");

    if (avatarUrl) {
      avatarEl.style.backgroundImage = "url(" + avatarUrl + ")";
    } else {
      avatarEl.style.backgroundImage = "";
    }

    usernameEl.textContent = username || "";
    statusEl.textContent = statusText || "";

    const durationEl = callUI.querySelector(".duration");
    if (durationEl) durationEl.textContent = "00:00";

    const speakerBtn = callUI.querySelector(".speaker");
    if (speakerBtn) {
      speakerBtn.classList.toggle("active", speakerOn);
      speakerBtn.setAttribute("aria-pressed", String(speakerOn));
    }

    callUI.style.display = "block";

    if (!isMobileDevice()) {
      const left = parseInt(callUI.style.left, 10);
      const top = parseInt(callUI.style.top, 10);
      if (isNaN(left) || isNaN(top)) {
        callUI.style.left = Math.max(0, window.innerWidth - 340) + "px";
        callUI.style.top = "60px";
      }
      callUI.style.right = "auto";
      callUI.style.bottom = "auto";
    }

    setTimeout(function () {
      callUI.classList.add("open");
    }, 10);
  }

  function setIncomingCallButtonState(ringing) {
    if (btn) {
      if (ringing) btn.classList.add("diskuz-call-incoming");
      else btn.classList.remove("diskuz-call-incoming");
    }
  }

  function closeCallUI() {
    if (!callUI) return;
    setIncomingCallButtonState(false);
    callUI.classList.remove("open", "diskuz-call-minimized", "diskuz-call-controls-hidden", "diskuz-call-incoming-ringing");
    const hideBtn = callUI.querySelector(".diskuz-call-hide-btn");
    const showBtn = callUI.querySelector(".diskuz-call-show-controls");
    if (hideBtn) hideBtn.style.display = "flex";
    if (showBtn) showBtn.style.display = "none";
    if (proximityOverlay) {
      proximityOverlay.style.display = "none";
    }
    setTimeout(function () {
      callUI.style.display = "none";
      callUI.style.transform = "";
    }, 200);
  }

  function isMobileDevice() {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (typeof window.orientation !== "undefined") || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
  }

  /* --- WEBRTC AUDIO ENGINE --- */
  let rtcPeer = null;
  let rtcLocalStream = null;
  let rtcRemoteAudio = null;
  let iceCandidateQueue = [];
  let pendingIceCandidatesToAdd = [];
  let iceAddInProgress = false;
  let speakerOn = true;
  let currentSinkId = "";
  let currentSinkIndex = 0;
  let audioOutputDevices = [];
  let callDurationIntervalId = null;
  let callConnectedAt = null;

  function ensureRemoteAudio() {
    if (!rtcRemoteAudio) {
      rtcRemoteAudio = document.getElementById("diskuz-remote-audio");
      if (!rtcRemoteAudio) {
        rtcRemoteAudio = document.createElement("audio");
        rtcRemoteAudio.id = "diskuz-remote-audio";
        rtcRemoteAudio.autoplay = true;
        rtcRemoteAudio.playsInline = true;
        rtcRemoteAudio.setAttribute("playsinline", "true");
        rtcRemoteAudio.setAttribute("webkit-playsinline", "true");
        rtcRemoteAudio.muted = false;
        rtcRemoteAudio.style.display = "none";
        document.body.appendChild(rtcRemoteAudio);
      }
    }
  }

  function setSinkIdSupported() {
    return (
      rtcRemoteAudio &&
      typeof rtcRemoteAudio.setSinkId === "function"
    );
  }

  async function applySpeakerSink() {
    if (!rtcRemoteAudio || !setSinkIdSupported()) return;
    const sinkId = speakerOn ? currentSinkId : "";
    try {
      await rtcRemoteAudio.setSinkId(sinkId || "");
    } catch (e) {
      console.warn("diskuz-call: setSinkId failed", e);
    }
  }

  async function refreshAudioOutputDevices() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function")
      return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioOutputDevices = devices.filter((d) => d.kind === "audiooutput");
    } catch (e) {
      audioOutputDevices = [];
    }
  }

  async function cycleSpeakerOutput() {
    if (!setSinkIdSupported()) return;
    await refreshAudioOutputDevices();
    const totalOptions = audioOutputDevices.length + 1;
    currentSinkIndex = (currentSinkIndex + 1) % totalOptions;
    if (currentSinkIndex === 0) {
      currentSinkId = "";
      speakerOn = false;
      await applySpeakerSink();
      showToast(isMobileDevice() ? "Earpiece" : "Default");
      return;
    }
    const device = audioOutputDevices[currentSinkIndex - 1];
    currentSinkId = device.deviceId;
    speakerOn = true;
    await applySpeakerSink();
    const label = (device.label || "Speaker").slice(0, 28);
    showToast(label);
  }

  function initSpeakerStateForCall() {
    if (isMobileDevice()) {
      speakerOn = false;
      currentSinkId = "";
      currentSinkIndex = 0;
    } else {
      speakerOn = true;
      currentSinkIndex = 0;
      currentSinkId = "";
    }
  }

  async function rtcStartLocalAudio() {
    return rtcStartLocalMedia(false);
  }

  async function rtcStartLocalMedia(withVideo) {
    try {
      if (rtcLocalStream) return rtcLocalStream;
      const opts = { audio: true, video: withVideo ? { facingMode: "user" } : false };
      rtcLocalStream = await navigator.mediaDevices.getUserMedia(opts);
      return rtcLocalStream;
    } catch (e) {
      console.error("Media permission denied", e);
      showToast(withVideo ? "Camera or microphone blocked." : "Microphone blocked.");
      return null;
    }
  }

  function rtcCreatePeer(targetUserId) {
    ensureRemoteAudio();

    const iceServers = getIceServers();
    rtcPeer = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 10,
    });

    rtcPeer.onconnectionstatechange = () => {
      const connState = rtcPeer?.connectionState;
      log("[*] RTCPeerConnection state:", connState);
      if (connState === "connected" && !callDurationIntervalId && callConnectedAt == null) {
        callConnectedAt = Date.now();
        startCallDurationTimer();
      }
    };
    rtcPeer.oniceconnectionstatechange = () => {
      const state = rtcPeer?.iceConnectionState;
      log("[*] ICE connection state:", state);
      if (state === "connected" && !callDurationIntervalId) {
        if (callConnectedAt == null) callConnectedAt = Date.now();
        startCallDurationTimer();
      }
      if (state === "failed") {
        log("[*] ICE failed – connection could not be established");
        showToast("Connection failed. Please try again.");
        endCurrentCall("failed");
      }
    };

    rtcPeer.onicecandidate = (event) => {
      if (event.candidate && window.DiskuzCallSend) {
        const candidate =
          typeof event.candidate.toJSON === "function"
            ? event.candidate.toJSON()
            : event.candidate;
        log("[*] onicecandidate: sending ICE to userId", targetUserId);
        window.DiskuzCallSend({
          type: "ice_candidate",
          to_user_id: targetUserId,
          candidate,
        });
      }
    };

    rtcPeer.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      if (event.track.kind === "audio" && rtcRemoteAudio) {
        rtcRemoteAudio.srcObject = stream;
        if (isMobileDevice()) rtcRemoteAudio.volume = 0.25;
        applySpeakerSink();
        rtcRemoteAudio.play().catch(() => {});
      }
    };

    if (rtcLocalStream) {
      rtcLocalStream.getTracks().forEach((track) => {
        rtcPeer.addTrack(track, rtcLocalStream);
      });
    }

    return rtcPeer;
  }

  function serializeSdp(obj) {
    if (!obj) return null;
    if (typeof obj.toJSON === "function") return obj.toJSON();
    if (obj.type != null && obj.sdp != null) return { type: obj.type, sdp: obj.sdp };
    return obj;
  }

  async function rtcMakeOffer(targetUserId) {
    log("[CALLER] rtcMakeOffer start targetUserId=", targetUserId);
    iceCandidateQueue = [];
    const stream = await rtcStartLocalAudio();
    if (!stream) {
      log("[CALLER] rtcMakeOffer: no stream (mic blocked?)");
      return;
    }
    log("[CALLER] rtcMakeOffer: got stream, creating peer and offer");
    rtcCreatePeer(targetUserId);
    const offer = await rtcPeer.createOffer();
    await rtcPeer.setLocalDescription(offer);
    const sdpPayload = serializeSdp(offer);
    log("[CALLER] rtcMakeOffer: offer created, sdp type=", sdpPayload?.type, "sdp length=", (sdpPayload?.sdp || "").length);
    let sendFn = window.DiskuzCallSend;
    if (!sendFn) {
      log("[CALLER] rtcMakeOffer: waiting for DiskuzCallSend...");
      sendFn = await waitForDiskuzCallSend(2000);
    }
    if (!sendFn) {
      log("[CALLER] rtcMakeOffer: DiskuzCallSend not found");
      showToast(MSG_CALL_UNAVAILABLE);
      endCurrentCall("rejected");
      return;
    }
    if (sdpPayload) {
      log("[CALLER] rtcMakeOffer: sending call_offer to userId", targetUserId);
      const sendPromise = sendFn({
        type: "call_offer",
        to_user_id: targetUserId,
        from_user_id: null,
        sdp: sdpPayload,
      });
      if (sendPromise && typeof sendPromise.then === "function") {
        sendPromise.then(
          () => log("[CALLER] rtcMakeOffer: call_offer sent OK"),
          (err) => {
            const reason = getSignalErrorReason(err);
            log("[CALLER] rtcMakeOffer: call_offer send FAIL", err, "reason:", reason);
            showToast(messageForSignalReason(reason, currentCall.username));
            endCurrentCall("rejected");
          }
        );
      }
    } else {
      log("[CALLER] rtcMakeOffer: no sdpPayload, not sending");
    }
  }

  async function rtcHandleOffer(data) {
    log("[CALLEE] rtcHandleOffer: got offer, has sdp?", !!data.sdp);
    currentCall.offerSdp = data.sdp;
  }

  async function rtcSendAnswer() {
    if (!currentCall.active || currentCall.direction !== "incoming" || !currentCall.userId || !currentCall.offerSdp) {
      log("[CALLEE] rtcSendAnswer: skip, wrong state or no userId/offerSdp");
      return;
    }
    if (!currentCall.offerSdp.type || !currentCall.offerSdp.sdp) {
      log("[CALLEE] rtcSendAnswer: invalid offerSdp, skip");
      return;
    }
    log("[CALLEE] rtcSendAnswer: start, userId=", currentCall.userId);
    const stream = await rtcStartLocalAudio();
    if (!stream) {
      log("[CALLEE] rtcSendAnswer: no stream");
      return;
    }
    rtcCreatePeer(currentCall.userId);
    await rtcPeer.setRemoteDescription(
      new RTCSessionDescription(currentCall.offerSdp)
    );
    log("[CALLEE] rtcSendAnswer: set remote description OK, queued ICE count=", iceCandidateQueue.length);
    for (const c of iceCandidateQueue) {
      try {
        await rtcPeer.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        console.error("[diskuz-call] Error adding queued ICE candidate", err);
      }
    }
    iceCandidateQueue = [];

    const answer = await rtcPeer.createAnswer();
    await rtcPeer.setLocalDescription(answer);
    const sdpPayload = serializeSdp(answer);
    if (window.DiskuzCallSend && sdpPayload) {
      log("[CALLEE] rtcSendAnswer: sending call_answer to userId", currentCall.userId);
      window.DiskuzCallSend({
        type: "call_answer",
        to_user_id: currentCall.userId,
        sdp: sdpPayload,
      });
      log("[CALLEE] rtcSendAnswer: call_answer sent");
    } else {
      log("[CALLEE] rtcSendAnswer: no DiskuzCallSend or sdpPayload");
    }
  }

  async function rtcHandleAnswer(data) {
    log("[CALLER] rtcHandleAnswer: got answer, has sdp?", !!data.sdp);
    if (!currentCall.active || currentCall.direction !== "outgoing" || currentCall.userId !== data.from_user_id) {
      log("[CALLER] rtcHandleAnswer: skip (wrong state or peer)");
      return;
    }
    if (!rtcPeer) {
      log("[CALLER] rtcHandleAnswer: no rtcPeer, skip");
      return;
    }
    if (!data.sdp || !data.sdp.type || !data.sdp.sdp) {
      log("[CALLER] rtcHandleAnswer: invalid sdp, skip");
      return;
    }
    await rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp));
    log("[CALLER] rtcHandleAnswer: set remote description OK, queued ICE count=", iceCandidateQueue.length);
    for (const c of iceCandidateQueue) {
      try {
        await rtcPeer.addIceCandidate(new RTCIceCandidate(c));
        log("[CALLER] rtcHandleAnswer: added queued ICE candidate");
      } catch (err) {
        console.error("[diskuz-call] Caller: error adding queued ICE candidate", err);
      }
    }
    iceCandidateQueue = [];
  }

  async function drainPendingIceCandidates() {
    if (!rtcPeer || iceAddInProgress || pendingIceCandidatesToAdd.length === 0) return;
    iceAddInProgress = true;
    while (pendingIceCandidatesToAdd.length > 0 && rtcPeer) {
      const candidate = pendingIceCandidatesToAdd.shift();
      try {
        await rtcPeer.addIceCandidate(new RTCIceCandidate(candidate));
        log("[*] rtcHandleIce: added ICE candidate (sequential)");
      } catch (e) {
        console.error("[diskuz-call] Error adding ICE candidate", e);
      }
    }
    iceAddInProgress = false;
  }

  function rtcHandleIce(data) {
    if (!data.candidate) return;
    const fromId = data.from_user_id;
    const isFromPeer = currentCall.active && currentCall.userId === fromId;
    if (!isFromPeer) return;

    if (!rtcPeer || !rtcPeer.remoteDescription) {
      iceCandidateQueue.push(data.candidate);
      log("[*] rtcHandleIce: queued candidate (remote description not set yet), queue size=", iceCandidateQueue.length);
      return;
    }
    if (rtcPeer.iceConnectionState === "connected" || rtcPeer.iceConnectionState === "completed") {
      return;
    }
    pendingIceCandidatesToAdd.push(data.candidate);
    drainPendingIceCandidates();
  }

  function startCallDurationTimer() {
    stopCallDurationTimer();
    const el = callUI && callUI.querySelector(".duration");
    if (!el) return;
    function tick() {
      if (!callConnectedAt) return;
      const sec = Math.floor((Date.now() - callConnectedAt) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      el.textContent = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }
    tick();
    callDurationIntervalId = setInterval(tick, 1000);
  }

  function stopCallDurationTimer() {
    if (callDurationIntervalId) {
      clearInterval(callDurationIntervalId);
      callDurationIntervalId = null;
      callConnectedAt = null;
    }
    const el = callUI && callUI.querySelector(".duration");
    if (el) el.textContent = "00:00";
  }

  function rtcEnd() {
    stopCallDurationTimer();
    if (rtcPeer) {
      rtcPeer.close();
      rtcPeer = null;
    }
    if (rtcLocalStream) {
      rtcLocalStream.getTracks().forEach((t) => t.stop());
      rtcLocalStream = null;
    }
    currentCall.offerSdp = null;
    iceCandidateQueue = [];
    pendingIceCandidatesToAdd = [];
    currentSinkId = "";
    currentSinkIndex = 0;
  }

  function resetCurrentCall() {
    currentCall.active = false;
    currentCall.direction = null;
    currentCall.username = null;
    currentCall.userId = null;
    currentCall.isRinging = false;
    currentCall.offerSdp = null;
    currentCall.avatarTemplate = null;
  }

  function endCurrentCall(result) {
    if (currentCall.active && currentCall.username) {
      const durationSeconds = callConnectedAt != null
        ? Math.floor((Date.now() - callConnectedAt) / 1000)
        : null;
      addHistoryEntry({
        direction: currentCall.direction || "outgoing",
        result: result || "ended",
        username: currentCall.username,
        durationSeconds,
      });
    }
    if (currentCall.userId && window.DiskuzCallSend) {
      window.DiskuzCallSend({
        type: "call_end",
        to_user_id: currentCall.userId,
      });
    }
    rtcEnd();
    resetCurrentCall();
    closeCallUI();
  }

  function startOutgoingCall(username, userId, avatarTemplate) {
    log("startOutgoingCall", username, userId);
    if (userId != null && userId === currentUserId) {
      showToast("You cannot call yourself.");
      return;
    }

    initSpeakerStateForCall();
    currentCall.active = true;
    currentCall.direction = "outgoing";
    currentCall.username = username;
    currentCall.userId = userId;
    currentCall.isRinging = true;

    updateCallUI(username, avatarTemplate, "Calling...");

    addHistoryEntry({
      direction: "outgoing",
      result: "started",
      username: username,
    });

    rtcMakeOffer(userId);
  }

  function handleIncomingCall(data) {
    log("[CALLEE] handleIncomingCall from", data.from_username, "id", data.from_user_id, "callStatus=", callStatus);
    if (callStatus === "busy" || callStatus === "not_available") {
      if (window.DiskuzCallSend) {
        window.DiskuzCallSend({
          type: "call_reject",
          to_user_id: data.from_user_id,
          reason: callStatus === "busy" ? "busy" : "not_available",
        });
      }
      addHistoryEntry({
        direction: "incoming",
        result: callStatus === "busy" ? "busy" : "not_available",
        username: data.from_username || "Unknown",
      });
      showToast(
        callStatus === "busy"
          ? "Incoming call auto-rejected (busy)."
          : "Incoming call auto-rejected (not available)."
      );
      return;
    }

    if (currentCall.active) {
      if (window.DiskuzCallSend) {
        window.DiskuzCallSend({
          type: "call_reject",
          to_user_id: data.from_user_id,
          reason: "busy",
        });
      }
      addHistoryEntry({
        direction: "incoming",
        result: "busy",
        username: data.from_username || "Unknown",
      });
      showToast("Incoming call rejected (already in a call).");
      return;
    }

    iceCandidateQueue = [];
    currentCall.active = true;
    currentCall.direction = "incoming";
    currentCall.username = data.from_username || "Unknown";
    currentCall.userId = data.from_user_id;
    currentCall.isRinging = true;
    currentCall.offerSdp = data.sdp || null;
    currentCall.avatarTemplate = data.avatar_template || null;

    setIncomingCallButtonState(true);
    playIncomingCallRing();
    showBrowserNotification(data.from_username || "Someone");
    showIncomingCallUI(data.from_username, data.avatar_template);
  }

  function showIncomingCallUI(username, avatarTemplate) {
    createCallUI();
    callUI.classList.add("diskuz-call-incoming-ringing");

    const avatarUrl = avatarTemplate ? avatarTemplate.replace("{size}", "120") : null;
    const avatarEl = callUI.querySelector(".avatar");
    const usernameEl = callUI.querySelector(".username");
    const statusEl = callUI.querySelector(".status");

    if (avatarUrl) {
      avatarEl.style.backgroundImage = "url(" + avatarUrl + ")";
    } else {
      avatarEl.style.backgroundImage = "";
    }

    usernameEl.textContent = username || "";
    statusEl.textContent = "Incoming call...";

    const oldIncomingRow = callUI.querySelector(".incoming-row");
    if (oldIncomingRow) {
      oldIncomingRow.remove();
    }

    const incomingRow = document.createElement("div");
    incomingRow.className = "incoming-row";
    incomingRow.style.display = "flex";
    incomingRow.style.justifyContent = "center";
    incomingRow.style.gap = "10px";
    incomingRow.style.width = "100%";
    incomingRow.style.marginBottom = "12px";

    const acceptBtn = document.createElement("button");
    acceptBtn.className = "diskuz-accept-btn";
    acceptBtn.innerHTML = "Accept <span class=\"accept-dots\"><span class=\"dot\">.</span><span class=\"dot\">.</span><span class=\"dot\">.</span><span class=\"dot\">.</span></span>";
    acceptBtn.style.flex = "1";
    acceptBtn.style.padding = "8px 10px";
    acceptBtn.style.borderRadius = "15px";
    acceptBtn.style.border = "none";
    acceptBtn.style.background = "#22c55e";
    acceptBtn.style.color = "#fff";
    acceptBtn.style.cursor = "pointer";
    acceptBtn.style.fontSize = "14px";

    const rejectBtn = document.createElement("button");
    rejectBtn.textContent = "Reject";
    rejectBtn.style.flex = "1";
    rejectBtn.style.padding = "8px 10px";
    rejectBtn.style.borderRadius = "15px";
    rejectBtn.style.border = "none";
    rejectBtn.style.background = "#ef4444";
    rejectBtn.style.color = "#fff";
    rejectBtn.style.cursor = "pointer";
    rejectBtn.style.fontSize = "14px";

    incomingRow.appendChild(acceptBtn);
    incomingRow.appendChild(rejectBtn);

    const callInner = callUI.querySelector(".call-inner");
    const controlsBlock = callInner && callInner.querySelector(".diskuz-call-controls-block");
    const insertBeforeRef = controlsBlock || (callInner && callInner.firstElementChild);
    if (callInner && insertBeforeRef) {
      callInner.insertBefore(incomingRow, insertBeforeRef);
    } else if (callInner) {
      callInner.appendChild(incomingRow);
    }

    acceptBtn.addEventListener("click", () => {
      acceptIncomingCall();
    });

    rejectBtn.addEventListener("click", () => {
      rejectIncomingCall();
    });

    callUI.style.display = "block";
    callUI.classList.remove("diskuz-call-minimized");

    if (!isMobileDevice()) {
      const left = parseInt(callUI.style.left, 10);
      const top = parseInt(callUI.style.top, 10);
      if (isNaN(left) || isNaN(top)) {
        callUI.style.left = Math.max(0, window.innerWidth - 340) + "px";
        callUI.style.top = "60px";
      }
      callUI.style.right = "auto";
      callUI.style.bottom = "auto";
    }

    if (callUI.parentNode) callUI.parentNode.appendChild(callUI);
    callUI.style.zIndex = "100001";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        callUI.classList.add("open");
      });
    });
  }

  async function acceptIncomingCall() {
    log("[CALLEE] acceptIncomingCall clicked");
    const acceptBtn = callUI && callUI.querySelector(".diskuz-accept-btn");
    if (acceptBtn) acceptBtn.classList.add("answered");
    initSpeakerStateForCall();
    if (!currentCall.active || currentCall.direction !== "incoming") {
      log("[CALLEE] acceptIncomingCall: skip (not active or not incoming)");
      return;
    }
    currentCall.isRinging = false;
    setIncomingCallButtonState(false);
    await rtcSendAnswer();

    const statusEl = callUI && callUI.querySelector(".status");
    if (statusEl) {
      statusEl.textContent = "In call...";
    }

    const incomingRow = callUI && callUI.querySelector(".incoming-row");
    if (incomingRow) incomingRow.remove();
    if (callUI) callUI.classList.remove("diskuz-call-incoming-ringing");

    addHistoryEntry({
      direction: "incoming",
      result: "accepted",
      username: currentCall.username || "Unknown",
    });

    showToast("Call accepted.");
  }

  function rejectIncomingCall() {
    if (!currentCall.active || currentCall.direction !== "incoming") return;

    if (window.DiskuzCallSend && currentCall.userId) {
      window.DiskuzCallSend({
        type: "call_reject",
        to_user_id: currentCall.userId,
        reason: "rejected",
      });
    }

    addHistoryEntry({
      direction: "incoming",
      result: "rejected",
      username: currentCall.username || "Unknown",
    });

    showToast("Call rejected.");
    rtcEnd();
    resetCurrentCall();
    closeCallUI();
  }

  /* --- MESSAGEBUS: sottoscrizione anche in UI (fallback se il glue non parte sul ricevente) --- */
  function subscribeMessageBus() {
    if (window.DiskuzCallMessageBusSubscribed) return;
    window.DiskuzCallMessageBusSubscribed = true;
    MessageBus.subscribe("/diskuz-call/signals", (data) => {
      log("[UI] MessageBus message received", data.signal_type, "from_user_id", data.from_user_id);
      const payload = data.payload || {};
      const detail = {
        ...payload,
        type: data.signal_type,
        from_user_id: data.from_user_id,
        from_username: data.from_username,
        sdp: payload.sdp != null ? payload.sdp : data.sdp,
        avatar_template: payload.avatar_template != null ? payload.avatar_template : data.avatar_template,
        candidate: payload.candidate != null ? payload.candidate : data.candidate,
      };
      window.dispatchEvent(new CustomEvent("diskuz-call-signal", { detail }));
    });
    log("[UI] MessageBus subscribed to /diskuz-call/signals (fallback)");
  }

  /* --- SIGNALING LISTENER --- */
  log("Registering diskuz-call-signal listener on window");
  window.addEventListener("diskuz-call-signal", function (e) {
    const data = e.detail || {};
    const sdp = data.sdp ?? (data.payload && data.payload.sdp);
    log("[UI] diskuz-call-signal received type=", data.type, "from_user_id=", data.from_user_id, "from_username=", data.from_username, "hasSdp?", !!sdp, "hasCandidate?", !!data.candidate);

    switch (data.type) {
      case "call_offer":
        if (currentCall.active && currentCall.direction === "incoming" && currentCall.userId === data.from_user_id) {
          log("[CALLEE] call_offer duplicate, ignoring");
          return;
        }
        log("[CALLEE] handling call_offer, will show incoming UI and rtcHandleOffer");
        handleIncomingCall({
          from_user_id: data.from_user_id,
          from_username: data.from_username,
          avatar_template: data.avatar_template,
          sdp: sdp,
        });
        rtcHandleOffer({ ...data, sdp });
        break;

      case "call_answer":
        if (
          currentCall.active &&
          currentCall.direction === "outgoing" &&
          currentCall.userId === data.from_user_id
        ) {
          currentCall.isRinging = false;
          const statusEl = callUI && callUI.querySelector(".status");
          if (statusEl) {
            statusEl.textContent = "In call...";
          }
          addHistoryEntry({
            direction: "outgoing",
            result: "accepted",
            username: currentCall.username || "Unknown",
          });
          showToast("Call accepted.");
        }
        rtcHandleAnswer(data);
        break;

      case "call_reject":
        if (
          currentCall.active &&
          currentCall.direction === "outgoing" &&
          currentCall.userId === data.from_user_id
        ) {
          const reason = data.reason || "rejected";
          addHistoryEntry({
            direction: "outgoing",
            result: reason,
            username: currentCall.username || "Unknown",
          });
          showToast(
            reason === "busy"
              ? "User is busy."
              : reason === "not_available"
              ? "User is not available."
              : "Call rejected."
          );
          rtcEnd();
          resetCurrentCall();
          closeCallUI();
        }
        break;

      case "call_end":
        if (currentCall.active && currentCall.userId === data.from_user_id) {
          const durationSeconds = callConnectedAt != null
            ? Math.floor((Date.now() - callConnectedAt) / 1000)
            : null;
          addHistoryEntry({
            direction: currentCall.direction || "incoming",
            result: "ended",
            username: currentCall.username || "Unknown",
            durationSeconds,
          });
          showToast("Call ended.");
          rtcEnd();
          resetCurrentCall();
          closeCallUI();
        }
        break;

      case "ice_candidate":
        rtcHandleIce(data);
        break;

      default:
        break;
    }
  });

  function toggleWidget() {
    if (!widget) return;

    if (widget.classList.contains("open")) {
      widget.classList.remove("open");
      setTimeout(function () {
        widget.style.display = "none";
      }, 200);
    } else {
      widget.style.display = "block";
      setTimeout(function () {
        widget.classList.add("open");
      }, 10);
    }
  }

  function toggleWidgetForceClose() {
    if (!widget) return;
    widget.classList.remove("open");
    setTimeout(function () {
      widget.style.display = "none";
    }, 200);
  }

  window.addEventListener("diskuz-call-start", (e) => {
    const d = e.detail || {};
    if (d.username != null && d.userId != null) {
      startOutgoingCall(d.username, d.userId, d.avatar_template ?? null);
    }
  });

  function initPage() {
    const currentUser = api.getCurrentUser();
    if (!currentUser) {
      log("initPage: no current user, skipping");
      currentUserId = null;
      currentUserUsername = null;
      return;
    }
    currentUserId = currentUser.id;
    currentUserUsername = (currentUser.username || "").toLowerCase();
    log("[UI] initPage: user", currentUser.username, "id", currentUserId, "– signal listener already on window");
    subscribeMessageBus();
    loadHistory();
    try {
      const savedStatus = window.localStorage.getItem(STATUS_KEY);
      if (savedStatus === "busy" || savedStatus === "not_available" || savedStatus === "available") callStatus = savedStatus;
    } catch (e) {}
    createFloatingButton();
    createWidget();
    updateCallFeatureVisibility();
  }
  window.addEventListener("diskuz-call-allowed-changed", updateCallFeatureVisibility);
  api.onPageChange(initPage);
  initPage();
});
