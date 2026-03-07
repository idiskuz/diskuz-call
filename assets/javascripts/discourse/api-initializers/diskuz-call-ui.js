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
  let toastContainer = null;
  const WIDGET_PAGE_HOME = "home";
  const WIDGET_PAGE_NOTIFICATIONS = "notifications";
  let lastWidgetRect = null;
  const WIDGET_RECT_STORAGE_KEY = "diskuz_call_widget_rect";

  function clampRectToViewport(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return rect;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let { left, top, width, height } = rect;
    const right = left + width;
    const bottom = top + height;
    const offScreen = left < 0 || top < 0 || right > W || bottom > H;
    if (offScreen) {
      top = Math.max(0, Math.min(H - height, (H - height) / 2));
      left = Math.max(0, Math.min(W - width, left));
    }
    return { left, top, width, height };
  }

  function saveWidgetRectToStorage() {
    if (!lastWidgetRect || lastWidgetRect.width <= 0) return;
    try {
      window.localStorage.setItem(WIDGET_RECT_STORAGE_KEY, JSON.stringify({
        left: lastWidgetRect.left,
        top: lastWidgetRect.top,
        width: lastWidgetRect.width,
        height: lastWidgetRect.height,
      }));
    } catch (e) { /* ignore */ }
  }

  function loadWidgetRectFromStorage() {
    try {
      const raw = window.localStorage.getItem(WIDGET_RECT_STORAGE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && typeof o.left === "number" && typeof o.top === "number" && o.width > 0 && o.height > 0) {
        lastWidgetRect = clampRectToViewport({ left: o.left, top: o.top, width: o.width, height: o.height });
        saveWidgetRectToStorage();
      }
    } catch (e) { /* ignore */ }
  }

  function captureWidgetRect() {
    if (widget && widget.offsetParent != null) {
      lastWidgetRect = widget.getBoundingClientRect();
      saveWidgetRectToStorage();
    }
  }

  function captureCallUIRect() {
    if (callUI && callUI.offsetParent != null) {
      lastWidgetRect = callUI.getBoundingClientRect();
      saveWidgetRectToStorage();
    }
  }

  function applyLastRectToWidget() {
    if (!widget || isMobileDevice()) return;
    if (lastWidgetRect && lastWidgetRect.width > 0) {
      const rect = clampRectToViewport(lastWidgetRect);
      widget.style.left = rect.left + "px";
      widget.style.top = rect.top + "px";
      widget.style.width = rect.width + "px";
      widget.style.height = rect.height + "px";
      widget.style.right = "auto";
      widget.style.bottom = "auto";
    }
  }

  function applyWidgetRectToCallUI() {
    if (!callUI || isMobileDevice()) return;
    const w = 320;
    const h = 440;
    if (lastWidgetRect && lastWidgetRect.width > 0) {
      callUI.style.left = lastWidgetRect.left + "px";
      callUI.style.top = lastWidgetRect.top + "px";
      callUI.style.width = lastWidgetRect.width + "px";
      callUI.style.height = lastWidgetRect.height + "px";
      callUI.style.right = "auto";
      callUI.style.bottom = "auto";
    } else {
      const right = 90;
      const bottom = 270;
      callUI.style.left = (window.innerWidth - right - w) + "px";
      callUI.style.top = (window.innerHeight - bottom - h) + "px";
      callUI.style.width = w + "px";
      callUI.style.height = h + "px";
      callUI.style.right = "auto";
      callUI.style.bottom = "auto";
    }
  }

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
  const NOTIFICATIONS_READ_KEY = "diskuz_call_notifications_read_at";
  const USER_RESOLVE_CACHE_TTL_MS = 60000;
  const CALL_RATE_LIMIT_WINDOW_MS = 60000;
  const CALL_RATE_LIMIT_MAX_PER_USER = 2;
  let callRateLimitEntries = [];
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
      case "cannot_call_yourself":
        return it ? "Non puoi chiamare te stesso." : "You cannot call yourself.";
      case "follow_required":
        return it
          ? "Non puoi chiamare un utente che non ti segue."
          : "You cannot call a user who doesn't follow you.";
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
    if (!incomingCallAudioContext) {
      try {
        incomingCallAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn("diskuz-call: could not create AudioContext", e);
        return Promise.resolve();
      }
    }
    if (incomingCallAudioContext.state === "suspended") {
      return incomingCallAudioContext.resume().catch((e) => {
        console.warn("diskuz-call: AudioContext resume failed", e);
      });
    }
    return Promise.resolve();
  }

  function ensureAudioContextRunning() {
    return unlockAudioForIncomingSound();
  }

  function onceDocumentInteractionForAudio() {
    if (window._diskuzCallAudioUnlockBound) return;
    window._diskuzCallAudioUnlockBound = true;
    const unlock = () => unlockAudioForIncomingSound();
    document.addEventListener("click", unlock, { once: true, passive: true });
    document.addEventListener("touchstart", unlock, { once: true, passive: true });
    document.addEventListener("keydown", unlock, { once: true, passive: true });
  }

  /* --- FALLBACK BEEP (when Web Audio is blocked) --- */
  function playFallbackBeep(freq, durationMs) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq || 440;
      osc.type = "sine";
      const d = (durationMs || 150) / 1000;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + d);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + d);
    } catch (e) {
      console.warn("diskuz-call: fallback beep failed", e);
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
        a.volume = 0.85;
        a.play().catch((err) => {
          log("diskuz-call: custom ringtone play failed", err);
          playFallbackBeep(880, 200);
        });
      } catch (e) {
        console.warn("diskuz-call: could not play custom ringtone", e);
        playFallbackBeep(880, 200);
      }
      return;
    }
    ensureAudioContextRunning().then(() => {
      const ctx = incomingCallAudioContext;
      if (!ctx) {
        playFallbackBeep(880, 200);
        return;
      }
      if (ctx.state === "suspended") {
        ctx.resume().then(() => playIncomingCallBeep(ctx)).catch(() => playFallbackBeep(880, 200));
        return;
      }
      try {
        playIncomingCallBeep(ctx);
      } catch (e) {
        playFallbackBeep(880, 200);
      }
    }).catch(() => playFallbackBeep(880, 200));
  }

  /* Suoneria predefinita: doppio tono tipo telefono classico (due note alternate) */
  function playIncomingCallBeep(ctx) {
    try {
      const t0 = ctx.currentTime;
      const gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
      const toneDuration = 0.4;
      const gap = 0.15;
      const vol = 0.28;

      /* primo tono (più grave) */
      const osc1 = ctx.createOscillator();
      osc1.connect(gainNode);
      osc1.frequency.value = 440;
      osc1.type = "sine";
      gainNode.gain.setValueAtTime(0, t0);
      gainNode.gain.linearRampToValueAtTime(vol, t0 + 0.02);
      gainNode.gain.setValueAtTime(vol, t0 + toneDuration - 0.02);
      gainNode.gain.linearRampToValueAtTime(0, t0 + toneDuration);
      osc1.start(t0);
      osc1.stop(t0 + toneDuration);

      /* secondo tono (più acuto) dopo una breve pausa */
      const t1 = t0 + toneDuration + gap;
      const osc2 = ctx.createOscillator();
      osc2.connect(gainNode);
      osc2.frequency.value = 554; /* Do#5 */
      osc2.type = "sine";
      gainNode.gain.setValueAtTime(0, t1);
      gainNode.gain.linearRampToValueAtTime(vol, t1 + 0.02);
      gainNode.gain.setValueAtTime(vol, t1 + toneDuration - 0.02);
      gainNode.gain.linearRampToValueAtTime(0, t1 + toneDuration);
      osc2.start(t1);
      osc2.stop(t1 + toneDuration);
    } catch (e) {
      console.warn("diskuz-call: ring tone failed", e);
      throw e;
    }
  }

  /* Suonerie alternative (5 preset: classic, modern, soft, double, melodic) */
  function playAlternativeRingtonePreset(ctx, preset) {
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const vol = 0.28;
    const tone = (freq, start, dur) => {
      const o = ctx.createOscillator();
      o.connect(g);
      o.frequency.value = freq;
      o.type = "sine";
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(vol, start + 0.02);
      g.gain.setValueAtTime(vol, start + dur - 0.02);
      g.gain.linearRampToValueAtTime(0, start + dur);
      o.start(start);
      o.stop(start + dur);
    };
    try {
      switch (preset) {
        case "modern":
          tone(880, t0, 0.15);
          tone(880, t0 + 0.35, 0.15);
          break;
        case "soft":
          tone(660, t0, 0.5);
          break;
        case "double":
          tone(523, t0, 0.35);
          tone(659, t0 + 0.5, 0.35);
          break;
        case "melodic":
          tone(523, t0, 0.2);
          tone(659, t0 + 0.28, 0.2);
          tone(784, t0 + 0.56, 0.2);
          tone(1047, t0 + 0.84, 0.25);
          break;
        case "classic":
        default:
          playIncomingCallBeep(ctx);
          return;
      }
    } catch (e) {
      console.warn("diskuz-call: alternative preset failed", e);
      playIncomingCallBeep(ctx);
    }
  }

  const INCOMING_RING_INTERVAL_MS = 2500;
  const INCOMING_RING_MAX_MS = 30000;
  let incomingRingIntervalId = null;
  let incomingRingTimeoutId = null;
  let currentRingingAudio = null;

  function stopIncomingRing() {
    if (incomingRingIntervalId) {
      clearInterval(incomingRingIntervalId);
      incomingRingIntervalId = null;
    }
    if (incomingRingTimeoutId) {
      clearTimeout(incomingRingTimeoutId);
      incomingRingTimeoutId = null;
    }
    if (currentRingingAudio) {
      try {
        currentRingingAudio.pause();
        currentRingingAudio.currentTime = 0;
      } catch (e) { /* ignore */ }
      currentRingingAudio = null;
    }
  }

  function playIncomingCallRingOnce() {
    const sound = (typeof window.DiskuzCallIncomingSound !== "undefined" && window.DiskuzCallIncomingSound) ? window.DiskuzCallIncomingSound : "default";
    if (sound === "none") return;
    const alternativePreset = (typeof window.DiskuzCallAlternativeRingtone !== "undefined" && window.DiskuzCallAlternativeRingtone) ? String(window.DiskuzCallAlternativeRingtone) : "classic";
    if (sound === "alternative") {
      ensureAudioContextRunning().then(() => {
        const ctx = incomingCallAudioContext;
        if (!ctx) {
          playFallbackBeep(880, 200);
          return;
        }
        if (ctx.state === "suspended") {
          ctx.resume().then(() => playAlternativeRingtonePreset(ctx, alternativePreset)).catch(() => playIncomingCallBeep(ctx));
          return;
        }
        try {
          playAlternativeRingtonePreset(ctx, alternativePreset);
        } catch (e) {
          playIncomingCallBeep(ctx);
        }
      }).catch(() => playIncomingCallSound());
      return;
    }
    const customUrl = (typeof window.DiskuzCallCustomRingtoneUrl !== "undefined" && window.DiskuzCallCustomRingtoneUrl) ? String(window.DiskuzCallCustomRingtoneUrl).trim() : "";
    if (sound === "custom" && customUrl) {
      try {
        if (currentRingingAudio) {
          try { currentRingingAudio.pause(); currentRingingAudio.currentTime = 0; } catch (e) { /* ignore */ }
          currentRingingAudio = null;
        }
        let url = customUrl;
        if (!/^https?:\/\//i.test(url)) {
          if (url.startsWith("//")) url = window.location.protocol + url;
          else if (url.startsWith("/")) url = window.location.origin + url;
          else if (/^[a-z0-9.-]+\//i.test(url) || !url.includes("/")) url = "https://" + url.replace(/^\/+/, "");
          else url = window.location.origin + "/" + url.replace(/^\/+/, "");
        }
        const audio = new Audio();
        audio.volume = 0.85;
        audio.preload = "auto";
        audio.addEventListener("canplaythrough", function onCanPlay() {
          audio.play().catch((err) => {
            log("diskuz-call: custom ringtone play failed", err);
            playIncomingCallSound();
          });
        }, { once: true });
        audio.addEventListener("error", function onErr() {
          audio.removeEventListener("error", onErr);
          currentRingingAudio = null;
          playIncomingCallSound();
        }, { once: true });
        audio.src = url;
        currentRingingAudio = audio;
      } catch (e) {
        console.warn("diskuz-call: could not play custom ringtone", e);
        playIncomingCallSound();
      }
      return;
    }
    playIncomingCallSound();
  }

  function startIncomingRingLoop() {
    stopIncomingRing();
    ensureAudioContextRunning().then(() => {
      playIncomingCallRingOnce();
    }).catch(() => {});
    incomingRingIntervalId = setInterval(playIncomingCallRingOnce, INCOMING_RING_INTERVAL_MS);
    incomingRingTimeoutId = setTimeout(() => {
      if (!currentCall.active || currentCall.direction !== "incoming" || !currentCall.isRinging) return;
      stopIncomingRing();
      currentCall.isRinging = false;
      setIncomingCallButtonState(false);
      addHistoryEntry({
        direction: "incoming",
        result: "no_answer",
        username: currentCall.username || "Unknown",
      });
      showToast(document.documentElement.lang === "it" ? "Chiamata scaduta." : "Call attempt expired.");
      resetCurrentCall();
      closeCallUI();
    }, INCOMING_RING_MAX_MS);
  }

  function playBusyTone() {
    ensureAudioContextRunning().then(() => {
      const ctx = incomingCallAudioContext;
      if (!ctx) {
        playFallbackBusyTone();
        return;
      }
      if (ctx.state === "suspended") {
        ctx.resume().then(() => {
          try { playBusyToneBeeps(ctx); } catch (e) { playFallbackBusyTone(); }
        }).catch(() => playFallbackBusyTone());
        return;
      }
      try {
        playBusyToneBeeps(ctx);
      } catch (e) {
        playFallbackBusyTone();
      }
    }).catch(() => playFallbackBusyTone());
  }

  function playFallbackBusyTone() {
    playFallbackBeep(400, 180);
    setTimeout(() => playFallbackBeep(400, 180), 320);
    setTimeout(() => playFallbackBeep(400, 180), 640);
  }

  function playBusyToneBeeps(ctx) {
    try {
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0.35, t0);
      [0, 0.32, 0.64].forEach((t) => {
        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.frequency.value = 400;
        osc.type = "sine";
        osc.start(t0 + t);
        osc.stop(t0 + t + 0.22);
      });
      gain.gain.setValueAtTime(0.35, t0 + 0.95);
      gain.gain.exponentialRampToValueAtTime(0.01, t0 + 1.5);
    } catch (e) {
      console.warn("diskuz-call: busy beeps failed", e);
      throw e;
    }
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
    updateNotificationsBadge();
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

  function formatDateShort(date) {
    const d = date instanceof Date ? date : new Date(date);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const year = d.getFullYear();
    return `${month}/${day}/${year}`;
  }

  function getNotificationsUnreadCount() {
    try {
      const raw = window.localStorage.getItem(NOTIFICATIONS_READ_KEY);
      const readAt = raw ? parseInt(raw, 10) : 0;
      return callHistory.filter((h) => new Date(h.at).getTime() > readAt).length;
    } catch (e) {
      return 0;
    }
  }

  function markNotificationsRead() {
    try {
      const t = callHistory.length ? new Date(callHistory[0].at).getTime() : Date.now();
      window.localStorage.setItem(NOTIFICATIONS_READ_KEY, String(t));
    } catch (e) {}
    updateNotificationsBadge();
  }

  function updateNotificationsBadge() {
    const count = getNotificationsUnreadCount();
    const badge = document.getElementById("diskuz-notifications-badge");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  }

  let notificationsTab = "received";

  /* --- NOTIFICATIONS: rendered inside widget (second page) --- */
  function getWidgetHistoryListEl() {
    return widget ? widget.querySelector("#diskuz-widget-history-list") : null;
  }

  function renderHistoryList() {
    const listEl = getWidgetHistoryListEl();
    if (!listEl) return;

    const isIt = document.documentElement.lang === "it";
    const emptyMsg = isIt ? "Nessuna chiamata." : "No calls yet.";
    const myUsername = (currentUserUsername || "").toLowerCase().trim();
    const isOther = (h) => {
      const u = (h.username || "").toLowerCase().trim();
      return u && u !== myUsername;
    };

    let items = [];
    if (notificationsTab === "received") {
      items = callHistory.filter((h) => h.direction === "incoming" && isOther(h));
    } else if (notificationsTab === "sent") {
      items = callHistory.filter((h) => h.direction === "outgoing" && isOther(h));
    } else if (notificationsTab === "missed") {
      items = callHistory.filter((h) => h.direction === "incoming" && isOther(h) && (h.result === "missed" || h.result === "rejected" || h.result === "busy" || h.result === "not_available"));
    } else if (notificationsTab === "recent") {
      const seen = new Set();
      items = callHistory.filter((h) => {
        const u = (h.username || "").toLowerCase().trim();
        if (!u || u === myUsername || seen.has(u)) return false;
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
        const dateStr = formatDateShort(date);
        let icon = "📤";
        if (h.direction === "incoming") icon = "📥";
        if (h.result === "missed" || h.result === "rejected") icon = "📵";
        const durationStr = h.result === "ended" && h.durationSeconds != null ? formatDuration(h.durationSeconds) : "";
        const metaParts = [dateStr, timeStr];
        if (durationStr) {
          metaParts.push((isIt ? "Durata" : "Duration") + " " + durationStr);
        } else {
          metaParts.push(h.result);
        }
        const meta = metaParts.join(" • ");

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
          showWidgetPage(WIDGET_PAGE_HOME);
          toggleWidgetForceClose();
        }).catch(() => showToast("Connection error."));
      });
    });
  }

  function showWidgetPage(page) {
    if (!widget) return;
    const homePage = widget.querySelector(".diskuz-widget-page-home");
    const notifPage = widget.querySelector(".diskuz-widget-page-notifications");
    if (!homePage || !notifPage) return;
    if (page === WIDGET_PAGE_NOTIFICATIONS) {
      homePage.classList.remove("diskuz-widget-page-active");
      notifPage.classList.add("diskuz-widget-page-active");
      markNotificationsRead();
      renderHistoryList();
    } else {
      notifPage.classList.remove("diskuz-widget-page-active");
      homePage.classList.add("diskuz-widget-page-active");
    }
  }

  function openWidgetToNotificationsPage() {
    if (!widget.classList.contains("open")) {
      applyLastRectToWidget();
      widget.style.display = "block";
      setTimeout(() => {
        widget.classList.add("open");
        setTimeout(captureWidgetRect, 50);
      }, 10);
    }
    showWidgetPage(WIDGET_PAGE_NOTIFICATIONS);
  }

  function showWidgetErrorFromCall(msg) {
    if (!widget || !msg) return;
    showWidgetPage(WIDGET_PAGE_HOME);
    applyLastRectToWidget();
    widget.style.display = "block";
    widget.classList.add("open");
    setTimeout(captureWidgetRect, 50);
    const errEl = widget.querySelector("#diskuz-call-error");
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = "block";
      setTimeout(function () {
        errEl.style.display = "none";
        errEl.textContent = "";
      }, 5000);
    }
  }

  /* --- FLOATING BUTTON (sempre visibile in basso a destra se loggato; nascosto solo se status ha risposto "non abilitato") --- */
  function updateCallFeatureVisibility() {
    /* We only create btn/widget when user is in allowed groups, so when they exist we always show */
    if (btn) btn.style.display = "";
    if (widget) {
      widget.style.display = "";
      if (widget.classList.contains("open")) widget.style.display = "block";
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

  function getSiteName() {
    try {
      const og = document.querySelector('meta[property="og:site_name"]');
      if (og && og.getAttribute("content")) return og.getAttribute("content").trim();
      const title = document.title || "";
      const part = title.split(/\s*[-–—|]\s*/)[0];
      if (part) return part.trim();
      if (window.location && window.location.hostname) return window.location.hostname;
    } catch (e) {}
    return "this site";
  }

  /* --- USERNAME WIDGET (two pages: home + notifications) --- */
  function createWidget() {
    if (!widget) {
      const isIt = document.documentElement.lang === "it";
      const siteName = getSiteName();
      const tagline = isIt
        ? "Chiama le persone che ti seguono su " + siteName + ". :-) 📱"
        : "Call people who follow you on " + siteName + ". :-) 📱";
      widget = document.createElement("div");
      widget.id = "diskuz-call-widget";

      widget.innerHTML = `
        <div class="diskuz-widget-top-bar diskuz-widget-brand-bar">
          <span class="diskuz-widget-drag-handle" aria-hidden="true">⋮⋮</span>
          <span class="diskuz-widget-brand-title">diskuz Call</span>
          <span class="diskuz-widget-brand-by">by diskuz.com</span>
        </div>
        <div class="diskuz-widget-page-home diskuz-widget-page diskuz-widget-page-active">
          <h3 class="diskuz-widget-title">${isIt ? "Chiama un amico" : "Call a friend"}</h3>
          <p class="diskuz-widget-tagline">${tagline.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
          <div class="diskuz-call-input-wrap">
            <div class="diskuz-call-input-autocomplete-wrap">
              <input id="diskuz-call-input" type="text" placeholder="${isIt ? "Inserisci username" : "Enter username"}" class="diskuz-call-input-animated" autocomplete="off">
              <div id="diskuz-call-suggestions" class="diskuz-call-suggestions" role="listbox" aria-hidden="true"></div>
            </div>
          </div>
          <button id="diskuz-call-start">Call</button>
          <div id="diskuz-call-error"></div>
          <div class="diskuz-widget-status-label">${isIt ? "Stato:" : "Status:"}</div>
          <div class="diskuz-widget-status-btns">
            <button id="diskuz-status-available" class="diskuz-status-btn">Online</button>
            <button id="diskuz-status-busy" class="diskuz-status-btn">${isIt ? "Occupato" : "Busy"}</button>
            <button id="diskuz-status-not-available" class="diskuz-status-btn">Offline</button>
          </div>
          <button id="diskuz-call-history-btn" class="diskuz-notifications-open-btn">
            ${isIt ? "Notifiche" : "Notifications"}
            <span id="diskuz-notifications-badge" class="diskuz-notifications-badge">0</span>
          </button>
          <p class="diskuz-widget-description">${(isIt
            ? "Questo widget ti consente di chiamare i tuoi amici su "
            : "This widget lets you call your friends on ") + (siteName.replace(/</g, "&lt;").replace(/>/g, "&gt;")) + (isIt
            ? ". Imposta il tuo status su Online per ricevere chiamate, mentre se non vuoi essere disturbato utilizza i tasti Occupato e Offline."
            : ". Set your status to Online to receive calls, or use Busy and Offline if you don't want to be disturbed.")}</p>
          <div class="diskuz-widget-footer">
            <button type="button" id="diskuz-widget-hide-btn" class="diskuz-widget-hide-btn">${isIt ? "Nascondi" : "Hide"}</button>
          </div>
        </div>
        <div class="diskuz-widget-page-notifications diskuz-widget-page">
          <div class="diskuz-widget-notifications-header">
            <button type="button" id="diskuz-widget-notifications-home-btn" class="diskuz-widget-home-btn" aria-label="${isIt ? "Home" : "Home"}">⌂</button>
            <strong class="diskuz-widget-notifications-title">${isIt ? "Notifiche" : "Notifications"}</strong>
          </div>
          <div class="diskuz-notifications-tabs">
            <button type="button" class="diskuz-ntab active" data-tab="received">${isIt ? "Ricevute" : "Received"}</button>
            <button type="button" class="diskuz-ntab" data-tab="sent">${isIt ? "Inviate" : "Sent"}</button>
            <button type="button" class="diskuz-ntab" data-tab="recent">${isIt ? "Recenti" : "Recent"}</button>
            <button type="button" class="diskuz-ntab" data-tab="missed">${isIt ? "Perse" : "Missed"}</button>
          </div>
          <div id="diskuz-widget-history-list" class="diskuz-widget-history-list"></div>
          <div class="diskuz-widget-footer">
            <button type="button" class="diskuz-widget-hide-btn diskuz-widget-hide-btn-notif">${isIt ? "Nascondi" : "Hide"}</button>
          </div>
        </div>
      `;

      document.body.appendChild(widget);

      if (!isMobileDevice()) {
        widget.addEventListener("mousedown", function (e) {
          if (e.target.closest("input, button, a, select, textarea, [contenteditable=\"true\"]")) return;
          e.preventDefault();
          const rect = widget.getBoundingClientRect();
          const startX = e.clientX;
          const startY = e.clientY;
          const startLeft = rect.left;
          const startTop = rect.top;
          const w = rect.width;
          const h = rect.height;
          const W = window.innerWidth;
          const H = window.innerHeight;
          function onWMove(ev) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            const newLeft = Math.max(0, Math.min(W - w, startLeft + dx));
            const newTop = Math.max(0, Math.min(H - h, startTop + dy));
            widget.style.left = newLeft + "px";
            widget.style.top = newTop + "px";
            widget.style.right = "auto";
            widget.style.bottom = "auto";
          }
          function onWEnd() {
            document.removeEventListener("mousemove", onWMove);
            document.removeEventListener("mouseup", onWEnd);
            captureWidgetRect();
          }
          document.addEventListener("mousemove", onWMove);
          document.addEventListener("mouseup", onWEnd);
        });
      }

      const input = widget.querySelector("#diskuz-call-input");
      const startBtn = widget.querySelector("#diskuz-call-start");
      const errorBox = widget.querySelector("#diskuz-call-error");
      const historyBtn = widget.querySelector("#diskuz-call-history-btn");
      const suggestionsEl = widget.querySelector("#diskuz-call-suggestions");

      let followerUsernamesCache = null;

      function getSuggestionsUsernameList() {
        const myUser = (currentUserUsername || "").toLowerCase().trim();
        const fromHistory = new Set();
        callHistory.forEach((h) => {
          const u = (h.username || "").trim();
          if (u && u.toLowerCase() !== myUser) fromHistory.add(u);
        });
        const list = Array.from(fromHistory);
        if (followerUsernamesCache && followerUsernamesCache.length) {
          followerUsernamesCache.forEach((u) => {
            const key = u.trim();
            if (key && key.toLowerCase() !== myUser) fromHistory.add(key);
          });
          return Array.from(fromHistory).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        }
        return list.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      }

      function loadFollowerUsernamesIfNeeded(cb) {
        if (followerUsernamesCache !== null) {
          if (cb) cb();
          return;
        }
        followerUsernamesCache = [];
        const tryUrl = (url) =>
          fetch(url, { credentials: "same-origin" })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data && Array.isArray(data.followers)) {
                data.followers.forEach((f) => {
                  const u = f.username || f.name || (f.user && (f.user.username || f.user.name));
                  if (u) followerUsernamesCache.push(String(u).trim());
                });
              } else if (data && Array.isArray(data)) {
                data.forEach((f) => {
                  const u = f.username || f.name || (f.user && (f.user.username || f.user.name));
                  if (u) followerUsernamesCache.push(String(u).trim());
                });
              }
            })
            .catch(() => {});
        Promise.all([
          tryUrl("/follow/followers.json"),
          tryUrl("/u/" + encodeURIComponent(currentUserUsername || "me") + "/followers.json"),
        ]).then(() => {
          if (cb) cb();
        });
      }

      function showSuggestions(filter) {
        const q = (filter || "").toLowerCase().trim();
        const all = getSuggestionsUsernameList();
        const matched = q
          ? all.filter((u) => u.toLowerCase().startsWith(q) || u.toLowerCase().includes(q))
          : all;
        const max = 10;
        const slice = matched.slice(0, max);
        if (!suggestionsEl) return;
        if (!slice.length) {
          suggestionsEl.innerHTML = "";
          suggestionsEl.setAttribute("aria-hidden", "true");
          suggestionsEl.style.display = "none";
          return;
        }
        suggestionsEl.innerHTML = slice
          .map(
            (username) =>
              `<div class="diskuz-call-suggestion-item" role="option" data-username="${(username || "").replace(/"/g, "&quot;")}">${(username || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`
          )
          .join("");
        suggestionsEl.setAttribute("aria-hidden", "false");
        suggestionsEl.style.display = "block";
        suggestionsEl.querySelectorAll(".diskuz-call-suggestion-item").forEach((el) => {
          el.addEventListener("click", function () {
            const u = this.getAttribute("data-username");
            if (u) {
              input.value = u;
              input.focus();
              suggestionsEl.style.display = "none";
              suggestionsEl.setAttribute("aria-hidden", "true");
            }
          });
        });
      }

      function hideSuggestions() {
        if (suggestionsEl) {
          suggestionsEl.style.display = "none";
          suggestionsEl.setAttribute("aria-hidden", "true");
        }
      }

      if (input && suggestionsEl) {
        input.addEventListener("focus", function () {
          loadFollowerUsernamesIfNeeded(() => {
            showSuggestions(input.value);
          });
        });
        input.addEventListener("input", function () {
          showSuggestions(input.value);
        });
        input.addEventListener("keydown", function (e) {
          if (e.key === "Escape") {
            hideSuggestions();
            input.blur();
          }
        });
        input.addEventListener("blur", function () {
          setTimeout(hideSuggestions, 180);
        });
      }

      const availableBtn = widget.querySelector("#diskuz-status-available");
      const busyBtn = widget.querySelector("#diskuz-status-busy");
      const notAvailBtn = widget.querySelector("#diskuz-status-not-available");

      startBtn.addEventListener("click", async () => {
        unlockAudioForIncomingSound();
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
            const isSelf = (username || "").toLowerCase().trim() === (currentUserUsername || "");
            showError(isSelf ? (document.documentElement.lang === "it" ? "Non puoi chiamare te stesso." : "You cannot call yourself.") : "User not found.");
            return;
          }
          const userId = data.user.id;
          if (userId != null && userId === currentUserId) {
            showError(document.documentElement.lang === "it" ? "Non puoi chiamare te stesso." : "You cannot call yourself.");
            return;
          }
          const now = Date.now();
          const recentToUser = callRateLimitEntries.filter((e) => e.userId === userId && e.at > now - CALL_RATE_LIMIT_WINDOW_MS);
          if (recentToUser.length >= CALL_RATE_LIMIT_MAX_PER_USER) {
            showError(document.documentElement.lang === "it" ? "Rallenta: puoi avviare al massimo 2 chiamate allo stesso utente al minuto." : "Slow down. You can only place 2 calls to this user per minute.");
            return;
          }
          log("Starting call to", username, "userId", userId);
          startOutgoingCall(username, userId, data.user.avatar_template);
          callRateLimitEntries.push({ userId, at: now });
          callRateLimitEntries = callRateLimitEntries.filter((e) => e.at > now - CALL_RATE_LIMIT_WINDOW_MS);
          toggleWidgetForceClose();
        } catch (e) {
          if (e.message === "RATE_LIMIT") {
            showError("Too many requests. Please wait a moment and try again.");
          } else {
            showError("Connection error.");
          }
        }
      });

      let widgetErrorTimeoutId = null;
      function showError(msg) {
        if (widgetErrorTimeoutId) clearTimeout(widgetErrorTimeoutId);
        errorBox.textContent = msg;
        errorBox.style.display = "block";
        widget.classList.add("shake");
        setTimeout(function () { widget.classList.remove("shake"); }, 400);
        widgetErrorTimeoutId = setTimeout(function () {
          errorBox.style.display = "none";
          errorBox.textContent = "";
          widgetErrorTimeoutId = null;
        }, 5000);
      }

      historyBtn.addEventListener("click", function () {
        openWidgetToNotificationsPage();
      });

      widget.querySelectorAll(".diskuz-widget-hide-btn").forEach(function (hideBtn) {
        hideBtn.addEventListener("click", function () {
          toggleWidgetForceClose();
        });
      });

      const notifHomeBtn = widget.querySelector("#diskuz-widget-notifications-home-btn");
      if (notifHomeBtn) {
        notifHomeBtn.addEventListener("click", function () {
          showWidgetPage(WIDGET_PAGE_HOME);
        });
      }

      widget.querySelectorAll(".diskuz-widget-page-notifications .diskuz-ntab").forEach((t) => {
        t.addEventListener("click", function () {
          const tab = this.getAttribute("data-tab");
          if (!tab) return;
          notificationsTab = tab;
          widget.querySelectorAll(".diskuz-widget-page-notifications .diskuz-ntab").forEach((b) => b.classList.remove("active"));
          this.classList.add("active");
          renderHistoryList();
        });
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
          let dragStartX = 0, dragStartY = 0, dragStartLeft = 0, dragStartTop = 0, dragW = 320, dragH = 440;
          function onDragMove(e) {
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            const W = window.innerWidth;
            const H = window.innerHeight;
            const newLeft = Math.max(0, Math.min(W - dragW, dragStartLeft + dx));
            const newTop = Math.max(0, Math.min(H - dragH, dragStartTop + dy));
            callUI.style.left = newLeft + "px";
            callUI.style.top = newTop + "px";
          }
          function onDragEnd() {
            document.removeEventListener("mousemove", onDragMove);
            document.removeEventListener("mouseup", onDragEnd);
            captureCallUIRect();
          }
          topBar.addEventListener("mousedown", function (e) {
            e.preventDefault();
            const rect = callUI.getBoundingClientRect();
            dragW = rect.width;
            dragH = rect.height;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const left = parseInt(callUI.style.left, 10);
            const top = parseInt(callUI.style.top, 10);
            dragStartLeft = isNaN(left) ? (window.innerWidth - Math.min(340, dragW)) : left;
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
      applyWidgetRectToCallUI();
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
  let outgoingCallTimeoutId = null;
  let calleeNotRingingTimeoutId = null;
  const OUTGOING_CALL_TIMEOUT_MS = 30000;
  const CALLEE_NOT_RINGING_MS = 5000;

  function clearOutgoingCallTimeout() {
    if (outgoingCallTimeoutId) {
      clearTimeout(outgoingCallTimeoutId);
      outgoingCallTimeoutId = null;
    }
    if (calleeNotRingingTimeoutId) {
      clearTimeout(calleeNotRingingTimeoutId);
      calleeNotRingingTimeoutId = null;
    }
  }

  function startCalleeNotRingingTimeout() {
    if (calleeNotRingingTimeoutId) clearTimeout(calleeNotRingingTimeoutId);
    calleeNotRingingTimeoutId = setTimeout(() => {
      if (!currentCall.active || currentCall.direction !== "outgoing" || currentCall.isRinging !== true) return;
      calleeNotRingingTimeoutId = null;
      clearOutgoingCallTimeout();
      const msg = document.documentElement.lang === "it" ? "L'utente chiamato non è disponibile." : "The user you're calling is not available.";
      playBusyTone();
      setCallUIStatusMessage(msg);
      showToast(msg);
      endCurrentCall("not_available");
    }, CALLEE_NOT_RINGING_MS);
  }

  function startOutgoingCallTimeout() {
    clearOutgoingCallTimeout();
    startCalleeNotRingingTimeout();
    outgoingCallTimeoutId = setTimeout(() => {
      if (!currentCall.active || currentCall.direction !== "outgoing" || currentCall.isRinging !== true) return;
      clearOutgoingCallTimeout();
      playBusyTone();
      setCallUIStatusMessage(MSG_CALL_UNAVAILABLE);
      showToast(MSG_CALL_UNAVAILABLE);
      endCurrentCall("no_answer");
    }, OUTGOING_CALL_TIMEOUT_MS);
  }

  function setCallUIStatusMessage(msg) {
    const statusEl = callUI && callUI.querySelector(".status");
    if (statusEl) statusEl.textContent = msg || "";
  }

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
      endCurrentCall("rejected");
      showWidgetErrorFromCall(MSG_CALL_UNAVAILABLE);
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
          () => {
            log("[CALLER] rtcMakeOffer: call_offer sent OK");
            startOutgoingCallTimeout();
          },
          (err) => {
            const reason = getSignalErrorReason(err);
            log("[CALLER] rtcMakeOffer: call_offer send FAIL", err, "reason:", reason);
            const msg = messageForSignalReason(reason, currentCall.username);
            clearOutgoingCallTimeout();
            endCurrentCall("rejected");
            showWidgetErrorFromCall(msg);
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
    clearOutgoingCallTimeout();
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

    captureWidgetRect();
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
    startIncomingRingLoop();
    showBrowserNotification(data.from_username || "Someone");
    showIncomingCallUI(data.from_username, data.avatar_template);
    if (window.DiskuzCallSend && data.from_user_id) {
      window.DiskuzCallSend({ type: "call_ringing", to_user_id: data.from_user_id });
    }
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
    acceptBtn.style.padding = "10px 14px";
    acceptBtn.style.borderRadius = "15px";
    acceptBtn.style.color = "#fff";
    acceptBtn.style.cursor = "pointer";
    acceptBtn.style.fontSize = "14px";

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "diskuz-reject-btn";
    rejectBtn.textContent = "Reject";
    rejectBtn.style.flex = "1";
    rejectBtn.style.padding = "10px 14px";
    rejectBtn.style.borderRadius = "15px";
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
      applyWidgetRectToCallUI();
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
    stopIncomingRing();
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

    stopIncomingRing();
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

      case "call_ringing":
        if (
          currentCall.active &&
          currentCall.direction === "outgoing" &&
          currentCall.userId === data.from_user_id &&
          calleeNotRingingTimeoutId
        ) {
          clearTimeout(calleeNotRingingTimeoutId);
          calleeNotRingingTimeoutId = null;
        }
        break;

      case "call_answer":
        if (
          currentCall.active &&
          currentCall.direction === "outgoing" &&
          currentCall.userId === data.from_user_id
        ) {
          clearOutgoingCallTimeout();
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
          clearOutgoingCallTimeout();
          playBusyTone();
          const reason = data.reason || "rejected";
          const rejectMsg =
            reason === "busy"
              ? (document.documentElement.lang === "it" ? "Utente occupato." : "User is busy.")
              : reason === "not_available"
              ? MSG_CALL_UNAVAILABLE
              : (document.documentElement.lang === "it" ? "Chiamata rifiutata." : "Call rejected.");
          setCallUIStatusMessage(rejectMsg);
          addHistoryEntry({
            direction: "outgoing",
            result: reason,
            username: currentCall.username || "Unknown",
          });
          showToast(rejectMsg);
          setTimeout(() => {
            rtcEnd();
            resetCurrentCall();
            closeCallUI();
          }, 1500);
        }
        break;

      case "call_end":
        if (currentCall.active && currentCall.userId === data.from_user_id) {
          if (currentCall.direction === "incoming") stopIncomingRing();
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
      showWidgetPage(WIDGET_PAGE_HOME);
      applyLastRectToWidget();
      widget.style.display = "block";
      setTimeout(function () {
        widget.classList.add("open");
        setTimeout(captureWidgetRect, 50);
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
      currentUserId = null;
      currentUserUsername = null;
      return;
    }
    currentUserId = currentUser.id;
    currentUserUsername = (currentUser.username || "").toLowerCase();

    ajax("/diskuz-call/status")
      .then((data) => {
        if (data.enabled !== true) {
          log("initPage: user not in allowed groups, plugin not loaded");
          return;
        }
        window.DiskuzCallIncomingSound = (data.incoming_sound != null && String(data.incoming_sound).trim() !== "") ? String(data.incoming_sound).trim() : "default";
        window.DiskuzCallCustomRingtoneUrl = (data.custom_ringtone_url != null && data.custom_ringtone_url !== "") ? String(data.custom_ringtone_url).trim() : "";
        window.DiskuzCallAlternativeRingtone = (data.alternative_ringtone != null && String(data.alternative_ringtone).trim() !== "") ? String(data.alternative_ringtone).trim() : "classic";
        if (Array.isArray(data.ice_servers) && data.ice_servers.length > 0) window.DiskuzCallIceServers = data.ice_servers;
        subscribeMessageBus();
        loadHistory();
        try {
          const savedStatus = window.localStorage.getItem(STATUS_KEY);
          if (savedStatus === "busy" || savedStatus === "not_available" || savedStatus === "available") callStatus = savedStatus;
        } catch (e) {}
        createFloatingButton();
        createWidget();
        loadWidgetRectFromStorage();
        updateNotificationsBadge();
        updateCallFeatureVisibility();
        onceDocumentInteractionForAudio();
      })
      .catch(() => {
        log("initPage: status check failed, plugin not loaded");
      });
  }

  api.onPageChange(initPage);
  initPage();
});
