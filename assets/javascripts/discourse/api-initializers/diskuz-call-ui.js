import { apiInitializer } from "discourse/lib/api";
import { withPluginApi } from "discourse/lib/plugin-api";
import { ajax } from "discourse/lib/ajax";
import MessageBus from "message-bus-client";

/* Log e warn/error diskuz-call: attivi solo se Admin ha abilitato "Log di debug" in Impostazioni plugin oppure localStorage diskuz_call_debug === "1". */
function diskuzCallDebugEnabled() {
  try {
    return window.DiskuzCallDebugLog === true || window.localStorage.getItem("diskuz_call_debug") === "1";
  } catch (e) {
    return false;
  }
}
function log(...args) {
  if (diskuzCallDebugEnabled()) console.log("[diskuz-call]", ...args);
}
function logWarn(...args) {
  if (diskuzCallDebugEnabled()) console.warn("[diskuz-call]", ...args);
}
function logError(...args) {
  if (diskuzCallDebugEnabled()) console.error("[diskuz-call]", ...args);
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

  /** True se la connessione sta effettivamente usando un candidato relay (TURN). Verifica in tempo reale via getStats(), nessun dato salvato. */
  async function isConnectionUsingRelay(peer) {
    if (!peer) return false;
    try {
      const report = await peer.getStats();
      for (const stat of report.values()) {
        if (stat.type !== "candidate-pair") continue;
        if (stat.state !== "succeeded") continue;
        const localId = stat.localCandidateId;
        const remoteId = stat.remoteCandidateId;
        if (localId) {
          const local = report.get(localId);
          if (local && local.candidateType === "relay") return true;
        }
        if (remoteId) {
          const remote = report.get(remoteId);
          if (remote && remote.candidateType === "relay") return true;
        }
      }
    } catch (e) {}
    return false;
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
  let widgetWasOpenBeforeCall = false;
  const WIDGET_RECT_STORAGE_KEY = "diskuz_call_widget_rect";
  /* Dimensioni minime widget/call UI su desktop: evitano che si salvi/ripristini un rect ristretto per errore */
  const WIDGET_MIN_WIDTH = 360;
  const WIDGET_MIN_HEIGHT = 560;
  /* Limite massimo: se per errore si salva un widget larghissimo, non ripristinarlo (evita di dover cancellare la cache) */
  const WIDGET_MAX_WIDTH = 520;
  const WIDGET_MAX_HEIGHT = 900;

  /* Default position/size: un po' più largo e alto per evitare scrollbar su desktop */
  function getDefaultWidgetRect() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const width = WIDGET_MIN_WIDTH;
    const height = WIDGET_MIN_HEIGHT;
    return clampRectToViewport({
      left: W - 178 - width,
      top: H - 190 - height,
      width: width,
      height: height,
    });
  }

  /** Su desktop impone min/max width/height così non si salva/ripristina un widget schiacciato o larghissimo. */
  function clampWidgetRectToMinimum(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return rect;
    if (isMobileDevice()) return rect;
    const H = typeof window !== "undefined" ? window.innerHeight : 768;
    const maxH = Math.min(WIDGET_MAX_HEIGHT, Math.floor(H * 0.9));
    return {
      left: rect.left,
      top: rect.top,
      width: Math.max(WIDGET_MIN_WIDTH, Math.min(rect.width, WIDGET_MAX_WIDTH)),
      height: Math.max(WIDGET_MIN_HEIGHT, Math.min(rect.height, maxH)),
    };
  }

  function clampRectToViewport(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return rect;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let { left, top, width, height } = rect;
    left = Math.max(0, Math.min(left, W - 1));
    top = Math.max(0, Math.min(top, H - 1));
    width = Math.min(width, W - left);
    height = Math.min(height, H - top);
    if (width <= 0 || height <= 0) return rect;
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
      if (!o || typeof o.left !== "number" || typeof o.top !== "number" || o.width <= 0 || o.height <= 0) return;
      /* Scarta rect irragionevoli (es. larghissimo per bug): evita di dover cancellare la cache */
      const H = window.innerHeight || 768;
      const maxH = Math.min(WIDGET_MAX_HEIGHT, Math.floor(H * 0.9));
      if (o.width > WIDGET_MAX_WIDTH || o.height > maxH) return;
      const loaded = { left: o.left, top: o.top, width: o.width, height: o.height };
      lastWidgetRect = clampRectToViewport(clampWidgetRectToMinimum(loaded));
      saveWidgetRectToStorage();
    } catch (e) { /* ignore */ }
  }

  function captureWidgetRect() {
    if (!widget || isMobileDevice()) return;
    const rect = widget.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      lastWidgetRect = clampWidgetRectToMinimum({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      saveWidgetRectToStorage();
    }
  }

  function captureCallUIRect() {
    if (!callUI || isMobileDevice()) return;
    const rect = callUI.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      lastWidgetRect = clampWidgetRectToMinimum({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      saveWidgetRectToStorage();
    }
  }

  function applyLastRectToWidget() {
    if (!widget || isMobileDevice()) return;
    if (!lastWidgetRect || lastWidgetRect.width <= 0) {
      loadWidgetRectFromStorage();
      if (!lastWidgetRect || lastWidgetRect.width <= 0) {
        lastWidgetRect = getDefaultWidgetRect();
        saveWidgetRectToStorage();
      }
    }
    const rect = clampRectToViewport(clampWidgetRectToMinimum(lastWidgetRect));
    widget.style.setProperty("position", "fixed", "important");
    widget.style.setProperty("left", rect.left + "px", "important");
    widget.style.setProperty("top", rect.top + "px", "important");
    widget.style.setProperty("width", rect.width + "px", "important");
    widget.style.setProperty("height", rect.height + "px", "important");
    widget.style.setProperty("right", "auto", "important");
    widget.style.setProperty("bottom", "auto", "important");
  }

  function applyWidgetRectToCallUI() {
    if (!callUI || isMobileDevice()) return;
    if (!lastWidgetRect || lastWidgetRect.width <= 0) {
      loadWidgetRectFromStorage();
      if (!lastWidgetRect || lastWidgetRect.width <= 0) {
        lastWidgetRect = getDefaultWidgetRect();
        saveWidgetRectToStorage();
      }
    }
    const rect = clampRectToViewport(clampWidgetRectToMinimum(lastWidgetRect));
    callUI.style.setProperty("position", "fixed", "important");
    callUI.style.setProperty("left", rect.left + "px", "important");
    callUI.style.setProperty("top", rect.top + "px", "important");
    callUI.style.setProperty("width", rect.width + "px", "important");
    callUI.style.setProperty("height", rect.height + "px", "important");
    callUI.style.setProperty("right", "auto", "important");
    callUI.style.setProperty("bottom", "auto", "important");
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
        /* Rilancia errore di rete così il chiamante può mostrare "Errore di rete" invece di "User not found" */
        if (e.message === "Failed to fetch" || e.name === "TypeError") throw e;
        return null;
      });
  }
  const MSG_CALL_UNAVAILABLE =
    document.documentElement.lang === "it"
      ? "Utente non disponibile o non collegato."
      : "User not available or not connected.";

  function getSignalErrorReason(err) {
    if (!err) return null;
    const jq = err.jqXHR || err;
    if (jq.status === 429) {
      const code = (jq.responseText || "").match(/Error code:\s*(\S+)/);
      return (code && code[1]) || "user_10_secs_limit";
    }
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
      case "user_10_secs_limit":
        return it
          ? "Troppi tentativi. Attendi qualche secondo e riprova."
          : "Too many requests. Wait a few seconds and try again.";
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
        logWarn("could not create AudioContext", e);
        return Promise.resolve();
      }
    }
    if (incomingCallAudioContext.state === "suspended") {
      return incomingCallAudioContext.resume().catch((e) => {
        logWarn("AudioContext resume failed", e);
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
      logWarn("fallback beep failed", e);
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
        logWarn("could not play custom ringtone", e);
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
      logWarn("ring tone failed", e);
      throw e;
    }
  }

  /* Suonerie alternative: tutte movimentate e ricche; + 5 Relaz (rilassanti). */
  function playAlternativeRingtonePreset(ctx, preset) {
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const vol = 0.28;
    const volSoft = 0.18;
    const tone = (freq, start, dur, v) => {
      const o = ctx.createOscillator();
      o.connect(g);
      o.frequency.value = freq;
      o.type = "sine";
      const vv = v != null ? v : vol;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(vv, start + 0.02);
      g.gain.setValueAtTime(vv, start + dur - 0.02);
      g.gain.linearRampToValueAtTime(0, start + dur);
      o.start(start);
      o.stop(start + dur);
    };
    try {
      switch (preset) {
        case "modern":
          tone(880, t0, 0.12);
          tone(1109, t0 + 0.18, 0.12);
          tone(880, t0 + 0.36, 0.12);
          tone(1109, t0 + 0.52, 0.12);
          tone(1319, t0 + 0.68, 0.2);
          break;
        case "soft":
          tone(523, t0, 0.2);
          tone(659, t0 + 0.28, 0.2);
          tone(784, t0 + 0.52, 0.25);
          tone(659, t0 + 0.82, 0.2);
          tone(523, t0 + 1.06, 0.3);
          break;
        case "double":
          tone(523, t0, 0.2);
          tone(659, t0 + 0.28, 0.2);
          tone(523, t0 + 0.56, 0.15);
          tone(784, t0 + 0.78, 0.22);
          tone(659, t0 + 1.06, 0.2);
          tone(784, t0 + 1.32, 0.25);
          break;
        case "melodic":
          tone(523, t0, 0.16);
          tone(659, t0 + 0.24, 0.16);
          tone(784, t0 + 0.48, 0.16);
          tone(1047, t0 + 0.72, 0.2);
          tone(784, t0 + 0.98, 0.14);
          tone(1047, t0 + 1.18, 0.18);
          tone(1319, t0 + 1.42, 0.28);
          break;
        case "retro":
          tone(880, t0, 0.1);
          tone(988, t0 + 0.16, 0.1);
          tone(1175, t0 + 0.32, 0.1);
          tone(1319, t0 + 0.48, 0.14);
          tone(1175, t0 + 0.68, 0.1);
          tone(1319, t0 + 0.84, 0.12);
          tone(1568, t0 + 1.02, 0.2);
          tone(1175, t0 + 1.28, 0.12);
          tone(988, t0 + 1.46, 0.25);
          break;
        case "digital":
          tone(622, t0, 0.06);
          tone(622, t0 + 0.14, 0.06);
          tone(784, t0 + 0.24, 0.08);
          tone(622, t0 + 0.36, 0.06);
          tone(784, t0 + 0.46, 0.08);
          tone(1047, t0 + 0.58, 0.1);
          tone(784, t0 + 0.74, 0.08);
          tone(1047, t0 + 0.88, 0.12);
          tone(1319, t0 + 1.06, 0.22);
          break;
        case "pulse":
          tone(659, t0, 0.12);
          tone(523, t0 + 0.22, 0.12);
          tone(659, t0 + 0.42, 0.12);
          tone(784, t0 + 0.58, 0.12);
          tone(659, t0 + 0.78, 0.12);
          tone(523, t0 + 0.98, 0.12);
          tone(659, t0 + 1.18, 0.14);
          tone(784, t0 + 1.38, 0.28);
          break;
        case "star":
          tone(523, t0, 0.1);
          tone(659, t0 + 0.16, 0.1);
          tone(784, t0 + 0.32, 0.1);
          tone(1047, t0 + 0.48, 0.1);
          tone(1319, t0 + 0.64, 0.18);
          tone(1047, t0 + 0.88, 0.1);
          tone(1319, t0 + 1.04, 0.12);
          tone(1568, t0 + 1.22, 0.12);
          tone(1319, t0 + 1.4, 0.28);
          break;
        case "cascade":
          tone(1047, t0, 0.08);
          tone(988, t0 + 0.12, 0.08);
          tone(880, t0 + 0.24, 0.08);
          tone(784, t0 + 0.36, 0.08);
          tone(659, t0 + 0.48, 0.12);
          tone(784, t0 + 0.66, 0.08);
          tone(880, t0 + 0.78, 0.08);
          tone(988, t0 + 0.9, 0.08);
          tone(1047, t0 + 1.02, 0.1);
          tone(1175, t0 + 1.16, 0.22);
          break;
        case "festivo":
          tone(523, t0, 0.1);
          tone(659, t0 + 0.14, 0.1);
          tone(784, t0 + 0.28, 0.1);
          tone(1047, t0 + 0.42, 0.12);
          tone(784, t0 + 0.6, 0.1);
          tone(1047, t0 + 0.74, 0.12);
          tone(1319, t0 + 0.92, 0.18);
          tone(1047, t0 + 1.16, 0.12);
          tone(1319, t0 + 1.36, 0.28);
          break;
        case "allegro":
          tone(880, t0, 0.08);
          tone(1109, t0 + 0.14, 0.08);
          tone(1319, t0 + 0.26, 0.1);
          tone(1109, t0 + 0.42, 0.08);
          tone(1319, t0 + 0.56, 0.1);
          tone(1568, t0 + 0.72, 0.14);
          tone(1319, t0 + 0.92, 0.1);
          tone(1568, t0 + 1.08, 0.24);
          break;
        case "vivace":
          tone(659, t0, 0.08);
          tone(784, t0 + 0.12, 0.08);
          tone(988, t0 + 0.24, 0.08);
          tone(784, t0 + 0.36, 0.08);
          tone(988, t0 + 0.48, 0.1);
          tone(1175, t0 + 0.62, 0.1);
          tone(988, t0 + 0.78, 0.08);
          tone(1175, t0 + 0.9, 0.12);
          tone(1319, t0 + 1.08, 0.22);
          break;
        case "brillante":
          tone(1047, t0, 0.08);
          tone(1319, t0 + 0.14, 0.08);
          tone(1568, t0 + 0.28, 0.1);
          tone(1319, t0 + 0.44, 0.08);
          tone(1568, t0 + 0.58, 0.1);
          tone(2093, t0 + 0.74, 0.12);
          tone(1568, t0 + 0.92, 0.1);
          tone(2093, t0 + 1.08, 0.26);
          break;
        case "energico":
          tone(523, t0, 0.1);
          tone(659, t0 + 0.12, 0.1);
          tone(523, t0 + 0.28, 0.08);
          tone(784, t0 + 0.4, 0.1);
          tone(659, t0 + 0.56, 0.08);
          tone(784, t0 + 0.68, 0.1);
          tone(1047, t0 + 0.84, 0.12);
          tone(784, t0 + 1.02, 0.1);
          tone(1047, t0 + 1.18, 0.28);
          break;
        case "dinamico":
          tone(622, t0, 0.08);
          tone(784, t0 + 0.16, 0.08);
          tone(988, t0 + 0.3, 0.1);
          tone(784, t0 + 0.46, 0.08);
          tone(988, t0 + 0.6, 0.1);
          tone(1245, t0 + 0.76, 0.1);
          tone(988, t0 + 0.92, 0.08);
          tone(1245, t0 + 1.06, 0.12);
          tone(1480, t0 + 1.24, 0.26);
          break;
        case "scintilla":
          tone(1319, t0, 0.06);
          tone(1568, t0 + 0.1, 0.06);
          tone(2093, t0 + 0.2, 0.08);
          tone(1568, t0 + 0.34, 0.06);
          tone(2093, t0 + 0.44, 0.08);
          tone(2637, t0 + 0.58, 0.1);
          tone(2093, t0 + 0.74, 0.08);
          tone(2637, t0 + 0.88, 0.24);
          break;
        case "campanella":
          tone(784, t0, 0.12);
          tone(1047, t0 + 0.2, 0.12);
          tone(1319, t0 + 0.36, 0.12);
          tone(1047, t0 + 0.52, 0.1);
          tone(1319, t0 + 0.68, 0.12);
          tone(1568, t0 + 0.84, 0.14);
          tone(1319, t0 + 1.04, 0.12);
          tone(1568, t0 + 1.2, 0.28);
          break;
        case "trillo":
          tone(880, t0, 0.06);
          tone(988, t0 + 0.1, 0.06);
          tone(880, t0 + 0.18, 0.06);
          tone(988, t0 + 0.24, 0.06);
          tone(880, t0 + 0.32, 0.06);
          tone(1175, t0 + 0.4, 0.1);
          tone(988, t0 + 0.56, 0.06);
          tone(1175, t0 + 0.64, 0.1);
          tone(1319, t0 + 0.8, 0.22);
          break;
        case "marimba":
          tone(523, t0, 0.14);
          tone(659, t0 + 0.22, 0.14);
          tone(784, t0 + 0.4, 0.14);
          tone(523, t0 + 0.58, 0.1);
          tone(784, t0 + 0.72, 0.14);
          tone(988, t0 + 0.9, 0.16);
          tone(659, t0 + 1.12, 0.12);
          tone(988, t0 + 1.28, 0.28);
          break;
        case "relax1":
          tone(392, t0, 0.4, volSoft);
          tone(494, t0 + 0.6, 0.4, volSoft);
          tone(587, t0 + 1.1, 0.5, volSoft);
          break;
        case "relax2":
          tone(440, t0, 0.35, volSoft);
          tone(554, t0 + 0.55, 0.35, volSoft);
          tone(440, t0 + 1.0, 0.3, volSoft);
          tone(659, t0 + 1.4, 0.45, volSoft);
          break;
        case "relax3":
          tone(523, t0, 0.3, volSoft);
          tone(659, t0 + 0.5, 0.35, volSoft);
          tone(523, t0 + 0.95, 0.3, volSoft);
          tone(784, t0 + 1.35, 0.5, volSoft);
          break;
        case "relax4":
          tone(494, t0, 0.38, volSoft);
          tone(587, t0 + 0.6, 0.38, volSoft);
          tone(698, t0 + 1.08, 0.4, volSoft);
          tone(587, t0 + 1.58, 0.45, volSoft);
          break;
        case "relax5":
          tone(349, t0, 0.45, volSoft);
          tone(440, t0 + 0.7, 0.45, volSoft);
          tone(523, t0 + 1.2, 0.5, volSoft);
          tone(440, t0 + 1.8, 0.55, volSoft);
          break;
        case "classic":
        default:
          playIncomingCallBeep(ctx);
          return;
      }
    } catch (e) {
      logWarn("alternative preset failed", e);
      playIncomingCallBeep(ctx);
    }
  }

  const INCOMING_RING_INTERVAL_MS = 2500;
  const INCOMING_RING_MAX_MS = 48000;
  let incomingRingIntervalId = null;
  let incomingRingTimeoutId = null;
  let currentRingingAudio = null;
  let incomingRingStartTime = 0;

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
    const alternativePreset = (typeof window.DiskuzCallAlternativeRingtone !== "undefined" && window.DiskuzCallAlternativeRingtone) ? String(window.DiskuzCallAlternativeRingtone) : "soft";
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
        audio.addEventListener("ended", function onEnded() {
          if (!currentCall.active || currentCall.direction !== "incoming" || !currentCall.isRinging) return;
          const elapsed = Date.now() - incomingRingStartTime;
          if (elapsed < INCOMING_RING_MAX_MS) {
            currentRingingAudio = null;
            playIncomingCallRingOnce();
          }
        }, { once: true });
        audio.addEventListener("error", function onErr() {
          currentRingingAudio = null;
          playIncomingCallSound();
        }, { once: true });
        audio.src = url;
        currentRingingAudio = audio;
      } catch (e) {
        logWarn("could not play custom ringtone", e);
        playIncomingCallSound();
      }
      return;
    }
    playIncomingCallSound();
  }

  function startIncomingRingLoop() {
    stopIncomingRing();
    incomingRingStartTime = Date.now();
    const sound = (typeof window.DiskuzCallIncomingSound !== "undefined" && window.DiskuzCallIncomingSound) ? window.DiskuzCallIncomingSound : "default";
    const customUrl = (typeof window.DiskuzCallCustomRingtoneUrl !== "undefined" && window.DiskuzCallCustomRingtoneUrl) ? String(window.DiskuzCallCustomRingtoneUrl).trim() : "";
    const isCustom = sound === "custom" && customUrl;
    if (isCustom) {
      playIncomingCallRingOnce();
    } else {
      ensureAudioContextRunning().then(() => {
        playIncomingCallRingOnce();
      }).catch(() => {});
      incomingRingIntervalId = setInterval(playIncomingCallRingOnce, INCOMING_RING_INTERVAL_MS);
    }
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

  /* Tono di libero (ringback): si sente subito quando si preme Call, fino a risposta/rifiuto/fine */
  const RINGBACK_INTERVAL_MS = 2500;
  let outgoingRingbackIntervalId = null;

  function stopOutgoingRingback() {
    if (outgoingRingbackIntervalId) {
      clearInterval(outgoingRingbackIntervalId);
      outgoingRingbackIntervalId = null;
    }
  }

  function playRingbackToneOnce(ctx) {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const vol = 0.25;
    const len = 0.4;
    const gap = 0.2;
    [0, len + gap].forEach((off) => {
      const o = ctx.createOscillator();
      o.connect(g);
      o.frequency.value = 440;
      o.type = "sine";
      g.gain.setValueAtTime(0, t0 + off);
      g.gain.linearRampToValueAtTime(vol, t0 + off + 0.02);
      g.gain.setValueAtTime(vol, t0 + off + len - 0.02);
      g.gain.linearRampToValueAtTime(0, t0 + off + len);
      o.start(t0 + off);
      o.stop(t0 + off + len);
    });
  }

  function startOutgoingRingback() {
    stopOutgoingRingback();
    ensureAudioContextRunning().then(() => {
      const ctx = incomingCallAudioContext;
      if (!ctx) return;
      const playOnce = () => {
        if (!currentCall.active || currentCall.direction !== "outgoing" || !currentCall.isRinging) {
          stopOutgoingRingback();
          return;
        }
        try {
          if (ctx.state === "suspended") ctx.resume().then(() => playRingbackToneOnce(ctx));
          else playRingbackToneOnce(ctx);
        } catch (e) { /* ignore */ }
      };
      playOnce();
      outgoingRingbackIntervalId = setInterval(playOnce, RINGBACK_INTERVAL_MS);
    }).catch(() => {});
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
      logWarn("busy beeps failed", e);
      throw e;
    }
  }

  /* --- BROWSER NOTIFICATION (when user has allowed notifications) --- */
  /* L'utente ha 10 secondi per cliccare sulla notifica o aprire diskuz; una volta sulla pagina ha 48 secondi (INCOMING_RING_MAX_MS) per rispondere. Per ricevere notifiche a tab chiuso serve Web Push (server + service worker). */
  const NOTIFICATION_VISIBLE_MS = 10000;
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
      setTimeout(() => n.close(), NOTIFICATION_VISIBLE_MS);
    } catch (e) {
      logWarn("browser notification failed", e);
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

  function showSpeakerMobileVolumePopup() {
    const isIt = document.documentElement.lang === "it";
    const message = isIt
      ? "Per regolare il volume della chiamata usa i tasti volume del telefono."
      : "To adjust call volume, use your phone's volume keys.";
    const pop = document.createElement("div");
    pop.className = "diskuz-call-speaker-mobile-popup";
    pop.textContent = message;
    pop.style.position = "fixed";
    pop.style.left = "50%";
    pop.style.bottom = "20px";
    pop.style.transform = "translateX(-50%) translateY(10px)";
    pop.style.zIndex = "100002";
    pop.style.background = "rgba(15,23,42,0.95)";
    pop.style.color = "#fff";
    pop.style.padding = "12px 16px";
    pop.style.borderRadius = "15px";
    pop.style.fontSize = "14px";
    pop.style.boxShadow = "0 4px 16px rgba(0,0,0,0.35)";
    pop.style.opacity = "0";
    pop.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    pop.style.maxWidth = "min(320px, calc(100vw - 32px))";
    document.body.appendChild(pop);
    requestAnimationFrame(() => {
      pop.style.opacity = "1";
      pop.style.transform = "translateX(-50%) translateY(0)";
    });
    setTimeout(() => {
      pop.style.opacity = "0";
      pop.style.transform = "translateX(-50%) translateY(10px)";
      setTimeout(() => pop.remove(), 200);
    }, 5000);
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
    const btn = document.getElementById("diskuz-call-history-btn");
    if (badge) {
      if (count > 0) {
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.style.display = "";
      } else {
        badge.style.display = "none";
      }
    }
    if (btn) {
      if (count > 0) btn.classList.add("diskuz-notifications-has-unread");
      else btn.classList.remove("diskuz-notifications-has-unread");
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

    const lang = (document.documentElement && document.documentElement.lang || "").toLowerCase();
    const isIt = lang === "it" || lang.startsWith("it-");
    const emptyMsg = isIt ? "Nessuna chiamata." : "No calls yet.";
    const durationLabel = isIt ? "Durata" : "Duration";
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

    items = items.slice(0, 10);

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
          metaParts.push(durationLabel + " " + durationStr);
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

  let previewRingtoneAudio = null;
  const PREVIEW_MAX_MS = 12000;

  function stopAllRingtonePreviews() {
    if (previewRingtoneAudio) {
      try {
        previewRingtoneAudio.pause();
        previewRingtoneAudio.currentTime = 0;
      } catch (e) {}
      previewRingtoneAudio = null;
    }
  }

  function updateCustomRingtonesUI(ringtones, selectedIndex) {
    const wrap = widget ? widget.querySelector("#diskuz-call-custom-ringtones-wrap") : null;
    if (!wrap || !Array.isArray(ringtones) || ringtones.length === 0) return;
    const isIt = document.documentElement.lang === "it";
    wrap.innerHTML = "";
    const title = document.createElement("div");
    title.className = "diskuz-custom-ringtones-title";
    title.textContent = isIt ? "Suonerie" : "Ringtones";
    wrap.appendChild(title);
    const list = document.createElement("div");
    list.className = "diskuz-custom-ringtones-list";
    ringtones.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "diskuz-custom-ringtones-row" + (selectedIndex === r.index ? " selected" : "");
      row.innerHTML = `
        <span class="diskuz-custom-ringtones-label">${(r.label || ("#" + (r.index + 1))).replace(/</g, "&lt;")}</span>
        <button type="button" class="diskuz-custom-ringtones-preview-btn">${isIt ? "Anteprima" : "Preview"}</button>
        <button type="button" class="diskuz-custom-ringtones-select-btn">${isIt ? "Seleziona" : "Select"}</button>
      `;
      const previewBtn = row.querySelector(".diskuz-custom-ringtones-preview-btn");
      const selectBtn = row.querySelector(".diskuz-custom-ringtones-select-btn");
      let url = (r.url || "").trim();
      if (url && !/^https?:\/\//i.test(url)) {
        if (url.startsWith("//")) url = window.location.protocol + url;
        else if (url.startsWith("/")) url = window.location.origin + url;
        else url = "https://" + url.replace(/^\/+/, "");
      }
      previewBtn.addEventListener("click", function () {
        stopAllRingtonePreviews();
        if (!url) return;
        const audio = new Audio(url);
        audio.volume = 0.85;
        previewRingtoneAudio = audio;
        audio.play().catch(() => {});
        const stopPreview = () => {
          try { if (previewRingtoneAudio === audio) { audio.pause(); audio.currentTime = 0; } } catch (e) {}
          previewRingtoneAudio = null;
        };
        setTimeout(stopPreview, PREVIEW_MAX_MS);
        audio.addEventListener("ended", stopPreview, { once: true });
      });
      selectBtn.addEventListener("click", function () {
        stopAllRingtonePreviews();
        if (!url) return;
        ajax("/diskuz-call/preferences", {
          type: "PUT",
          data: { selected_custom_ringtone_index: r.index },
        }).then(() => {
          window.DiskuzCallCustomRingtoneUrl = url;
          window.DiskuzCallSelectedCustomRingtoneIndex = r.index;
          list.querySelectorAll(".diskuz-custom-ringtones-row").forEach((r) => r.classList.remove("selected"));
          row.classList.add("selected");
          showToast(isIt ? "Suoneria salvata." : "Ringtone saved.");
        }).catch(() => showToast(isIt ? "Errore nel salvataggio." : "Failed to save."));
      });
      list.appendChild(row);
    });
    wrap.appendChild(list);
  }

  function openWidgetToNotificationsPage() {
    if (!widget.classList.contains("open")) {
      if (!isMobileDevice()) loadWidgetRectFromStorage();
      if (!lastWidgetRect || lastWidgetRect.width <= 0) {
        lastWidgetRect = getDefaultWidgetRect();
        saveWidgetRectToStorage();
      }
      applyLastRectToWidget();
      widget.style.display = "block";
      updateBodyScrollLock();
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
    if (!isMobileDevice()) loadWidgetRectFromStorage();
    if (!lastWidgetRect || lastWidgetRect.width <= 0) {
      lastWidgetRect = getDefaultWidgetRect();
      saveWidgetRectToStorage();
    }
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

  /* --- FLOATING BUTTON (nascosto quando composer è aperto o quando la chat è aperta: la chat ha già il suo tasto Call) --- */
  function isComposerVisible() {
    const replyControl = document.getElementById("reply-control");
    if (replyControl) {
      const style = window.getComputedStyle(replyControl);
      if (style.display !== "none" && style.visibility !== "hidden" && replyControl.offsetHeight > 0) return true;
    }
    const composerPopup = document.querySelector(".composer-popup, .fullscreen-composer, .d-modal-body .composer-fields");
    if (composerPopup) {
      const style = window.getComputedStyle(composerPopup);
      if (style.display !== "none" && style.visibility !== "hidden" && composerPopup.offsetHeight > 0) return true;
    }
    const body = document.body;
    if (body && body.classList && (body.classList.contains("composer-open") || body.classList.contains("has-composer"))) return true;
    return false;
  }

  function isChatOpen() {
    const path = (window.location && window.location.pathname) || "";
    if (path.indexOf("/chat") === 0) return true;
    const body = document.body;
    if (body && body.classList && body.classList.contains("chat-drawer-open")) return true;
    const chatDrawer = document.querySelector(".chat-drawer-outlet .is-open, .chat-drawer.is-open, [data-chat-drawer].is-open");
    if (chatDrawer) {
      const style = window.getComputedStyle(chatDrawer);
      if (style.display !== "none" && style.visibility !== "hidden" && chatDrawer.offsetWidth > 150) return true;
    }
    return false;
  }

  function updateFloatingButtonForComposer() {
    if (!btn) return;
    if (isComposerVisible() || isChatOpen()) {
      btn.style.display = "none";
    } else {
      btn.style.display = "";
    }
  }

  function updateCallFeatureVisibility() {
    if (widget) {
      if (widget.classList.contains("open")) {
        ensureFullyShown(widget);
        widget.style.display = "block";
      } else {
        ensureFullyHidden(widget);
      }
    }
    updateFloatingButtonForComposer();
  }

  function createFloatingButton() {
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "diskuz-call-btn";
      btn.innerHTML = `<span class="diskuz-call-btn-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></span><span class="diskuz-call-btn-label">Call</span>`;
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

  function updateFloatingButtonActiveCallState(minimized) {
    if (!btn) return;
    if (minimized) {
      btn.classList.add("diskuz-call-active-hidden");
    } else {
      btn.classList.remove("diskuz-call-active-hidden");
    }
  }

  function toggleCallUIVisibility() {
    if (!callUI || !currentCall.active) return;
    if (callUI.classList.contains("diskuz-call-minimized")) {
      callUI.classList.remove("diskuz-call-minimized");
      updateFloatingButtonActiveCallState(false);
      if (!isMobileDevice()) {
        loadWidgetRectFromStorage();
        applyWidgetRectToCallUI();
      }
      ensureFullyShown(callUI);
      callUI.style.display = "block";
      callUI.classList.add("open");
      if (!isMobileDevice()) {
        requestAnimationFrame(function () {
          vortexOpenDesktop(callUI);
        });
      }
    } else {
      if (!isMobileDevice()) {
        captureCallUIRect();
        vortexCloseDesktop(callUI, function () {
          callUI.classList.add("diskuz-call-minimized");
          ensureFullyHidden(callUI);
          updateFloatingButtonActiveCallState(true);
        });
      } else {
        callUI.classList.add("diskuz-call-minimized", "diskuz-call-ui-hiding");
        callUI.classList.remove("open");
        const hideDuration = 350;
        setTimeout(function () {
          if (!callUI) return;
          callUI.style.display = "none";
          callUI.classList.remove("diskuz-call-ui-hiding");
          ensureFullyHidden(callUI);
          updateFloatingButtonActiveCallState(true);
        }, hideDuration);
      }
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
          <div class="diskuz-widget-home-content">
            <h3 class="diskuz-widget-title">${isIt ? "Chiama un amico" : "Call a friend"}</h3>
            <p class="diskuz-widget-tagline">${tagline.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
            <div class="diskuz-call-input-wrap">
              <div class="diskuz-call-input-autocomplete-wrap">
                <input id="diskuz-call-input" type="text" placeholder="${isIt ? "Inserisci username" : "Enter username"}" class="diskuz-call-input-animated" autocomplete="off">
                <div id="diskuz-call-suggestions" class="diskuz-call-suggestions" role="listbox" aria-hidden="true"></div>
              </div>
            </div>
            <button id="diskuz-call-start" type="button" aria-label="${isIt ? "Chiama" : "Call"}"><span class="diskuz-call-widget-start-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></span></button>
            <div id="diskuz-call-error"></div>
            <div class="diskuz-widget-status-label">${isIt ? "Stato:" : "Status:"}</div>
            <div class="diskuz-widget-status-btns">
              <button id="diskuz-status-available" class="diskuz-status-btn">Online</button>
              <button id="diskuz-status-busy" class="diskuz-status-btn">${isIt ? "Occupato" : "Busy"}</button>
              <button id="diskuz-status-not-available" class="diskuz-status-btn">Offline</button>
            </div>
            <div class="diskuz-widget-notifications-ringtones-row">
              <button id="diskuz-call-history-btn" class="diskuz-notifications-open-btn">
                ${isIt ? "Notifiche" : "Notifications"}
                <span id="diskuz-notifications-badge" class="diskuz-notifications-badge">0</span>
              </button>
              <button type="button" id="diskuz-call-ringtones-toggle" class="diskuz-ringtones-toggle-btn" aria-expanded="false">${isIt ? "Suonerie" : "Ringtones"}</button>
            </div>
            <div id="diskuz-call-custom-ringtones-wrap" class="diskuz-custom-ringtones-wrap" style="display:none;"></div>
            <p class="diskuz-widget-description">${(isIt
              ? "Questo widget ti consente di chiamare i tuoi amici su "
              : "This widget lets you call your friends on ") + (siteName.replace(/</g, "&lt;").replace(/>/g, "&gt;")) + (isIt
              ? ". Imposta il tuo status su Online per ricevere chiamate, mentre se non vuoi essere disturbato utilizza i tasti Occupato e Offline."
              : ". Set your status to Online to receive calls, or use Busy and Offline if you don't want to be disturbed.")}</p>
          </div>
          <div class="diskuz-widget-footer">
            <button type="button" id="diskuz-widget-hide-btn" class="diskuz-widget-hide-btn">${isIt ? "Nascondi" : "Hide"}</button>
          </div>
        </div>
        <div class="diskuz-widget-page-notifications diskuz-widget-page">
          <div class="diskuz-widget-notifications-header">
            <button type="button" id="diskuz-widget-notifications-home-btn" class="diskuz-widget-home-btn diskuz-widget-back-btn" aria-label="${isIt ? "Indietro" : "Back"}"><span class="diskuz-widget-back-arrow" aria-hidden="true">←</span><span class="diskuz-widget-back-label">${isIt ? "Indietro" : "Back"}</span></button>
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

      /* Mobile (verticale): impedisce zoom a pinza sull'intero widget */
      if (isMobileDevice()) {
        widget.addEventListener("touchmove", function (e) {
          if (e.touches && e.touches.length >= 2) e.preventDefault();
        }, { passive: false });
      }

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
            widget.style.setProperty("left", newLeft + "px", "important");
            widget.style.setProperty("top", newTop + "px", "important");
            widget.style.setProperty("right", "auto", "important");
            widget.style.setProperty("bottom", "auto", "important");
          }
          function onWEnd() {
            document.removeEventListener("mousemove", onWMove);
            document.removeEventListener("mouseup", onWEnd);
            captureWidgetRect();
          }
          document.addEventListener("mousemove", onWMove);
          document.addEventListener("mouseup", onWEnd);
        });
        if (typeof ResizeObserver !== "undefined") {
          let widgetResizeTimeout;
          const widgetResizeObserver = new ResizeObserver(function () {
            clearTimeout(widgetResizeTimeout);
            widgetResizeTimeout = setTimeout(captureWidgetRect, 200);
          });
          widgetResizeObserver.observe(widget);
        }
      }

      const input = widget.querySelector("#diskuz-call-input");
      const startBtn = widget.querySelector("#diskuz-call-start");
      const errorBox = widget.querySelector("#diskuz-call-error");
      const historyBtn = widget.querySelector("#diskuz-call-history-btn");
      const suggestionsEl = widget.querySelector("#diskuz-call-suggestions");

      function getSuggestionsUsernameList() {
        const myUser = (currentUserUsername || "").toLowerCase().trim();
        const fromHistory = new Set();
        callHistory.forEach((h) => {
          const u = (h.username || "").trim();
          if (u && u.toLowerCase() !== myUser) fromHistory.add(u);
        });
        return Array.from(fromHistory).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
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
          showSuggestions(input.value);
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
          log("Starting call to", username, "userId", userId);
          startOutgoingCall(username, userId, data.user.avatar_template);
          toggleWidgetForceClose();
        } catch (e) {
          logWarn("Call start error", e);
          if (e.message === "RATE_LIMIT") {
            showError("Too many requests. Please wait a moment and try again.");
          } else if (e && (e.message === "Failed to fetch" || e.name === "TypeError")) {
            const isIt = document.documentElement.lang === "it";
            showError(isIt ? "Errore di rete. Verifica la connessione e riprova." : "Network error. Check your connection and try again.");
          } else {
            const isIt = document.documentElement.lang === "it";
            showError(isIt ? "Errore di connessione. Riprova." : "Connection error. Please try again.");
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

      const ringtonesToggle = widget.querySelector("#diskuz-call-ringtones-toggle");
      const ringtonesWrap = widget.querySelector("#diskuz-call-custom-ringtones-wrap");
      if (ringtonesToggle && ringtonesWrap) {
        ringtonesToggle.addEventListener("click", function () {
          const isHidden = ringtonesWrap.style.display === "none" || !ringtonesWrap.style.display;
          ringtonesWrap.style.display = isHidden ? "block" : "none";
          ringtonesToggle.setAttribute("aria-expanded", isHidden ? "true" : "false");
        });
      }

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

  /* --- PROXIMITY OVERLAY (Ear mode): logo + slogan sopra, Ear mode e indicazione centrati; sblocco con 3 tocchi --- */
  let proximityUnlockTapCount = 0;
  let proximityUnlockTapResetTimer = null;
  let lastProximityTouchTime = 0;
  let earModeAutoTimerId = null;
  function ensureProximityOverlay() {
    if (!proximityOverlay) {
      const isIt = typeof document !== "undefined" && document.documentElement && document.documentElement.lang === "it";
      proximityOverlay = document.createElement("div");
      proximityOverlay.id = "diskuz-call-proximity-overlay";
      proximityOverlay.innerHTML = "<div class=\"diskuz-call-proximity-overlay-inner\"><div class=\"diskuz-call-proximity-overlay-brand\"><span class=\"diskuz-call-proximity-overlay-logo\">diskuz Call</span><span class=\"diskuz-call-proximity-overlay-by\">by diskuz.com</span><span class=\"diskuz-call-proximity-overlay-slogan\">Real Conversations, No Algorithms :-)</span></div><span class=\"diskuz-call-proximity-overlay-title\">Ear mode</span><span class=\"diskuz-call-proximity-overlay-hint\">" + (isIt ? "Tocca lo schermo 3 volte per sbloccarlo." : "Tap the screen 3 times to unlock.") + "</span></div>";
      document.body.appendChild(proximityOverlay);

      function onUnlockTap() {
        proximityUnlockTapCount++;
        if (proximityUnlockTapResetTimer) clearTimeout(proximityUnlockTapResetTimer);
        if (proximityUnlockTapCount >= 3) {
          proximityOverlay.style.display = "none";
          proximityUnlockTapCount = 0;
        } else {
          proximityUnlockTapResetTimer = setTimeout(function () {
            proximityUnlockTapCount = 0;
            proximityUnlockTapResetTimer = null;
          }, 2000);
        }
      }
      proximityOverlay.addEventListener("touchend", function () {
        lastProximityTouchTime = Date.now();
        onUnlockTap();
      }, { passive: true });
      proximityOverlay.addEventListener("click", function () {
        if ("ontouchstart" in window && (Date.now() - lastProximityTouchTime) < 400) return;
        onUnlockTap();
      });
    }
  }

  function activateEarMode() {
    ensureProximityOverlay();
    if (proximityOverlay && proximityOverlay.parentNode) {
      proximityOverlay.parentNode.appendChild(proximityOverlay);
    }
    proximityUnlockTapCount = 0;
    if (proximityUnlockTapResetTimer) {
      clearTimeout(proximityUnlockTapResetTimer);
      proximityUnlockTapResetTimer = null;
    }
    proximityOverlay.style.display = "flex";
  }

  /* --- CALL UI --- */
  function createCallUI() {
    if (!callUI) {
      const isIt = document.documentElement.lang === "it";
      callUI = document.createElement("div");
      callUI.id = "diskuz-call-ui";

      callUI.innerHTML = `
        <div class="call-top-bar">
          <div class="call-drag-handle" title="Trascina per spostare" aria-label="Drag to move">
            <span class="call-top-bar-title">diskuz Call</span>
            <span class="call-top-bar-by">by diskuz.com</span>
          </div>
          <a href="https://ko-fi.com/italy" target="_blank" rel="noopener noreferrer" class="call-top-bar-kofi" title="Support on Ko-fi">Ko-fi</a>
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

          <div class="diskuz-call-video-wrap" style="display:none;">
            <video class="diskuz-call-remote-video" autoplay playsinline aria-label="Remote video"></video>
            <div class="diskuz-call-local-preview-outer">
              <div class="diskuz-call-local-preview-wrap" role="button" tabindex="0" aria-label="" title="">
                <button type="button" class="diskuz-call-switch-camera-btn" aria-label="" title="" style="display:none;"></button>
                <video class="diskuz-call-local-preview" autoplay playsinline muted aria-label="Your camera"></video>
                <span class="diskuz-call-mirror-toggle-icon" aria-hidden="true"></span>
                <input type="checkbox" class="diskuz-call-video-mirror-cb" checked aria-hidden="true" tabindex="-1" style="position:absolute;opacity:0;pointer-events:none;width:0;height:0;">
              </div>
            </div>
            <button type="button" class="diskuz-call-fullscreen-btn" aria-label="Fullscreen" style="display:none;">⛶</button>
          </div>
          <div class="diskuz-call-controls-block">
            <button type="button" class="diskuz-call-controls-toggle" tabindex="0" aria-label="" title=""></button>
            <div class="diskuz-call-controls-inner">
            <div class="controls">
              <button type="button" class="btn mute" aria-label="Mute microphone"><span class="diskuz-call-icon diskuz-call-icon-mic" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 1 3 3v8a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></span><span class="diskuz-call-icon diskuz-call-icon-mic-off" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><path d="M12 19v4"/><path d="M8 23h8"/></svg></span></button>
              <button type="button" class="btn speaker" aria-label="Speaker / audio output"><span class="diskuz-call-icon diskuz-call-icon-speaker" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></span></button>
              <button type="button" class="btn video" style="display:none;" aria-label="Video"><span class="diskuz-call-icon diskuz-call-icon-video" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></span></button>
              <button type="button" class="btn blur" style="display:none;" aria-label="Blur video"><span class="diskuz-call-icon diskuz-call-icon-blur" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M6 10.5 Q12 8 18 10.5"/><path d="M6 13.5 Q12 16 18 13.5"/></svg></span></button>
              <button type="button" class="btn hangup" aria-label="Hang up"><span class="diskuz-call-hangup-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></span></button>
            </div>
            </div>
          </div>

          <button type="button" class="ear-mode ear-mode-left" aria-label="Ear mode">Ear mode</button>
          <button type="button" class="ear-mode" aria-label="Ear mode">Ear mode</button>
          <div class="diskuz-call-hide-ui-row">
            <button type="button" class="diskuz-call-hide-ui-btn" aria-label="${isIt ? "Nascondi UI e naviga sul sito" : "Hide call UI and browse the site"}">${isIt ? "Nascondi e naviga" : "Hide and browse"}</button>
          </div>
        </div>
      `;

      document.body.appendChild(callUI);
      if (typeof isIOS === "function" && isIOS()) callUI.classList.add("diskuz-call-ios");
      if (isMobileDevice()) callUI.classList.add("diskuz-call-mobile");
      if (/Android/i.test(navigator.userAgent)) callUI.classList.add("diskuz-call-android");

      /* Mobile (anche orizzontale): impedisce zoom a pinza sull'intera UI chiamata */
      if (isMobileDevice()) {
        callUI.addEventListener("touchmove", function (e) {
          if (e.touches && e.touches.length >= 2) e.preventDefault();
        }, { passive: false });
      }

      const hideUIBtn = callUI.querySelector(".diskuz-call-hide-ui-btn");
      if (hideUIBtn) {
        hideUIBtn.addEventListener("click", function () {
          toggleCallUIVisibility();
        });
      }

      const controlsBlock = callUI.querySelector(".diskuz-call-controls-block");
      const controlsToggle = callUI.querySelector(".diskuz-call-controls-toggle");
      if (controlsBlock && controlsToggle) {
        const setControlsToggleLabel = function () {
          const hidden = controlsBlock.classList.contains("diskuz-call-controls-hidden");
          const isIt = document.documentElement.lang === "it";
          const landscape = callUI && callUI.classList.contains("diskuz-call-mobile-landscape");
          const label = landscape
            ? (hidden ? (isIt ? "Mostra" : "Show") : (isIt ? "Nascondi Tasti" : "Hide buttons"))
            : (hidden ? (isIt ? "Mostra pulsanti" : "Show controls") : (isIt ? "Nascondi pulsanti" : "Hide controls"));
          controlsToggle.textContent = label;
          controlsToggle.setAttribute("aria-label", label);
          controlsToggle.setAttribute("title", label);
        };
        if (callUI) callUI._setControlsToggleLabel = setControlsToggleLabel;
        setControlsToggleLabel();
        const toggleControlsVisibility = function () {
          controlsBlock.classList.toggle("diskuz-call-controls-hidden");
          setControlsToggleLabel();
        };
        controlsToggle.addEventListener("click", function (e) {
          e.preventDefault();
          toggleControlsVisibility();
        });
        if (isMobileDevice()) {
          controlsToggle.addEventListener("touchend", function (e) {
            e.preventDefault();
            toggleControlsVisibility();
          }, { passive: false });
        }
        controlsToggle.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleControlsVisibility();
          }
        });
      }

      const hangupBtn = callUI.querySelector(".hangup");
      const muteBtn = callUI.querySelector(".mute");
      const speakerBtn = callUI.querySelector(".speaker");
      const earBtns = callUI.querySelectorAll(".ear-mode");

      muteBtn.setAttribute("aria-pressed", "false");
      muteBtn.setAttribute("aria-label", "Mute microphone");
      speakerBtn.setAttribute("aria-pressed", "false");
      if (isMobileDevice()) {
        speakerBtn.classList.add("diskuz-call-speaker-mobile");
        speakerBtn.setAttribute("aria-label", isIt ? "Usa i tasti volume per il volume" : "Use volume keys for call volume");
      } else {
        speakerBtn.setAttribute("aria-label", "Speaker / audio output");
      }

      hangupBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        endCurrentCall("ended");
      });
      if (isMobileDevice()) {
        hangupBtn.addEventListener("touchend", function (e) {
          e.preventDefault();
          e.stopPropagation();
          endCurrentCall("ended");
        }, { passive: false });
      }

      muteBtn.addEventListener("click", function () {
        const isMuted = muteBtn.classList.toggle("active");
        if (rtcLocalStream) {
          rtcLocalStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
        }
        muteBtn.setAttribute("aria-pressed", muteBtn.classList.contains("active"));
      });

      speakerBtn.addEventListener("click", async function () {
        ensureRemoteAudio();
        /* Su mobile il tasto speaker non controlla l'uscita audio: mostra solo il popup che invita a usare i tasti volume */
        if (isMobileDevice() || isIOS()) {
          showSpeakerMobileVolumePopup();
          return;
        }
        if (!setSinkIdSupported()) {
          showToast("Audio output is controlled by your device.");
          return;
        }
        await cycleSpeakerOutput();
        const active = speakerOn;
        speakerBtn.classList.toggle("active", active);
        speakerBtn.setAttribute("aria-pressed", String(active));
      });

      earBtns.forEach((earBtn) => {
        if (earBtn) earBtn.style.display = isMobileDevice() ? "" : "none";
        earBtn.addEventListener("click", function () {
          activateEarMode();
        });
      });

      const videoBtn = callUI.querySelector(".btn.video");
      const videoWrap = callUI.querySelector(".diskuz-call-video-wrap");
      const fsButtonEl = callUI.querySelector(".diskuz-call-fullscreen-btn");
      const localPreview = callUI.querySelector(".diskuz-call-local-preview");
      const mirrorCb = callUI.querySelector(".diskuz-call-video-mirror-cb");
      const mirrorIconEl = callUI.querySelector(".diskuz-call-mirror-toggle-icon");
      const localPreviewWrap = callUI.querySelector(".diskuz-call-local-preview-wrap");
      const mirrorTitle = isIt ? "Clicca per attivare/disattivare specchio" : "Click to toggle mirror";
      if (localPreviewWrap) {
        localPreviewWrap.setAttribute("title", mirrorTitle);
        localPreviewWrap.setAttribute("aria-label", mirrorTitle);
      }
      try {
        const saved = window.localStorage.getItem(VIDEO_MIRROR_STORAGE_KEY);
        if (saved !== null && mirrorCb) mirrorCb.checked = saved !== "false";
      } catch (e) {}
      function updateMirrorIcon() {
        const checked = mirrorCb && mirrorCb.checked;
        if (mirrorIconEl) {
          mirrorIconEl.textContent = "\u21C4";
          mirrorIconEl.classList.toggle("active", !!checked);
        }
      }
      function applyMirrorToLocalPreview() {
        if (!localPreview) return;
        const checked = mirrorCb && mirrorCb.checked;
        localPreview.style.transform = checked ? "scaleX(-1)" : "none";
        updateMirrorIcon();
        try { window.localStorage.setItem(VIDEO_MIRROR_STORAGE_KEY, checked ? "true" : "false"); } catch (e) {}
        if (localVideoOn && rtcPeer && typeof applyMirrorToSentStream === "function") {
          applyMirrorToSentStream(!!checked);
        }
      }
      function toggleMirrorFromPreview() {
        if (!mirrorCb) return;
        mirrorCb.checked = !mirrorCb.checked;
        applyMirrorToLocalPreview();
      }
      if (mirrorCb) applyMirrorToLocalPreview();
      /* Fullscreen: su mobile prova prima il video (fullscreen nativo stile YouTube, sopra a tutto incluso UI telefono); fallback su call UI o CSS (iOS). */
      if (fsButtonEl) {
        fsButtonEl.addEventListener("click", function () {
          const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
          const remoteVideoEl = callUI.querySelector(".diskuz-call-remote-video");

          if (fsEl) {
            (document.exitFullscreen || document.webkitExitFullscreen)?.().call(document);
            return;
          }
          const reqFsVideo = remoteVideoEl && (remoteVideoEl.requestFullscreen || remoteVideoEl.webkitRequestFullscreen);
          const reqFsCallUI = callUI.requestFullscreen || callUI.webkitRequestFullscreen;
          /* Prova prima il video (desktop e mobile): fullscreen nativo sul video spesso più affidabile */
          if (reqFsVideo && callUI.classList.contains("diskuz-call-remote-video-active")) {
            (remoteVideoEl.requestFullscreen || remoteVideoEl.webkitRequestFullscreen).call(remoteVideoEl).then(() => {
              callUI.classList.add("diskuz-call-fullscreen-active");
            }).catch((err) => {
              logWarn("fullscreen on video failed", err);
              if (reqFsCallUI) reqFsCallUI.call(callUI).catch((e) => logWarn("fullscreen on callUI failed", e));
            });
            return;
          }
          /* iOS senza supporto video fullscreen: solo CSS fallback */
          if (isIOS()) {
            const active = callUI.classList.toggle("diskuz-call-fullscreen-active");
            if (!active && document.body) document.body.classList.remove("diskuz-call-ios-fullscreen-fallback");
            else if (active && document.body) document.body.classList.add("diskuz-call-ios-fullscreen-fallback");
            return;
          }
          if (reqFsCallUI) reqFsCallUI.call(callUI).catch((e) => logWarn("fullscreen failed", e));
        });
        const onFullscreenChange = () => {
          const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
          const remoteVideoEl = callUI.querySelector(".diskuz-call-remote-video");
          const isCallUIFs = !!fsEl && fsEl === callUI;
          const isVideoFs = !!fsEl && remoteVideoEl && fsEl === remoteVideoEl;
          if (!fsEl) {
            callUI.classList.remove("diskuz-call-fullscreen-active");
            if (document.body) document.body.classList.remove("diskuz-call-ios-fullscreen-fallback");
          } else if (isCallUIFs || isVideoFs) {
            callUI.classList.add("diskuz-call-fullscreen-active");
            if (isCallUIFs && document.body) document.body.classList.add("diskuz-call-ios-fullscreen-fallback");
          }
        };
        document.addEventListener("fullscreenchange", onFullscreenChange);
        document.addEventListener("webkitfullscreenchange", onFullscreenChange);
      }

      /* Mobile: anteprima draggabile; tap (senza trascinare) attiva/disattiva mirror */
      const switchCameraBtn = callUI.querySelector(".diskuz-call-switch-camera-btn");
      function updateSwitchCameraButton() {
        if (!switchCameraBtn) return;
        const useRear = currentVideoFacingMode === "user";
        const label = useRear
          ? (isIt ? "Usa retrocamera" : "Use rear camera")
          : (isIt ? "Usa frontale" : "Use front camera");
        switchCameraBtn.setAttribute("aria-label", label);
        switchCameraBtn.setAttribute("title", label);
        switchCameraBtn.textContent = useRear ? "\uD83D\uDCF7" : "\uD83D\uDCF9";
        switchCameraBtn.style.display = isMobileDevice() && localVideoOn ? "flex" : "none";
      }
      if (switchCameraBtn) {
        switchCameraBtn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (!isMobileDevice() || !localVideoOn) return;
          switchCamera().catch((err) => {
            logWarn("switchCamera failed", err);
            showToast(isIt ? "Impossibile cambiare fotocamera." : "Could not switch camera.");
          });
        });
      }
      if (callUI) callUI._updateSwitchCameraButton = updateSwitchCameraButton;

      if (localPreviewWrap) {
        let dragOffsetX = 0, dragOffsetY = 0, dragStartX = 0, dragStartY = 0, dragStartOffX = 0, dragStartOffY = 0;
        const localPreviewOuter = localPreviewWrap.closest(".diskuz-call-local-preview-outer");
        const callInner = callUI && callUI.querySelector(".call-inner");
        function resetPreviewPosition() {
          dragOffsetX = 0;
          dragOffsetY = 0;
          if (localPreviewWrap) localPreviewWrap.style.transform = "";
        }
        if (callUI) callUI._resetLocalPreviewPosition = resetPreviewPosition;
        function clampPreviewOffset(offX, offY) {
          if (!callInner || !localPreviewOuter) return { x: offX, y: offY };
          const container = callInner.getBoundingClientRect();
          const outer = localPreviewOuter.getBoundingClientRect();
          const wrap = localPreviewWrap.getBoundingClientRect();
          const minX = container.left - outer.left;
          const maxX = container.right - outer.left - wrap.width;
          const minY = container.top - outer.top;
          const maxY = container.bottom - outer.top - wrap.height;
          const x = Math.min(Math.max(offX, minX), maxX);
          const y = Math.min(Math.max(offY, minY), maxY);
          return { x, y };
        }
        function applyClampedTransform(offX, offY) {
          const c = clampPreviewOffset(offX, offY);
          dragOffsetX = c.x;
          dragOffsetY = c.y;
          localPreviewWrap.style.transform = "translate(" + dragOffsetX + "px, " + dragOffsetY + "px)";
        }
        if (isMobileDevice()) {
          localPreviewWrap.addEventListener("touchstart", function (e) {
            if (!e.touches || e.touches.length === 0) return;
            if (e.target.closest(".diskuz-call-switch-camera-btn")) return;
            e.stopPropagation();
            localPreviewWrap.classList.add("diskuz-local-preview-dragging");
            dragStartX = e.touches[0].clientX;
            dragStartY = e.touches[0].clientY;
            dragStartOffX = dragOffsetX;
            dragStartOffY = dragOffsetY;
          }, { passive: true });
          localPreviewWrap.addEventListener("touchmove", function (e) {
            if (!e.touches || e.touches.length === 0) return;
            e.preventDefault();
            const dx = e.touches[0].clientX - dragStartX;
            const dy = e.touches[0].clientY - dragStartY;
            applyClampedTransform(dragStartOffX + dx, dragStartOffY + dy);
          }, { passive: false });
          localPreviewWrap.addEventListener("touchend", function (e) {
            localPreviewWrap.classList.remove("diskuz-local-preview-dragging");
            if (e.target.closest(".diskuz-call-switch-camera-btn")) return;
            const moved = Math.abs(dragOffsetX - dragStartOffX) + Math.abs(dragOffsetY - dragStartOffY);
            if (moved < 12) {
              e.preventDefault();
              e.stopPropagation();
              toggleMirrorFromPreview();
            }
          }, { passive: false });
          localPreviewWrap.addEventListener("touchcancel", function () {
            localPreviewWrap.classList.remove("diskuz-local-preview-dragging");
          }, { passive: true });
        } else {
          localPreviewWrap.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            if (e.target.closest(".diskuz-call-switch-camera-btn")) return;
            e.preventDefault();
            e.stopPropagation();
            localPreviewWrap.classList.add("diskuz-local-preview-dragging");
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartOffX = dragOffsetX;
            dragStartOffY = dragOffsetY;
            function onMouseMove(ev) {
              ev.preventDefault();
              const dx = ev.clientX - dragStartX;
              const dy = ev.clientY - dragStartY;
              applyClampedTransform(dragStartOffX + dx, dragStartOffY + dy);
            }
            function onMouseUp(ev) {
              document.removeEventListener("mousemove", onMouseMove);
              document.removeEventListener("mouseup", onMouseUp);
              localPreviewWrap.classList.remove("diskuz-local-preview-dragging");
              if (ev.target.closest && ev.target.closest(".diskuz-call-local-preview-wrap") === localPreviewWrap) {
                const moved = Math.abs(dragOffsetX - dragStartOffX) + Math.abs(dragOffsetY - dragStartOffY);
                if (moved < 8) toggleMirrorFromPreview();
              }
            }
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
          });
        }
      }

      function showVideoDisableInfoPopup() {
        const isIt = document.documentElement.lang === "it";
        const msg = isIt
          ? "Per spegnere il video termina la conversazione e richiama in solo voce."
          : "To turn off video during a call, please end this call and start a new voice-only call.";
        let pop = callUI.querySelector(".diskuz-call-video-disable-info");
        if (!pop) {
          pop = document.createElement("div");
          pop.className = "diskuz-call-video-disable-info";
          pop.setAttribute("role", "alert");
          callUI.appendChild(pop);
          pop.addEventListener("click", function (e) {
            e.stopPropagation();
            pop.classList.remove("is-visible");
          });
        }
        pop.textContent = msg;
        pop.classList.add("is-visible");
        const hide = function () {
          pop.classList.remove("is-visible");
          document.removeEventListener("click", hide);
        };
        requestAnimationFrame(function () {
          document.addEventListener("click", hide);
        });
        setTimeout(hide, 5500);
      }

      function showBlurActivePopup() {
        const isIt = document.documentElement.lang === "it";
        const msg = isIt ? "Video offuscato" : "Video blurred";
        let pop = callUI.querySelector(".diskuz-call-blur-active-info");
        if (!pop) {
          pop = document.createElement("div");
          pop.className = "diskuz-call-blur-active-info";
          pop.setAttribute("role", "status");
          callUI.appendChild(pop);
        }
        pop.textContent = msg;
        pop.classList.add("is-visible");
        const blurBtn = callUI.querySelector(".btn.blur");
        if (blurBtn) {
          const rect = blurBtn.getBoundingClientRect();
          const callRect = callUI.getBoundingClientRect();
          pop.style.left = rect.left - callRect.left + (rect.width / 2) + "px";
          pop.style.bottom = callRect.bottom - rect.top + 8 + "px";
          pop.style.transform = "translateX(-50%)";
        }
        clearTimeout(pop._blurPopupTimer);
        pop._blurPopupTimer = setTimeout(function () {
          pop.classList.remove("is-visible");
        }, 5000);
      }

      function handleVideoButtonTap() {
        const isIt = document.documentElement.lang === "it";
        if (videoRequestInProgress && !localVideoOn) {
          showToast(isIt ? "Attendere..." : "Please wait...");
          return;
        }
        log("[UI] Video button tapped, localVideoOn=", localVideoOn);
        if (localVideoOn) {
          showVideoDisableInfoPopup();
          return;
        }
        showToast(isIt ? "Avvio videocamera..." : "Starting camera...");
        enableVideo().catch((err) => {
          logWarn("enableVideo failed in handler", err);
          showToast(isIt ? "Errore video: " + (err && err.message ? err.message : "riprova") : "Video error: " + (err && err.message ? err.message : "try again"));
        });
      }
      /* Delegazione click su callUI: così il Video viene gestito come Mute/Speaker anche se un tema o altro codice tocca i pulsanti. */
      function updateLocalPreviewBlur() {
        const preview = callUI && callUI.querySelector(".diskuz-call-local-preview");
        if (preview) preview.classList.toggle("diskuz-call-preview-blurred", videoBlurOn);
      }
      function handleBlurButtonTap() {
        if (!localVideoOn || !rtcPeer) return;
        const isIt = document.documentElement.lang === "it";
        if (isIOS()) {
          if (!videoBlurOn) {
            showToast(isIt ? "Blur non disponibile su iPhone/iPad." : "Blur is not available on iPhone/iPad.");
            return;
          }
        }
        const mirrorCb = callUI && callUI.querySelector(".diskuz-call-video-mirror-cb");
        videoBlurOn = !videoBlurOn;
        const blurBtn = callUI && callUI.querySelector(".btn.blur");
        if (blurBtn) {
          blurBtn.classList.toggle("active", videoBlurOn);
          blurBtn.setAttribute("aria-label", videoBlurOn ? (isIt ? "Sfoca video attiva" : "Blur on") : (isIt ? "Sfoca video" : "Blur video"));
        }
        updateLocalPreviewBlur();
        if (videoBlurOn && typeof showBlurActivePopup === "function") showBlurActivePopup();
        if (typeof applyVideoEffectsToSentStream === "function") {
          applyVideoEffectsToSentStream(mirrorCb && mirrorCb.checked, videoBlurOn).catch((err) => {
            logWarn("applyVideoEffectsToSentStream failed (blur)", err);
            videoBlurOn = !videoBlurOn;
            if (blurBtn) blurBtn.classList.toggle("active", videoBlurOn);
            updateLocalPreviewBlur();
          });
        }
      }

      callUI.addEventListener("click", function (e) {
        if (e.target.closest(".btn.video")) {
          e.preventDefault();
          e.stopPropagation();
          handleVideoButtonTap();
        }
        if (e.target.closest(".btn.blur")) {
          e.preventDefault();
          e.stopPropagation();
          handleBlurButtonTap();
        }
        if (e.target.closest(".btn.hangup")) {
          e.preventDefault();
          e.stopPropagation();
          endCurrentCall("ended");
        }
      }, true);
      if (videoBtn) {
        videoBtn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          handleVideoButtonTap();
        }, true);
        if (isMobileDevice()) {
          videoBtn.addEventListener("touchend", function (e) {
            e.preventDefault();
            handleVideoButtonTap();
          }, { passive: false });
        }
      }
      const blurBtnEl = callUI.querySelector(".btn.blur");
      if (blurBtnEl) {
        blurBtnEl.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          handleBlurButtonTap();
        }, true);
        if (isMobileDevice()) {
          blurBtnEl.addEventListener("touchend", function (e) {
            e.preventDefault();
            e.stopPropagation();
            handleBlurButtonTap();
          }, { passive: false });
        }
      }

      let startY = 0;
      let currentY = 0;
      let dragging = false;

      callUI.addEventListener("touchstart", function (e) {
        if (!e.touches || e.touches.length === 0) return;
        if (e.target.closest("button, input, .controls, .diskuz-call-video-wrap, .diskuz-call-local-preview-wrap")) return;
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
      if (topBar && isMobileDevice()) topBar.style.cursor = "";
      if (!isMobileDevice()) {
        callUI.style.setProperty("position", "fixed", "important");
        if (topBar) topBar.style.cursor = "grab";
        function startCallUIDrag(e) {
          e.preventDefault();
          e.stopPropagation();
          const rect = callUI.getBoundingClientRect();
          const dragW = rect.width;
          const dragH = rect.height;
          const dragStartX = e.clientX;
          const dragStartY = e.clientY;
          const dragStartLeft = rect.left;
          const dragStartTop = rect.top;
          const W = window.innerWidth;
          const H = window.innerHeight;
          if (topBar) topBar.style.cursor = "grabbing";
          function onDragMove(ev) {
            ev.preventDefault();
            const dx = ev.clientX - dragStartX;
            const dy = ev.clientY - dragStartY;
            const newLeft = Math.max(0, Math.min(W - dragW, dragStartLeft + dx));
            const newTop = Math.max(0, Math.min(H - dragH, dragStartTop + dy));
            callUI.style.setProperty("left", newLeft + "px", "important");
            callUI.style.setProperty("top", newTop + "px", "important");
            callUI.style.setProperty("right", "auto", "important");
            callUI.style.setProperty("bottom", "auto", "important");
          }
          function onDragEnd() {
            document.removeEventListener("mousemove", onDragMove);
            document.removeEventListener("mouseup", onDragEnd);
            if (topBar) topBar.style.cursor = "grab";
            captureCallUIRect();
          }
          document.addEventListener("mousemove", onDragMove);
          document.addEventListener("mouseup", onDragEnd);
        }
        const dragHandle = callUI.querySelector(".call-drag-handle");
        function onCallUIMouseDown(e) {
          if (e.button !== 0) return;
          if (!e.target.closest(".call-top-bar")) return;
          e.preventDefault();
          e.stopPropagation();
          startCallUIDrag(e);
        }
        if (topBar) {
          topBar.style.cursor = "grab";
          topBar.addEventListener("mousedown", onCallUIMouseDown, true);
        }
        if (dragHandle) {
          dragHandle.style.cursor = "grab";
          dragHandle.addEventListener("mousedown", onCallUIMouseDown, true);
        }
        callUI.addEventListener("mousedown", function (e) {
          if (e.target.closest(".call-top-bar")) return;
          if (e.target.closest(".diskuz-call-local-preview-wrap")) return;
          if (e.target.closest("button, input, a, select, textarea, [contenteditable=\"true\"]")) return;
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startCallUIDrag(e);
        }, true);
        if (typeof ResizeObserver !== "undefined") {
          let callUIResizeTimeout;
          const callUIResizeObserver = new ResizeObserver(function () {
            clearTimeout(callUIResizeTimeout);
            callUIResizeTimeout = setTimeout(captureCallUIRect, 200);
          });
          callUIResizeObserver.observe(callUI);
        }
      }
    }
  }

  function updateCallUI(username, avatarTemplate, statusText) {
    createCallUI();
    /* Ogni nuova chiamata parte con microfono non muto (icona e stato reale) */
    const muteBtn = callUI && callUI.querySelector(".mute");
    if (muteBtn) {
      muteBtn.classList.remove("active");
      muteBtn.setAttribute("aria-pressed", "false");
    }
    if (rtcLocalStream) {
      rtcLocalStream.getAudioTracks().forEach((t) => (t.enabled = true));
    }

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

    /* Desktop: call UI nella stessa posizione del widget. Cattura posizione widget solo se era aperto, altrimenti usa storage o default. */
    if (!isMobileDevice()) {
      widgetWasOpenBeforeCall = !!(widget && widget.classList.contains("open"));
      loadWidgetRectFromStorage();
      if (widget) {
        if (widgetWasOpenBeforeCall) captureWidgetRect();
        ensureFullyHidden(widget);
      }
      if (!lastWidgetRect || lastWidgetRect.width <= 0) {
        lastWidgetRect = getDefaultWidgetRect();
        saveWidgetRectToStorage();
      }
      applyWidgetRectToCallUI();
    }

    ensureFullyShown(callUI);
    callUI.style.display = "block";

    if (!isMobileDevice()) {
      updateBodyScrollLock();
    }
    /* Se la connessione è già "connected", il pulsante Video va mostrato subito */
    if (rtcPeer && rtcPeer.connectionState === "connected" && typeof updateVideoButtonVisibility === "function") {
      updateVideoButtonVisibility();
    }

    setTimeout(function () {
      callUI.classList.add("open");
      if (currentCall.direction === "outgoing" && currentCall.isRinging) {
        callUI.classList.add("diskuz-call-outgoing-ringing");
      } else {
        callUI.classList.remove("diskuz-call-outgoing-ringing");
      }
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
    if (earModeAutoTimerId) {
      clearTimeout(earModeAutoTimerId);
      earModeAutoTimerId = null;
    }
    if (desktopBackgroundEndCallTimeoutId) {
      clearTimeout(desktopBackgroundEndCallTimeoutId);
      desktopBackgroundEndCallTimeoutId = null;
    }
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
    setIncomingCallButtonState(false);
    updateFloatingButtonActiveCallState(false);
    callUI.classList.remove("open", "diskuz-call-minimized", "diskuz-call-incoming-ringing", "diskuz-call-outgoing-ringing", "diskuz-call-video-active", "diskuz-call-connected");
    if (proximityOverlay) {
      proximityOverlay.style.display = "none";
    }
    const wasOpen = widgetWasOpenBeforeCall;
    if (!isMobileDevice()) captureCallUIRect();
    setTimeout(function () {
      ensureFullyHidden(callUI);
      callUI.style.transform = "";
      if (!isMobileDevice() && widget && wasOpen) {
        applyLastRectToWidget();
        ensureFullyShown(widget);
        widget.style.display = "block";
      }
      updateBodyScrollLock();
    }, 200);
  }

  function isMobileDevice() {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (typeof window.orientation !== "undefined") || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
  }

  function isIOS() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function updateBodyScrollLock() {
    const widgetOpen = widget && widget.classList.contains("open");
    const callUIVisible = callUI && callUI.style.display === "block";
    const shouldLock = !isMobileDevice() && (widgetOpen || callUIVisible);
    document.body.classList.toggle("diskuz-call-noscroll", !!shouldLock);
  }

  function ensureFullyHidden(el) {
    if (!el) return;
    el.style.display = "none";
    el.style.visibility = "hidden";
    el.style.pointerEvents = "none";
  }

  function getFloatingButtonCenter() {
    if (!btn) return { x: window.innerWidth - 58, y: window.innerHeight - 58 };
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const VORTEX_DURATION_MS = 320;

  function vortexCloseDesktop(el, onDone) {
    if (!el || isMobileDevice()) {
      if (onDone) onDone();
      return;
    }
    const rect = el.getBoundingClientRect();
    const center = getFloatingButtonCenter();
    const originX = center.x - rect.left;
    const originY = center.y - rect.top;
    el.style.transformOrigin = originX + "px " + originY + "px";
    el.classList.add("diskuz-call-vortex-out");
    el.offsetHeight;
    el.style.transform = "scale(0)";
    el.style.opacity = "0";
    setTimeout(function () {
      el.classList.remove("diskuz-call-vortex-out", "open");
      el.style.transform = "";
      el.style.opacity = "";
      el.style.transformOrigin = "";
      ensureFullyHidden(el);
      if (onDone) onDone();
    }, VORTEX_DURATION_MS);
  }

  function vortexOpenDesktop(el) {
    if (!el || isMobileDevice()) return;
    ensureFullyShown(el);
    const rect = el.getBoundingClientRect();
    const center = getFloatingButtonCenter();
    const originX = center.x - rect.left;
    const originY = center.y - rect.top;
    el.style.transformOrigin = originX + "px " + originY + "px";
    el.style.transform = "scale(0)";
    el.style.opacity = "0";
    el.classList.add("diskuz-call-vortex-in");
    el.offsetHeight;
    el.style.transform = "scale(1)";
    el.style.opacity = "1";
    setTimeout(function () {
      el.classList.remove("diskuz-call-vortex-in");
      el.style.transform = "";
      el.style.opacity = "";
      el.style.transformOrigin = "";
    }, VORTEX_DURATION_MS);
  }

  function ensureFullyShown(el) {
    if (!el) return;
    el.style.display = "";
    el.style.visibility = "visible";
    el.style.pointerEvents = "auto";
  }

  /* --- WEBRTC AUDIO ENGINE --- */
  let rtcPeer = null;
  let rtcLocalStream = null;
  let rtcRemoteAudio = null;
  let rtcRemoteVideoStream = null;
  let localVideoTrack = null;
  let localVideoOn = false;
  let remoteVideoActive = false;
  let remoteVideoPausedByPeer = false;
  let videoRequestInProgress = false;
  let videoRenegotiationPromise = Promise.resolve();
  const VIDEO_MIRROR_STORAGE_KEY = "diskuz_call_video_mirror";
  let mirrorCanvasEl = null;
  let mirrorCanvasStream = null;
  let mirrorDrawLoopId = null;
  let videoBlurOn = false;
  let currentVideoFacingMode = "user";
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
  let desktopBackgroundEndCallTimeoutId = null;
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
        rtcRemoteAudio.setAttribute("autoplay", "");
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
      logWarn("setSinkId failed", e);
    }
  }

  /** Su mobile/iOS: chiamata solo voce = volume basso (ear), videochiamata = volume massimo (vivavoce). Desktop = sempre 1. */
  function applyRemoteAudioVolumeForCallType() {
    if (!rtcRemoteAudio) return;
    if (isMobileDevice() || isIOS()) {
      const isVideo = callUI && callUI.classList.contains("diskuz-call-video-active");
      rtcRemoteAudio.volume = isVideo ? 1 : 0.5;
    } else {
      rtcRemoteAudio.volume = 1;
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

  function selectAudioOutputSupported() {
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === "function");
  }

  async function openNativeAudioOutputPicker() {
    if (!selectAudioOutputSupported() || !setSinkIdSupported()) return false;
    try {
      const device = await navigator.mediaDevices.selectAudioOutput();
      if (device && device.deviceId) {
        currentSinkId = device.deviceId;
        speakerOn = true;
        await applySpeakerSink();
        await refreshAudioOutputDevices();
        const label = (device.label || "Speaker").slice(0, 28);
        showToast(label);
        return true;
      }
    } catch (e) {
      if (e.name !== "NotAllowedError" && e.name !== "NotFoundError") {
        logWarn("selectAudioOutput failed", e);
      }
    }
    return false;
  }

  async function cycleSpeakerOutput() {
    if (!setSinkIdSupported()) return;
    const isIt = document.documentElement.lang === "it";
    await refreshAudioOutputDevices();
    const totalOptions = audioOutputDevices.length + 1;
    currentSinkIndex = (currentSinkIndex + 1) % totalOptions;
    if (currentSinkIndex === 0) {
      currentSinkId = "";
      speakerOn = false;
      await applySpeakerSink();
      showToast(isMobileDevice() ? (isIt ? "Orecchio" : "Earpiece") : (isIt ? "Predefinito" : "Default"));
      return;
    }
    const device = audioOutputDevices[currentSinkIndex - 1];
    currentSinkId = device.deviceId;
    speakerOn = true;
    await applySpeakerSink();
    const label = (device.label || (isIt ? "Vivavoce" : "Speaker")).slice(0, 28);
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

  function hasRemoteVideoTrack() {
    if (!rtcPeer) return false;
    return rtcPeer.getReceivers().some(
      (r) => r.track && r.track.kind === "video" && r.track.readyState !== "ended"
    );
  }

  function syncRemoteVideoState() {
    if (!rtcPeer) return;
    const receivers = rtcPeer.getReceivers();
    const hasActiveRemoteVideo = receivers.some(
      (r) =>
        r.track &&
        r.track.kind === "video" &&
        r.track.readyState !== "ended" &&
        r.track.enabled &&
        !r.track.muted
    );
    if (remoteVideoActive !== hasActiveRemoteVideo) {
      remoteVideoActive = hasActiveRemoteVideo;
    }
  }


  function updateVideoLayout() {
    if (!callUI) return;
    syncRemoteVideoState();
    const wrap = callUI.querySelector(".diskuz-call-video-wrap");
    const fsBtn = callUI.querySelector(".diskuz-call-fullscreen-btn");
    const hasRemoteTrack = hasRemoteVideoTrack();
    const show = localVideoOn || remoteVideoActive || hasRemoteTrack;
    if (wrap) wrap.style.display = show ? "block" : "none";
    callUI.classList.toggle("diskuz-call-video-active", !!show);
    callUI.classList.toggle("diskuz-call-remote-video-active", !!remoteVideoActive);
    if (show && earModeAutoTimerId) {
      clearTimeout(earModeAutoTimerId);
      earModeAutoTimerId = null;
    }
    callUI.classList.toggle("diskuz-call-preview-only", !!localVideoOn && !remoteVideoActive);
    if (typeof applyRemoteAudioVolumeForCallType === "function") applyRemoteAudioVolumeForCallType();
    const remoteVideoEl = callUI.querySelector(".diskuz-call-remote-video");
    if (remoteVideoEl && rtcRemoteVideoStream) {
      remoteVideoEl.srcObject = rtcRemoteVideoStream;
      remoteVideoEl.style.display = "";
      remoteVideoEl.style.visibility = "";
      remoteVideoEl.style.opacity = "";
    }
    const localPreviewOuter = callUI.querySelector(".diskuz-call-local-preview-outer");
    if (localPreviewOuter) localPreviewOuter.style.display = localVideoOn ? "flex" : "none";
    if (show && typeof callUI._resetLocalPreviewPosition === "function") callUI._resetLocalPreviewPosition();
    if (fsBtn) fsBtn.style.display = show && remoteVideoActive ? "block" : "none";
  }

  function updateVideoButtonVisibility() {
    if (!callUI) return;
    const videoBtn = callUI.querySelector(".btn.video");
    const blurBtn = callUI.querySelector(".btn.blur");
    const connected = rtcPeer && rtcPeer.connectionState === "connected";
    if (videoBtn) videoBtn.style.display = connected ? "" : "none";
    if (blurBtn) blurBtn.style.display = connected && localVideoOn && !isIOS() ? "" : "none";
  }

  async function enableVideo() {
    const isIt = document.documentElement.lang === "it";
    if (videoRequestInProgress) {
      log("[diskuz-call] enableVideo skipped: request already in progress");
      showToast(isIt ? "Attendere avvio video in corso..." : "Video start in progress, please wait...");
      return;
    }
    videoRequestInProgress = true;
    if (!rtcPeer) {
      videoRequestInProgress = false;
      showToast(isIt ? "Connessione non pronta." : "Connection not ready.");
      return;
    }
    if (!rtcLocalStream) {
      videoRequestInProgress = false;
      showToast(isIt ? "Stream non disponibile." : "Stream not available.");
      return;
    }
    if (!currentCall.userId) {
      videoRequestInProgress = false;
      showToast(isIt ? "Chiamata non attiva." : "No active call.");
      return;
    }
    if (typeof window.DiskuzCallSend !== "function") {
      videoRequestInProgress = false;
      showToast(isIt ? "Invio segnali non disponibile." : "Signaling not available.");
      return;
    }
    const wrap = callUI && callUI.querySelector(".diskuz-call-video-wrap");
    const localPreview = callUI && callUI.querySelector(".diskuz-call-local-preview");
    if (wrap) {
      wrap.style.display = "block";
      wrap.style.visibility = "visible";
      callUI.classList.add("diskuz-call-video-active");
      void wrap.offsetHeight;
    }
    if (localPreview) {
      localPreview.setAttribute("playsinline", "true");
      localPreview.setAttribute("webkit-playsinline", "true");
      localPreview.muted = true;
      localPreview.playsInline = true;
    }
    try {
      /* Video qualità massima/origine: su Android richiedi 1080p (o massimo supportato dal dispositivo) */
      const isAndroid = /Android/i.test(navigator.userAgent);
      const videoOpt = {
        facingMode: "user",
        width: { ideal: 1920, min: isAndroid ? 1920 : 640 },
        height: { ideal: 1080, min: isAndroid ? 1080 : 480 },
        frameRate: { ideal: 30, min: 24 },
      };
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        videoRequestInProgress = false;
        if (wrap) wrap.style.display = "none";
        callUI.classList.remove("diskuz-call-video-active");
        showToast(isIt ? "Questo browser non supporta l'accesso alla telecamera." : "This browser does not support camera access.");
        return;
      }
      const getUserMediaWithTimeout = (ms) => {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(isIt ? "Timeout: permesso telecamera non ricevuto. Controlla le impostazioni del browser." : "Timeout: camera permission not received. Check browser settings.")), ms);
          navigator.mediaDevices.getUserMedia({ video: videoOpt }).then((stream) => {
            clearTimeout(t);
            resolve(stream);
          }, (err) => {
            clearTimeout(t);
            reject(err);
          });
        });
      };
      let videoStream = null;
      try {
        videoStream = await getUserMediaWithTimeout(20000);
      } catch (err) {
        if (isAndroid && err.name === "OverconstrainedError") {
          const fallbackOpt = { facingMode: "user", width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 }, frameRate: { ideal: 30 } };
          videoStream = await navigator.mediaDevices.getUserMedia({ video: fallbackOpt });
        } else {
          throw err;
        }
      }
      const videoTrack = videoStream.getVideoTracks()[0];
      if (!videoTrack) {
        videoRequestInProgress = false;
        videoStream.getTracks().forEach((t) => t.stop());
        if (wrap) wrap.style.display = "none";
        callUI.classList.remove("diskuz-call-video-active");
        showToast(isIt ? "Nessun track video." : "No video track.");
        return;
      }
      /* Android: spingi alla risoluzione massima supportata (getCapabilities) o almeno 1080p/720p */
      if (videoTrack.getCapabilities && videoTrack.applyConstraints && isAndroid) {
        try {
          const cap = videoTrack.getCapabilities();
          const w = (cap.width && cap.width.max) ? Math.min(1920, cap.width.max) : 1920;
          const h = (cap.height && cap.height.max) ? Math.min(1080, cap.height.max) : 1080;
          await videoTrack.applyConstraints({ width: w, height: h, frameRate: { ideal: 30 } });
        } catch (e) {}
        const s = videoTrack.getSettings ? videoTrack.getSettings() : {};
        if ((s.width || 0) < 1280 || (s.height || 0) < 720) {
          try {
            await videoTrack.applyConstraints({ width: 1280, height: 720 });
          } catch (e) {}
        }
      }
      rtcLocalStream.addTrack(videoTrack);
      localVideoTrack = videoTrack;
      rtcPeer.addTrack(videoTrack, rtcLocalStream);
      await setVideoSenderHighQuality();
      const offer = await rtcPeer.createOffer();
      await rtcPeer.setLocalDescription(offer);
      const sdpPayload = serializeSdp(rtcPeer.localDescription);
      if (!sdpPayload || !sdpPayload.type || !sdpPayload.sdp) {
        videoRequestInProgress = false;
        if (wrap) wrap.style.display = "none";
        callUI.classList.remove("diskuz-call-video-active");
        showToast(isIt ? "Impossibile creare offerta video." : "Could not create video offer.");
        return;
      }
      try {
        await window.DiskuzCallSend({
          type: "video_offer",
          to_user_id: currentCall.userId,
          from_user_id: null,
          sdp: sdpPayload,
        });
        if (currentCall.userId && window.DiskuzCallSend) {
          window.DiskuzCallSend({ type: "video_resumed", to_user_id: currentCall.userId }).catch(() => {});
        }
      } catch (sendErr) {
        videoRequestInProgress = false;
        logWarn("video_offer send failed", sendErr);
        if (wrap) wrap.style.display = "none";
        callUI.classList.remove("diskuz-call-video-active");
        showToast(isIt ? "Invio offerta video fallito." : "Failed to send video offer.");
        return;
      }
      localVideoOn = true;
      const mirrorCb = callUI && callUI.querySelector(".diskuz-call-video-mirror-cb");
      if (localPreview) {
        localPreview.muted = true;
        localPreview.playsInline = true;
        localPreview.setAttribute("playsinline", "true");
        localPreview.setAttribute("webkit-playsinline", "true");
        localPreview.srcObject = new MediaStream([videoTrack]);
        localPreview.style.transform = (mirrorCb && mirrorCb.checked) ? "scaleX(-1)" : "none";
        /* Su iOS/Android play() spesso va chiamato dopo il layout; ritentiamo come per l'audio remoto */
        const tryLocalPlay = () => {
          if (!localPreview || !localPreview.srcObject) return;
          localPreview.muted = true;
          localPreview.play().catch(() => {});
        };
        tryLocalPlay();
        requestAnimationFrame(tryLocalPlay);
        [100, 200, 400, 800].forEach((ms) => setTimeout(tryLocalPlay, ms));
      }
      const videoBtn = callUI && callUI.querySelector(".btn.video");
      if (videoBtn) videoBtn.classList.add("active");
      const blurBtn = callUI && callUI.querySelector(".btn.blur");
      if (blurBtn) blurBtn.classList.toggle("active", videoBlurOn);
      if (localPreview) localPreview.classList.toggle("diskuz-call-preview-blurred", videoBlurOn);
      updateVideoLayout();
      updateVideoButtonVisibility();
      if (typeof applyVideoEffectsToSentStream === "function") {
        applyVideoEffectsToSentStream(mirrorCb && mirrorCb.checked, videoBlurOn);
      }
      showToast(isIt ? "Video avviato." : "Video started.");
      currentVideoFacingMode = "user";
      if (callUI._updateSwitchCameraButton) callUI._updateSwitchCameraButton();
    } catch (e) {
      logWarn("enableVideo failed", e);
      if (wrap) wrap.style.display = "none";
      callUI.classList.remove("diskuz-call-video-active");
      showToast(isIt ? "Impossibile attivare la videocamera." : "Could not enable camera.");
    } finally {
      videoRequestInProgress = false;
    }
  }

  async function switchCamera() {
    if (!isMobileDevice() || !localVideoOn || !rtcPeer || !currentCall || !currentCall.userId || videoRequestInProgress) return;
    const localPreview = callUI && callUI.querySelector(".diskuz-call-local-preview");
    const mirrorCb = callUI && callUI.querySelector(".diskuz-call-video-mirror-cb");
    const isIt = document.documentElement.lang === "it";
    const newFacing = currentVideoFacingMode === "user" ? "environment" : "user";
    const isAndroid = /Android/i.test(navigator.userAgent);
    const videoOpt = {
      facingMode: { exact: newFacing },
      width: { ideal: 1920, min: isAndroid ? 1920 : 640 },
      height: { ideal: 1080, min: isAndroid ? 1080 : 480 },
      frameRate: { ideal: 30, min: 24 },
    };
    videoRequestInProgress = true;
    try {
      let newStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({ video: videoOpt });
      } catch (err) {
        if (isAndroid && err.name === "OverconstrainedError") {
          newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: newFacing }, width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 }, frameRate: { ideal: 30 } },
          });
        } else {
          throw err;
        }
      }
      let newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) {
        newStream.getTracks().forEach((t) => t.stop());
        showToast(isIt ? "Nessun track video." : "No video track.");
        return;
      }
      if (newTrack.getCapabilities && newTrack.applyConstraints && isAndroid) {
        try {
          const cap = newTrack.getCapabilities();
          const w = (cap.width && cap.width.max) ? Math.min(1920, cap.width.max) : 1920;
          const h = (cap.height && cap.height.max) ? Math.min(1080, cap.height.max) : 1080;
          await newTrack.applyConstraints({ width: w, height: h, frameRate: { ideal: 30 } });
        } catch (e) {}
      }
      if (localVideoTrack) {
        localVideoTrack.stop();
        if (rtcLocalStream) rtcLocalStream.removeTrack(localVideoTrack);
      }
      rtcLocalStream.addTrack(newTrack);
      localVideoTrack = newTrack;
      currentVideoFacingMode = newFacing;
      if (localPreview) {
        localPreview.srcObject = new MediaStream([newTrack]);
        localPreview.style.transform = (mirrorCb && mirrorCb.checked) ? "scaleX(-1)" : "none";
        const tryPlay = () => { if (localPreview && localPreview.srcObject) localPreview.play().catch(() => {}); };
        tryPlay();
        requestAnimationFrame(tryPlay);
      }
      const sender = rtcPeer.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender && typeof applyVideoEffectsToSentStream === "function") {
        await applyVideoEffectsToSentStream(mirrorCb && mirrorCb.checked, videoBlurOn);
      } else if (sender) {
        await sender.replaceTrack(newTrack);
        await sendVideoRenegotiation();
      }
      if (callUI._updateSwitchCameraButton) callUI._updateSwitchCameraButton();
      showToast(isIt ? (newFacing === "environment" ? "Retrocamera attiva." : "Frontale attiva.") : (newFacing === "environment" ? "Rear camera on." : "Front camera on."));
    } catch (e) {
      logWarn("switchCamera failed", e);
      showToast(isIt ? "Impossibile usare l'altra fotocamera." : "Could not switch camera.");
    } finally {
      videoRequestInProgress = false;
    }
  }

  /** Imposta bitrate massimo e nessun downscale sul sender video (qualità origine/massima) */
  async function setVideoSenderHighQuality() {
    if (!rtcPeer) return;
    const sender = rtcPeer.getSenders().find((s) => s.track && s.track.kind === "video");
    if (!sender || !sender.getParameters) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = 8000000; // 8 Mbps per qualità massima (1080p+)
      if (params.encodings[0].scaleResolutionDownBy !== undefined) params.encodings[0].scaleResolutionDownBy = 1;
      await sender.setParameters(params);
    } catch (e) {}
  }

  async function sendVideoRenegotiation() {
    if (!rtcPeer || !currentCall.userId || !window.DiskuzCallSend) return;
    try {
      await setVideoSenderHighQuality();
      const offer = await rtcPeer.createOffer();
      await rtcPeer.setLocalDescription(offer);
      const sdpPayload = serializeSdp(rtcPeer.localDescription);
      if (sdpPayload) {
        await window.DiskuzCallSend({
          type: "video_offer",
          to_user_id: currentCall.userId,
          from_user_id: null,
          sdp: sdpPayload,
        });
      }
    } catch (e) {
      logWarn("video renegotiation failed", e);
    }
  }

  async function applyVideoEffectsToSentStream(mirrorOn, blurOn) {
    if (!rtcPeer || !currentCall.userId || !window.DiskuzCallSend) return;
    const sender = rtcPeer.getSenders().find((s) => s.track && s.track.kind === "video");
    if (!sender) return;
    const srcVideo = callUI && callUI.querySelector(".diskuz-call-local-preview");
    if (!srcVideo || !srcVideo.srcObject) return;

    if (mirrorDrawLoopId != null) {
      cancelAnimationFrame(mirrorDrawLoopId);
      mirrorDrawLoopId = null;
    }
    if (mirrorCanvasStream) {
      mirrorCanvasStream.getTracks().forEach((t) => t.stop());
      mirrorCanvasStream = null;
    }

    /* Su iOS Safari canvas.captureStream() non funziona con WebRTC (stream nero/bug WebKit): blur disabilitato */
    const useEffects = (mirrorOn || (blurOn && !isIOS())) && localVideoTrack;
    if (useEffects) {
      /* Su mobile il video può avere videoWidth/videoHeight 0 all'inizio: aspetta fino a 600ms che siano disponibili */
      let w = srcVideo.videoWidth || 0;
      let h = srcVideo.videoHeight || 0;
      if (w <= 0 || h <= 0) {
        const deadline = Date.now() + 600;
        while ((w = srcVideo.videoWidth || 0) <= 0 || (h = srcVideo.videoHeight || 0) <= 0) {
          if (Date.now() >= deadline) break;
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (w <= 0) w = 640;
        if (h <= 0) h = 480;
      }
      if (!mirrorCanvasEl) {
        mirrorCanvasEl = document.createElement("canvas");
        mirrorCanvasEl.width = w;
        mirrorCanvasEl.height = h;
      } else {
        mirrorCanvasEl.width = w;
        mirrorCanvasEl.height = h;
      }
      const ctx = mirrorCanvasEl.getContext("2d");
      if (!ctx) return;
      mirrorCanvasStream = mirrorCanvasEl.captureStream(30);
      const canvasTrack = mirrorCanvasStream.getVideoTracks()[0];
      if (!canvasTrack) return;
      let firstFrameDrawn = false;
      function drawEffects() {
        if (!mirrorCanvasEl || !srcVideo || !srcVideo.srcObject) return;
        if (srcVideo.videoWidth > 0 && srcVideo.videoHeight > 0) {
          if (mirrorCanvasEl.width !== srcVideo.videoWidth || mirrorCanvasEl.height !== srcVideo.videoHeight) {
            mirrorCanvasEl.width = srcVideo.videoWidth;
            mirrorCanvasEl.height = srcVideo.videoHeight;
          }
          ctx.save();
          if (blurOn) ctx.filter = "blur(12px)";
          if (mirrorOn) ctx.scale(-1, 1);
          ctx.drawImage(srcVideo, mirrorOn ? -mirrorCanvasEl.width : 0, 0, mirrorCanvasEl.width, mirrorCanvasEl.height);
          ctx.restore();
          firstFrameDrawn = true;
        }
        mirrorDrawLoopId = requestAnimationFrame(drawEffects);
      }
      drawEffects();
      /* Su mobile aspetta almeno un frame disegnato prima di sostituire il track */
      const waitFirstFrame = new Promise((resolve) => {
        const check = () => {
          if (firstFrameDrawn) return resolve();
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      const timeout = new Promise((r) => setTimeout(r, 800));
      await Promise.race([waitFirstFrame, timeout]);
      await sender.replaceTrack(canvasTrack);
    } else {
      await sender.replaceTrack(localVideoTrack);
    }
    await sendVideoRenegotiation();
  }

  async function applyMirrorToSentStream(mirrorOn) {
    await applyVideoEffectsToSentStream(mirrorOn, videoBlurOn);
  }

  async function disableVideo() {
    if (!rtcPeer || !currentCall.userId || !window.DiskuzCallSend) return;
    // Notify peer first so they show placeholder immediately (avoid black frame)
    window.DiskuzCallSend({ type: "video_paused", to_user_id: currentCall.userId }).catch(() => {});
    if (mirrorDrawLoopId != null) {
      cancelAnimationFrame(mirrorDrawLoopId);
      mirrorDrawLoopId = null;
    }
    if (mirrorCanvasStream) {
      mirrorCanvasStream.getTracks().forEach((t) => t.stop());
      mirrorCanvasStream = null;
    }
    const sender = rtcPeer.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) {
      await sender.replaceTrack(null);
      const offer = await rtcPeer.createOffer();
      await rtcPeer.setLocalDescription(offer);
      const sdpPayload = serializeSdp(offer);
      if (sdpPayload) {
        window.DiskuzCallSend({
          type: "video_offer",
          to_user_id: currentCall.userId,
          from_user_id: null,
          sdp: sdpPayload,
        }).catch(() => {});
      }
    }
    if (localVideoTrack) {
      localVideoTrack.stop();
      if (rtcLocalStream) rtcLocalStream.removeTrack(localVideoTrack);
      localVideoTrack = null;
    }
    localVideoOn = false;
    currentVideoFacingMode = "user";
    const localPreview = callUI && callUI.querySelector(".diskuz-call-local-preview");
    if (localPreview) localPreview.srcObject = null;
    const videoBtn = callUI && callUI.querySelector(".btn.video");
    if (videoBtn) videoBtn.classList.remove("active");
    videoBlurOn = false;
    const blurBtn = callUI && callUI.querySelector(".btn.blur");
    if (blurBtn) blurBtn.classList.remove("active");
    const localPrev = callUI && callUI.querySelector(".diskuz-call-local-preview");
    if (localPrev) localPrev.classList.remove("diskuz-call-preview-blurred");
    if (callUI._updateSwitchCameraButton) callUI._updateSwitchCameraButton();
    updateVideoLayout();
    updateVideoButtonVisibility();
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
      logError("Media permission denied", e);
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
      if (callUI) {
        if (connState === "connected") {
          callUI.classList.add("diskuz-call-connected");
          callUI.classList.remove("diskuz-call-outgoing-ringing");
          /* Chiamata solo voce: dopo 1 minuto attiva Ear mode automaticamente */
          if (!callUI.classList.contains("diskuz-call-video-active")) {
            if (earModeAutoTimerId) clearTimeout(earModeAutoTimerId);
            earModeAutoTimerId = setTimeout(function () {
              earModeAutoTimerId = null;
              if (callUI && callUI.classList.contains("diskuz-call-connected") && !callUI.classList.contains("diskuz-call-video-active") && typeof activateEarMode === "function") {
                activateEarMode();
              }
            }, 60000);
          }
        } else {
          callUI.classList.remove("diskuz-call-connected");
          if (earModeAutoTimerId) {
            clearTimeout(earModeAutoTimerId);
            earModeAutoTimerId = null;
          }
        }
      }
      if (connState === "connected" && !callDurationIntervalId && callConnectedAt == null) {
        callConnectedAt = Date.now();
        startCallDurationTimer();
      }
      if (connState === "connected" && rtcRemoteAudio && rtcRemoteAudio.srcObject) {
        rtcRemoteAudio.muted = false;
        applySpeakerSink();
        scheduleRemoteAudioPlayRetries();
      }
      if (connState === "connected" && localVideoOn && typeof setVideoSenderHighQuality === "function") {
        setVideoSenderHighQuality();
      }
      updateVideoButtonVisibility();
    };
    rtcPeer.oniceconnectionstatechange = () => {
      const state = rtcPeer?.iceConnectionState;
      log("[*] ICE connection state:", state);
      if ((state === "connected" || state === "completed") && !callDurationIntervalId) {
        if (callConnectedAt == null) callConnectedAt = Date.now();
        startCallDurationTimer();
      }
      if (state === "failed") {
        log("[*] ICE failed – connection could not be established");
        showToast("Connection failed. Please try again.");
        endCurrentCall("failed");
      }
    };

    /* Coda invio ICE: evita 429 (Too Many Requests) inviando un candidato ogni ICE_SEND_INTERVAL_MS invece che uno per evento. */
    const ICE_SEND_INTERVAL_MS = 300;
    let iceSendQueue = [];
    let iceSendTimer = null;
    function flushIceSendQueue() {
      if (iceSendQueue.length === 0) {
        iceSendTimer = null;
        return;
      }
      const candidate = iceSendQueue.shift();
      if (window.DiskuzCallSend) {
        log("[*] onicecandidate: sending ICE to userId", targetUserId, "(queue remaining:", iceSendQueue.length, ")");
        window.DiskuzCallSend({
          type: "ice_candidate",
          to_user_id: targetUserId,
          candidate,
        }).catch((err) => {
          logWarn("ICE send failed (will not retry this candidate)", err);
        });
      }
      if (iceSendQueue.length > 0) iceSendTimer = setTimeout(flushIceSendQueue, ICE_SEND_INTERVAL_MS);
      else iceSendTimer = null;
    }
    rtcPeer.onicecandidate = (event) => {
      if (event.candidate && window.DiskuzCallSend) {
        const candidate =
          typeof event.candidate.toJSON === "function"
            ? event.candidate.toJSON()
            : event.candidate;
        iceSendQueue.push(candidate);
        if (!iceSendTimer) iceSendTimer = setTimeout(flushIceSendQueue, 0);
      }
    };

    function scheduleRemoteAudioPlayRetries() {
      if (!rtcRemoteAudio || !rtcRemoteAudio.srcObject) return;
      rtcRemoteAudio.muted = false;
      if (typeof applyRemoteAudioVolumeForCallType === "function") applyRemoteAudioVolumeForCallType();
      const tryPlay = () => {
        if (!rtcRemoteAudio || !rtcRemoteAudio.srcObject) return;
        rtcRemoteAudio.muted = false;
        rtcRemoteAudio.play().catch((err) => {
          log("[*] remote audio play() retry failed", err);
        });
      };
      tryPlay();
      [150, 400, 800, 1500, 2500].forEach((ms) => setTimeout(tryPlay, ms));
    }

    rtcPeer.ontrack = (event) => {
      const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
      if (event.track.kind === "audio" && rtcRemoteAudio) {
        rtcRemoteAudio.srcObject = stream;
        rtcRemoteAudio.muted = false;
        if (typeof applyRemoteAudioVolumeForCallType === "function") applyRemoteAudioVolumeForCallType();
        applySpeakerSink();
        scheduleRemoteAudioPlayRetries();
        if (callConnectedAt == null && !callDurationIntervalId) {
          callConnectedAt = Date.now();
          startCallDurationTimer();
        }
      }
      if (event.track.kind === "video" && callUI) {
        rtcRemoteVideoStream = stream;
        const videoEl = callUI.querySelector(".diskuz-call-remote-video");
        if (videoEl) {
          videoEl.setAttribute("playsinline", "true");
          videoEl.setAttribute("webkit-playsinline", "true");
          videoEl.playsInline = true;
          videoEl.autoplay = true;
          videoEl.muted = false;
          videoEl.classList.remove("diskuz-call-remote-video-fade-in");
          videoEl.srcObject = stream;
          videoEl.classList.add("diskuz-call-remote-video-fade-in");
          const updateRemoteVideoOrientation = () => {
            if (!callUI || !videoEl) return;
            const w = videoEl.videoWidth || 0;
            const h = videoEl.videoHeight || 0;
            callUI.classList.remove("diskuz-call-remote-video-landscape", "diskuz-call-remote-video-portrait");
            if (w > 0 && h > 0) {
              callUI.classList.add(w >= h ? "diskuz-call-remote-video-landscape" : "diskuz-call-remote-video-portrait");
            }
          };
          videoEl.addEventListener("loadedmetadata", updateRemoteVideoOrientation);
          videoEl.addEventListener("resize", updateRemoteVideoOrientation);
          [100, 300, 600, 1200].forEach((ms) => setTimeout(updateRemoteVideoOrientation, ms));
          /* Polling: quando lo smartphone ruota (portrait→landscape) il resize può non arrivare; aggiorniamo la classe periodicamente */
          let lastW = 0;
          let lastH = 0;
          const orientationPollId = setInterval(() => {
            if (!callUI || !videoEl || !videoEl.srcObject) return;
            const w = videoEl.videoWidth || 0;
            const h = videoEl.videoHeight || 0;
            if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
              lastW = w;
              lastH = h;
              updateRemoteVideoOrientation();
            }
          }, 500);
          videoEl._remoteOrientationPollId = orientationPollId;
          const tryRemotePlay = () => {
            if (!videoEl || !videoEl.srcObject) return;
            videoEl.play().catch(() => {});
          };
          tryRemotePlay();
          [100, 300, 600, 1200].forEach((ms) => setTimeout(tryRemotePlay, ms));
        }
        remoteVideoActive = true;
        if (typeof updateVideoLayout === "function") updateVideoLayout();
        event.track.onended = () => {
          const el = callUI && callUI.querySelector(".diskuz-call-remote-video");
          if (el && el._remoteOrientationPollId) clearInterval(el._remoteOrientationPollId);
          remoteVideoActive = false;
          if (typeof updateVideoLayout === "function") updateVideoLayout();
        };
        event.track.onmute = () => {
          syncRemoteVideoState();
          if (typeof updateVideoLayout === "function") updateVideoLayout();
        };
        event.track.onunmute = () => {
          syncRemoteVideoState();
          if (typeof updateVideoLayout === "function") updateVideoLayout();
        };
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
        sendPromise
          .then(
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
          )
          .catch((err) => {
            const reason = getSignalErrorReason(err);
            const msg = messageForSignalReason(reason, currentCall.username);
            clearOutgoingCallTimeout();
            endCurrentCall("rejected");
            showWidgetErrorFromCall(msg);
          });
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
        logError("Error adding queued ICE candidate", err);
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
      }).catch((e) => logWarn("call_answer send failed", e));
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
        logError("Caller: error adding queued ICE candidate", err);
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
        logError("Error adding ICE candidate", e);
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
    if (callConnectedAt == null) return;
    stopCallDurationTimer();
    const el = callUI && callUI.querySelector(".duration");
    if (!el) return;
    function tick() {
      if (!callConnectedAt) return;
      const sec = Math.floor((Date.now() - callConnectedAt) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      const timeStr = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
      el.textContent = timeStr;
    }
    tick();
    callDurationIntervalId = setInterval(tick, 1000);
  }

  function stopCallDurationTimer() {
    if (callDurationIntervalId) {
      clearInterval(callDurationIntervalId);
      callDurationIntervalId = null;
    }
  }

  function resetCallDurationDisplay() {
    callConnectedAt = null;
    const el = callUI && callUI.querySelector(".duration");
    if (el) el.textContent = "00:00";
  }

  function rtcEnd() {
    stopCallDurationTimer();
    resetCallDurationDisplay();
    if (localVideoTrack) {
      localVideoTrack.stop();
      if (rtcLocalStream) rtcLocalStream.removeTrack(localVideoTrack);
      localVideoTrack = null;
    }
    localVideoOn = false;
    remoteVideoActive = false;
    remoteVideoPausedByPeer = false;
    if (callUI) {
      const wrap = callUI.querySelector(".diskuz-call-video-wrap");
      const remoteV = callUI.querySelector(".diskuz-call-remote-video");
      const localP = callUI.querySelector(".diskuz-call-local-preview");
      const fsBtn = callUI.querySelector(".diskuz-call-fullscreen-btn");
      if (wrap) wrap.style.display = "none";
      if (remoteV) remoteV.srcObject = null;
      if (localP) localP.srcObject = null;
      if (fsBtn) fsBtn.style.display = "none";
      callUI.classList.remove("diskuz-call-video-active", "diskuz-call-remote-video-active", "diskuz-call-preview-only", "diskuz-call-remote-video-landscape", "diskuz-call-remote-video-portrait", "diskuz-call-fullscreen-active");
      if (document.body) document.body.classList.remove("diskuz-call-ios-fullscreen-fallback");
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl === callUI || (callUI && fsEl === callUI.querySelector(".diskuz-call-remote-video"))) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.().call(document);
      }
    }
    if (rtcPeer) {
      rtcPeer.close();
      rtcPeer = null;
    }
    videoRenegotiationPromise = Promise.resolve();
    rtcRemoteVideoStream = null;
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
    stopOutgoingRingback();
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
      const wasOutgoing = currentCall.direction === "outgoing";
      const neverConnected = callConnectedAt == null;
      const noAnswer = (result === "ended" || result === "no_answer") && wasOutgoing && neverConnected;
      window.DiskuzCallSend({
        type: "call_end",
        to_user_id: currentCall.userId,
        reason: noAnswer ? "no_answer" : undefined,
      }).catch(() => {});
    }
    rtcEnd();
    resetCurrentCall();
    closeCallUI();
  }

  /* Desktop: in background/altro tab non terminare mai il flusso video (no track/stream/RTC).
     Opzionale: se il browser lo consente, apri PiP sul video in ingresso (solo display). Dopo 60 s in background si chiude la chiamata. */
  const DESKTOP_BACKGROUND_END_CALL_MS = 60000;
  document.addEventListener("visibilitychange", function () {
    if (isMobileDevice()) return;
    if (document.visibilityState === "visible") {
      if (desktopBackgroundEndCallTimeoutId) {
        clearTimeout(desktopBackgroundEndCallTimeoutId);
        desktopBackgroundEndCallTimeoutId = null;
      }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(function () {});
      }
      return;
    }
    if (document.visibilityState !== "hidden" || !currentCall.active) return;
    if (document.pictureInPictureEnabled && !document.pictureInPictureElement && callUI) {
      const remoteVideoEl = callUI.querySelector(".diskuz-call-remote-video");
      if (remoteVideoEl && remoteVideoEl.srcObject) {
        setTimeout(function () {
          if (!currentCall.active || document.visibilityState !== "hidden") return;
          remoteVideoEl.requestPictureInPicture().then(function () {
            log("[diskuz-call] Desktop: PiP opened");
          }).catch(function () {});
        }, 300);
      }
    }
    if (desktopBackgroundEndCallTimeoutId) return;
    desktopBackgroundEndCallTimeoutId = setTimeout(function () {
      desktopBackgroundEndCallTimeoutId = null;
      if (!currentCall.active) return;
      if (document.visibilityState !== "hidden") return;
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
      log("[diskuz-call] Desktop: still in background after 60s, ending call");
      endCurrentCall("ended");
    }, DESKTOP_BACKGROUND_END_CALL_MS);
  });

  document.addEventListener("freeze", function () {
    if (!currentCall.active) return;
    log("[diskuz-call] Page frozen (standby/lock/suspend), ending call");
    endCurrentCall("ended");
  });

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

    startOutgoingRingback();

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
        }).catch(() => {});
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
        }).catch(() => {});
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
      window.DiskuzCallSend({ type: "call_ringing", to_user_id: data.from_user_id }).catch(() => {});
    }
  }

  function showIncomingCallUI(username, avatarTemplate) {
    createCallUI();
    /* Incoming: parte sempre con icona microfono attiva */
    const muteBtn = callUI && callUI.querySelector(".mute");
    if (muteBtn) {
      muteBtn.classList.remove("active");
      muteBtn.setAttribute("aria-pressed", "false");
    }
    if (rtcLocalStream) {
      rtcLocalStream.getAudioTracks().forEach((t) => (t.enabled = true));
    }
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
    acceptBtn.setAttribute("type", "button");
    acceptBtn.setAttribute("aria-label", "Accept");
    acceptBtn.innerHTML = "<span class=\"diskuz-call-incoming-icon diskuz-call-icon-accept\" aria-hidden=\"true\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z\"/><path d=\"M22 2l-4 4 4 4\"/></svg></span>";
    acceptBtn.style.flex = "1";
    acceptBtn.style.padding = "10px 14px";
    acceptBtn.style.borderRadius = "15px";
    acceptBtn.style.color = "#fff";
    acceptBtn.style.cursor = "pointer";
    acceptBtn.style.fontSize = "14px";

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "diskuz-reject-btn";
    rejectBtn.setAttribute("type", "button");
    rejectBtn.setAttribute("aria-label", "Reject");
    rejectBtn.innerHTML = "<span class=\"diskuz-call-incoming-icon diskuz-call-icon-reject\" aria-hidden=\"true\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z\"/></svg></span>";
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

    ensureFullyShown(callUI);
    callUI.style.display = "block";
    callUI.classList.remove("diskuz-call-minimized");

    if (!isMobileDevice()) {
      widgetWasOpenBeforeCall = !!(widget && widget.classList.contains("open"));
      loadWidgetRectFromStorage();
      if (widget) {
        if (widgetWasOpenBeforeCall) captureWidgetRect();
        ensureFullyHidden(widget);
      }
      if (!lastWidgetRect || lastWidgetRect.width <= 0) {
        lastWidgetRect = getDefaultWidgetRect();
        saveWidgetRectToStorage();
      }
      applyWidgetRectToCallUI();
      updateBodyScrollLock();
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
      }).catch(() => {});
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

  /* --- MESSAGEBUS: sottoscrizione in UI se il glue non ha ancora sottoscritto (es. ordine di caricamento) --- */
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
    log("MessageBus subscribed to /diskuz-call/signals");
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
          stopOutgoingRingback();
          currentCall.isRinging = false;
          if (callUI) callUI.classList.remove("diskuz-call-incoming-ringing");
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
        updateVideoButtonVisibility();
        break;

      case "call_reject":
        if (
          currentCall.active &&
          currentCall.direction === "outgoing" &&
          currentCall.userId === data.from_user_id
        ) {
          clearOutgoingCallTimeout();
          stopOutgoingRingback();
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
          if (currentCall.direction === "outgoing") stopOutgoingRingback();
          if (currentCall.direction === "incoming") stopIncomingRing();
          const wasConnected = callConnectedAt != null;
          const durationSeconds = wasConnected ? Math.floor((Date.now() - callConnectedAt) / 1000) : null;
          const resultForCallee = (currentCall.direction === "incoming" && !wasConnected) ? "missed" : "ended";
          addHistoryEntry({
            direction: currentCall.direction || "incoming",
            result: resultForCallee,
            username: currentCall.username || "Unknown",
            durationSeconds,
          });
          showToast(wasConnected ? "Call ended." : (document.documentElement.lang === "it" ? "Chiamata persa." : "Missed call."));
          rtcEnd();
          resetCurrentCall();
          closeCallUI();
        }
        break;

      case "ice_candidate":
        rtcHandleIce(data);
        break;

      case "video_paused":
        if (currentCall.active && currentCall.userId === data.from_user_id) {
          remoteVideoPausedByPeer = true;
          if (typeof updateVideoLayout === "function") updateVideoLayout();
        }
        break;

      case "video_resumed":
        if (currentCall.active && currentCall.userId === data.from_user_id) {
          remoteVideoPausedByPeer = false;
          if (typeof updateVideoLayout === "function") updateVideoLayout();
        }
        break;

      case "video_offer": {
        const videoSdp = data.sdp ?? (data.payload && data.payload.sdp);
        if (!currentCall.active || !rtcPeer || !videoSdp) break;
        if (currentCall.userId !== data.from_user_id) break;
        const run = async () => {
          try {
            if (rtcPeer.signalingState === "have-local-offer") {
              log("video_offer: rollback local offer to process peer offer (glare)");
              await rtcPeer.setLocalDescription({ type: "rollback" });
            }
            const desc = new RTCSessionDescription(
              typeof videoSdp === "object" && videoSdp !== null && "type" in videoSdp && "sdp" in videoSdp
                ? videoSdp
                : { type: "offer", sdp: String(videoSdp) }
            );
            await rtcPeer.setRemoteDescription(desc);
            remoteVideoPausedByPeer = false;
            if (typeof updateVideoLayout === "function") {
              updateVideoLayout();
              setTimeout(updateVideoLayout, 150);
            }
            if (rtcPeer.signalingState !== "have-remote-offer") {
              log("video_offer: skip createAnswer, signalingState is", rtcPeer.signalingState);
              return;
            }
            const answer = await rtcPeer.createAnswer();
            await rtcPeer.setLocalDescription(answer);
            const sdpPayload = serializeSdp(answer);
            if (sdpPayload && typeof window.DiskuzCallSend === "function") {
              await window.DiskuzCallSend({
                type: "video_answer",
                to_user_id: data.from_user_id,
                from_user_id: null,
                sdp: sdpPayload,
              });
              showToast(document.documentElement.lang === "it" ? "Video ricevuto, risposta inviata." : "Video received, answer sent.");
            }
          } catch (err) {
            logWarn("video_offer handling failed", err);
            showToast(document.documentElement.lang === "it" ? "Errore negoziazione video." : "Video negotiation error.");
          }
        };
        videoRenegotiationPromise = videoRenegotiationPromise.then(run, run);
        break;
      }

      case "video_answer": {
        const videoSdp = data.sdp ?? (data.payload && data.payload.sdp);
        if (!currentCall.active || !rtcPeer || !videoSdp) break;
        if (currentCall.userId !== data.from_user_id) break;
        if (rtcPeer.signalingState !== "have-local-offer") {
          log("video_answer: skip, signalingState is", rtcPeer.signalingState, "(expected have-local-offer)");
          break;
        }
        (async () => {
          try {
            const desc = new RTCSessionDescription(
              typeof videoSdp === "object" && videoSdp !== null && "type" in videoSdp && "sdp" in videoSdp
                ? videoSdp
                : { type: "answer", sdp: String(videoSdp) }
            );
            await rtcPeer.setRemoteDescription(desc);
            if (typeof updateVideoLayout === "function") {
              updateVideoLayout();
              setTimeout(updateVideoLayout, 150);
            }
            showToast(document.documentElement.lang === "it" ? "Video connesso." : "Video connected.");
          } catch (err) {
            logWarn("video_answer handling failed", err);
            showToast(document.documentElement.lang === "it" ? "Errore risposta video." : "Video answer error.");
          }
        })();
        break;
      }

      default:
        break;
    }
  });

  function toggleWidget() {
    if (!widget) return;

    if (widget.classList.contains("open")) {
      if (!isMobileDevice()) {
        captureWidgetRect();
        vortexCloseDesktop(widget, function () {
          widget.classList.remove("open");
          ensureFullyHidden(widget);
          updateBodyScrollLock();
          setTimeout(captureWidgetRect, 50);
        });
      } else {
        widget.style.display = "none";
        widget.classList.remove("open");
        ensureFullyHidden(widget);
        setTimeout(function () {
          updateBodyScrollLock();
        }, 200);
      }
    } else {
      showWidgetPage(WIDGET_PAGE_HOME);
      if (!isMobileDevice()) loadWidgetRectFromStorage();
      if (!lastWidgetRect || lastWidgetRect.width <= 0) {
        lastWidgetRect = getDefaultWidgetRect();
        saveWidgetRectToStorage();
      }
      applyLastRectToWidget();
      ensureFullyShown(widget);
      widget.style.display = "block";
      updateBodyScrollLock();
      setTimeout(function () {
        widget.classList.add("open");
        if (!isMobileDevice()) {
          requestAnimationFrame(function () {
            vortexOpenDesktop(widget);
            setTimeout(captureWidgetRect, VORTEX_DURATION_MS + 50);
          });
        }
        if (isMobileDevice()) setTimeout(captureWidgetRect, 50);
      }, 10);
    }
  }

  function toggleWidgetForceClose() {
    if (!widget) return;
    if (!isMobileDevice()) {
      captureWidgetRect();
      vortexCloseDesktop(widget, function () {
        widget.classList.remove("open");
        ensureFullyHidden(widget);
        updateBodyScrollLock();
      });
    } else {
      widget.style.display = "none";
      widget.classList.remove("open");
      ensureFullyHidden(widget);
      setTimeout(function () {
        updateBodyScrollLock();
      }, 200);
    }
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
        window.DiskuzCallVideoAllowed = !!(data.video_allowed === true);
        window.DiskuzCallCustomRingtoneUrl = (data.custom_ringtone_url != null && data.custom_ringtone_url !== "") ? String(data.custom_ringtone_url).trim() : "";
        window.DiskuzCallCustomRingtones = Array.isArray(data.custom_ringtones) ? data.custom_ringtones : [];
        window.DiskuzCallSelectedCustomRingtoneIndex = data.selected_custom_ringtone_index != null ? data.selected_custom_ringtone_index : null;
        window.DiskuzCallAlternativeRingtone = (data.alternative_ringtone != null && String(data.alternative_ringtone).trim() !== "") ? String(data.alternative_ringtone).trim() : "soft";
        if (Array.isArray(data.ice_servers) && data.ice_servers.length > 0) window.DiskuzCallIceServers = data.ice_servers;
        if (data.primary_color && /^#[0-9a-fA-F]{6}$/.test(data.primary_color)) {
          document.documentElement.style.setProperty("--diskuz-call-primary", data.primary_color);
        }
        if (data.primary_color_dark && /^#[0-9a-fA-F]{6}$/.test(data.primary_color_dark)) {
          document.documentElement.style.setProperty("--diskuz-call-primary-dark", data.primary_color_dark);
        }
        window.DiskuzCallDebugLog = data.debug_log === true;
        subscribeMessageBus();
        loadHistory();
        try {
          const savedStatus = window.localStorage.getItem(STATUS_KEY);
          if (savedStatus === "busy" || savedStatus === "not_available" || savedStatus === "available") callStatus = savedStatus;
        } catch (e) {}
        createFloatingButton();
        createWidget();
        if (data.incoming_sound === "custom" && window.DiskuzCallCustomRingtones.length > 0) {
          updateCustomRingtonesUI(window.DiskuzCallCustomRingtones, window.DiskuzCallSelectedCustomRingtoneIndex);
        }
        loadWidgetRectFromStorage();
        if (!isMobileDevice()) applyLastRectToWidget();
        updateNotificationsBadge();
        updateCallFeatureVisibility();
        onceDocumentInteractionForAudio();
        /* Apri il widget se l'utente è arrivato cliccando su una notifica diskuz-call (customUrl con ?diskuz_call=...) */
        try {
          const urlParams = new URLSearchParams(window.location.search);
          const diskuzCall = urlParams.get("diskuz_call");
          const diskuzCallTab = urlParams.get("diskuz_call_tab");
          if ((diskuzCall === "incoming" || diskuzCall === "notifications") && widget && !widget.classList.contains("open")) {
            toggleWidget();
            showWidgetPage(WIDGET_PAGE_NOTIFICATIONS);
            const tab = diskuzCall === "incoming" ? "received" : (diskuzCallTab === "missed" || diskuzCallTab === "received" || diskuzCallTab === "sent" || diskuzCallTab === "recent" ? diskuzCallTab : "received");
            notificationsTab = tab;
            widget.querySelectorAll(".diskuz-widget-page-notifications .diskuz-ntab").forEach((b) => {
              b.classList.toggle("active", b.getAttribute("data-tab") === notificationsTab);
            });
            renderHistoryList();
            const u = new URL(window.location.href);
            u.searchParams.delete("diskuz_call");
            u.searchParams.delete("diskuz_call_tab");
            window.history.replaceState({}, "", u.pathname + (u.search ? "?" + u.searchParams.toString() : "") || "/");
          }
        } catch (e) {}
        /* Nascondi il pulsante Call quando il composer (nuovo post / risposta) è aperto */
        let composerCheckScheduled = false;
        function scheduleComposerCheck() {
          if (composerCheckScheduled) return;
          composerCheckScheduled = true;
          requestAnimationFrame(function () {
            composerCheckScheduled = false;
            updateFloatingButtonForComposer();
          });
        }
        const composerObserver = new MutationObserver(scheduleComposerCheck);
        composerObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
        document.addEventListener("visibilitychange", updateFloatingButtonForComposer);
        /* Mobile: adatta UI quando il telefono è in orizzontale; torna standard in verticale */
        function updateMobileOrientationClass() {
          if (!isMobileDevice()) return;
          const landscape = window.innerWidth > window.innerHeight;
          if (callUI) callUI.classList.toggle("diskuz-call-mobile-landscape", landscape);
          if (widget) widget.classList.toggle("diskuz-call-mobile-landscape", landscape);
          if (callUI && typeof callUI._setControlsToggleLabel === "function") callUI._setControlsToggleLabel();
        }
        window.addEventListener("orientationchange", updateMobileOrientationClass);
        window.addEventListener("resize", updateMobileOrientationClass);
        updateMobileOrientationClass();
      })
      .catch(() => {
        log("initPage: status check failed, plugin not loaded");
      });
  }

  api.onPageChange(initPage);
  initPage();

  /* Notifiche Discourse (campanella): rendering corretto per "chiamata in arrivo" (icona + descrizione). Discourse 2026 usa registerNotificationTypeRenderer con chiave "custom" e classe che estende la base. */
  withPluginApi("1.0.0", (pluginApi) => {
    const register = pluginApi.registerNotificationTypeRenderer;
    if (typeof register !== "function") return;
    function parseData(notification) {
      const raw = notification?.data;
      if (raw == null) return {};
      if (typeof raw === "object") return raw;
      try {
        return typeof raw === "string" ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    }
    function missedCallText(field) {
      const lang = typeof document !== "undefined" && document.documentElement ? document.documentElement.lang : "en";
      if (field === "title") return lang === "it" ? "Chiamata persa" : "Missed call";
      return lang === "it" ? "Chiamata persa" : "Missed a call";
    }
    register("custom", (NotificationTypeBase) => {
      return class DiskuzCallCustomNotificationRenderer extends NotificationTypeBase {
        get _data() {
          return parseData(this.notification);
        }
        get linkHref() {
          const url = this._data.customUrl;
          return url || super.linkHref;
        }
        get linkTitle() {
          const d = this._data;
          if (d.diskuz_call_missed || d.diskuzCallMissed) return missedCallText("title");
          return d.customTranslatedTitle || d.customMessage || super.linkTitle;
        }
        get icon() {
          return this._data.customIcon || "phone";
        }
        get label() {
          const d = this._data;
          if (d.display_username) return d.display_username;
          if (d.username) return d.username;
          return super.label;
        }
        get description() {
          const d = this._data;
          const isMissed = d.diskuz_call_missed || d.diskuzCallMissed;
          let msg;
          if (isMissed) {
            msg = missedCallText("description");
          } else {
            msg = d.customMessage || d.notification_message || d.message || super.description || "";
          }
          const eventAt = d.event_at;
          if (!eventAt) return msg;
          const date = new Date(eventAt);
          if (isNaN(date.getTime())) return msg;
          const lang = typeof document !== "undefined" && document.documentElement ? document.documentElement.lang : "en";
          const isUS = lang === "en" && typeof navigator !== "undefined" && /^en-US$/i.test(navigator.language || "");
          const timeStr = date.toLocaleTimeString(isUS ? "en-US" : lang, { hour: "2-digit", minute: "2-digit", hour12: isUS });
          return msg + " " + timeStr;
        }
      };
    });
    log("diskuz-call: notification type renderer registered for custom (campanella)");
  });

  /* Pulsante "Chiamata" nel composer della chat (stesso punto di Jitsi): con withPluginApi come fa Jitsi, così registerChatComposerButton è disponibile */
  withPluginApi((pluginApi) => {
    if (!pluginApi.registerChatComposerButton) return;
    let chatService;
    try {
      chatService = pluginApi.container.lookup("service:chat");
    } catch (e) {
      return;
    }
    if (!chatService) return;
    pluginApi.registerChatComposerButton({
      id: "diskuz-call-chat-call",
      group: "insertions",
      position: "inline",
      icon: "phone",
      label: "Call",
      title: "Call this user (Diskuz Call)",
      action: () => {
        const activeChannel = chatService.activeChannel;
        if (!activeChannel) {
          log("chat call: no active channel");
          if (typeof showToast === "function") showToast("Open a direct message to call.");
          return;
        }
        const currentUser = pluginApi.getCurrentUser();
        if (!currentUser) return;
        let otherUser = null;
        const users = activeChannel.chatable?.users || activeChannel.recipients || [];
        for (const u of users) {
          const uid = typeof u === "object" && u !== null ? u.id : null;
          if (uid != null && uid !== currentUser.id) {
            otherUser = u;
            break;
          }
        }
        if (!otherUser) {
          log("chat call: no other user in channel (not a 1:1 DM?)");
          if (typeof showToast === "function") showToast("Open a direct message with one person to call.");
          return;
        }
        const username = otherUser.username || otherUser.name;
        const userId = otherUser.id;
        const avatarTemplate = otherUser.avatar_template ?? null;
        if (!username || userId == null) return;
        window.dispatchEvent(
          new CustomEvent("diskuz-call-start", {
            detail: { username, userId, avatar_template: avatarTemplate },
          })
        );
      },
    });
    log("diskuz-call: chat composer button (smartphone) registered");
  });
});
