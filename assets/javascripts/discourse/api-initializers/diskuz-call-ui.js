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
  };

  const HISTORY_KEY = "diskuz_call_history";
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
        const a = new Audio(customUrl);
        a.volume = 0.8;
        a.play().catch(() => {});
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
    callHistory.unshift({
      direction: entry.direction,
      result: entry.result,
      username: entry.username,
      at: entry.at || new Date().toISOString(),
    });
    if (callHistory.length > 50) {
      callHistory = callHistory.slice(0, 50);
    }
    saveHistory();
    renderHistoryList();
  }

  /* --- HISTORY UI --- */
  function createHistoryPanel() {
    if (historyPanel) return;

    historyPanel = document.createElement("div");
    historyPanel.id = "diskuz-call-history";
    historyPanel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <strong>Call history</strong>
        <button id="diskuz-call-history-close" style="border:none;background:none;cursor:pointer;font-size:16px;">✕</button>
      </div>
      <div id="diskuz-call-history-list" style="font-size:13px;color:#333;"></div>
    `;

    document.body.appendChild(historyPanel);

    const closeBtn = historyPanel.querySelector("#diskuz-call-history-close");
    closeBtn.addEventListener("click", function () {
      historyPanel.classList.remove("open");
    });

    renderHistoryList();
  }

  function renderHistoryList() {
    if (!historyPanel) return;
    const listEl = historyPanel.querySelector("#diskuz-call-history-list");
    if (!listEl) return;

    if (!callHistory.length) {
      listEl.innerHTML = `<div style="color:#777;">No calls yet.</div>`;
      return;
    }

    const rows = callHistory
      .map((h) => {
        const date = new Date(h.at);
        const timeStr = date.toLocaleString();
        let icon = "⬆️";
        if (h.direction === "incoming") icon = "⬇️";
        if (h.result === "missed") icon = "❌";
        if (h.result === "rejected") icon = "🚫";

        return `
          <div style="display:flex;flex-direction:column;border-bottom:1px solid #eee;padding:4px 0;">
            <div>
              <span>${icon}</span>
              <strong style="margin-left:4px;">${h.username}</strong>
            </div>
            <div style="font-size:11px;color:#666;">
              ${h.direction} • ${h.result} • ${timeStr}
            </div>
          </div>
        `;
      })
      .join("");

    listEl.innerHTML = rows;
  }

  function toggleHistoryPanel() {
    createHistoryPanel();
    if (historyPanel.classList.contains("open")) {
      historyPanel.classList.remove("open");
    } else {
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
      btn.innerHTML = "📞";
      document.body.appendChild(btn);
      btn.addEventListener("click", function () {
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
        <h3>Call a user</h3>
        <input id="diskuz-call-input" type="text" placeholder="Enter username">
        <button id="diskuz-call-start">Call</button>
        <div id="diskuz-call-error"></div>

        <div style="margin-top:10px;font-size:13px;color:#555;">Status:</div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button id="diskuz-status-available" class="diskuz-status-btn">Available</button>
          <button id="diskuz-status-busy" class="diskuz-status-btn">Busy</button>
          <button id="diskuz-status-not-available" class="diskuz-status-btn">Not Available</button>
        </div>

        <button id="diskuz-call-history-btn" style="margin-top:10px;width:100%;padding:6px 8px;font-size:13px;border-radius:8px;border:1px solid #ddd;background:#f9fafb;cursor:pointer;">
          View call history
        </button>
      `;

      document.body.appendChild(widget);

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
      });
      busyBtn.addEventListener("click", function () {
        setStatus("busy");
      });
      notAvailBtn.addEventListener("click", function () {
        setStatus("not_available");
      });

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
    proximityOverlay.style.display = "block";
  }

  /* --- CALL UI --- */
  function createCallUI() {
    if (!callUI) {
      callUI = document.createElement("div");
      callUI.id = "diskuz-call-ui";

      callUI.innerHTML = `
        <div class="call-top-bar">
          <div class="call-drag-handle" title="Trascina per spostare" aria-label="Drag to move">⋮⋮</div>
          <button type="button" class="call-fullscreen-btn" title="Full screen" aria-label="Full screen">⛶</button>
        </div>
        <button type="button" class="call-exit-fullscreen-btn" title="Esci da full screen" aria-label="Exit full screen">✕</button>
        <div class="call-inner">
          <div class="diskuz-call-watermark" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 48" fill="none" class="diskuz-call-watermark-svg">
              <path fill="#13c98c" d="M12 4C6.5 4 2 8.5 2 14v12c0 5.5 4.5 10 10 10h14l6 8 2-8h4c5.5 0 10-4.5 10-10V14c0-5.5-4.5-10-10-10H12z"/>
              <text x="22" y="22" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#13c98c">"</text>
              <text x="30" y="22" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#13c98c">"</text>
              <text x="52" y="26" font-family="Arial,sans-serif" font-size="18" font-weight="600" fill="#13c98c">diskuz</text>
            </svg>
          </div>
          <div class="video-container" style="display:none;">
            <video class="remote-video" autoplay playsinline style="width:100%;height:100%;object-fit:contain;background:#000;"></video>
            <video class="local-preview" autoplay playsinline muted style="position:absolute;bottom:12px;right:12px;width:80px;height:106px;object-fit:cover;border-radius:8px;border:2px solid rgba(255,255,255,0.6);background:#000;"></video>
          </div>
          <div class="avatar"></div>
          <div class="username"></div>
          <div class="status">Calling...</div>
          <div class="duration" aria-label="Call duration">00:00</div>

          <div class="controls">
            <button class="btn mute">Mute</button>
            <button class="btn speaker">Speaker</button>
            <button class="btn video-btn" title="Video">Video</button>
            <button class="btn hangup">Hang up</button>
          </div>
          <div class="video-extra" style="display:none;gap:6px;justify-content:center;margin-top:6px;">
            <button class="btn btn-small switch-camera">Switch camera</button>
            <button class="btn btn-small both-cameras">Both cameras</button>
          </div>
          <button type="button" class="diskuz-call-toggle-controls" aria-label="Show or hide call controls">Show buttons</button>

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

      const videoBtn = callUI.querySelector(".video-btn");
      const videoExtra = callUI.querySelector(".video-extra");
      if (videoBtn) {
        videoBtn.style.display = videoEnabledByAdmin() ? "" : "none";
        videoBtn.addEventListener("click", function () {
          toggleVideoDuringCall();
        });
      }
      if (videoExtra) videoExtra.style.display = "none";

      const toggleControlsBtn = callUI.querySelector(".diskuz-call-toggle-controls");
      if (toggleControlsBtn) {
        toggleControlsBtn.style.display = isMobileDevice() ? "flex" : "none";
        toggleControlsBtn.addEventListener("click", function () {
          const hidden = callUI.classList.toggle("diskuz-call-controls-hidden");
          toggleControlsBtn.textContent = hidden ? "Show buttons" : "Hide buttons";
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

      const fullscreenBtn = callUI.querySelector(".call-fullscreen-btn");
      const exitFullscreenBtn = callUI.querySelector(".call-exit-fullscreen-btn");
      if (fullscreenBtn) {
        fullscreenBtn.style.display = isMobileDevice() ? "none" : "";
        fullscreenBtn.addEventListener("click", function () {
          if (!callUI) return;
          callUI.requestFullscreen?.() || callUI.webkitRequestFullscreen?.() || callUI.msRequestFullscreen?.();
        });
      }
      if (exitFullscreenBtn) {
        exitFullscreenBtn.style.display = "none";
        exitFullscreenBtn.addEventListener("click", function () {
          const doc = document;
          (doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen)?.call(doc);
        });
      }
      function onFullscreenChange() {
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
        const weAreFullscreen = (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) === callUI;
        if (exitFullscreenBtn) exitFullscreenBtn.style.display = weAreFullscreen ? "block" : "none";
        if (callUI) callUI.classList.toggle("diskuz-call-is-fullscreen", weAreFullscreen);
      }
      document.addEventListener("fullscreenchange", onFullscreenChange);
      document.addEventListener("webkitfullscreenchange", onFullscreenChange);
      document.addEventListener("MSFullscreenChange", onFullscreenChange);

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
            if (e.target.closest(".call-fullscreen-btn")) return;
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

    const videoContainer = callUI.querySelector(".video-container");
    if (videoContainer) videoContainer.style.display = "none";

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
    callUI.classList.remove("open", "diskuz-call-minimized", "diskuz-call-controls-hidden");
    const toggleBtn = callUI.querySelector(".diskuz-call-toggle-controls");
    if (toggleBtn) toggleBtn.textContent = "Hide buttons";
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
  let rtcLocalVideoStream = null;

  function videoEnabledByAdmin() {
    if (isMobileDevice()) return window.DiskuzCallVideoEnabledMobile !== false;
    return window.DiskuzCallVideoEnabledDesktop !== false;
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
      if (event.track.kind === "audio") {
        if (rtcRemoteAudio) {
          rtcRemoteAudio.srcObject = stream;
          applySpeakerSink();
          rtcRemoteAudio.play().catch(() => {});
        }
      } else if (event.track.kind === "video") {
        const remoteVideo = callUI && callUI.querySelector(".remote-video");
        if (remoteVideo) {
          remoteVideo.srcObject = stream;
          const container = callUI && callUI.querySelector(".video-container");
          if (container) {
            container.style.display = "block";
            callUI && callUI.classList.add("diskuz-call-video-active");
          }
        }
      }
    };

    if (rtcLocalStream) {
      rtcLocalStream.getTracks().forEach((track) => {
        rtcPeer.addTrack(track, rtcLocalStream);
      });
    }

    return rtcPeer;
  }

  function getVideoConstraintsForConnection() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const effectiveType = conn && conn.effectiveType;
    if (effectiveType === "4g" || !effectiveType) {
      return { width: { ideal: 640 }, height: { ideal: 480 } };
    }
    if (effectiveType === "3g") {
      return { width: { ideal: 480 }, height: { ideal: 360 } };
    }
    return { width: { ideal: 320 }, height: { ideal: 240 } };
  }

  async function rtcAddVideo() {
    if (!rtcPeer || !currentCall.active || !currentCall.userId || !window.DiskuzCallSend) return;
    try {
      const videoOpts = getVideoConstraintsForConnection();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", ...videoOpts },
      });
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (rtcLocalVideoStream) {
        rtcLocalVideoStream.getTracks().forEach((t) => t.stop());
      }
      rtcLocalVideoStream = stream;
      rtcPeer.addTrack(videoTrack, stream);
      const offer = await rtcPeer.createOffer();
      await rtcPeer.setLocalDescription(offer);
      const sdpPayload = serializeSdp(offer);
      window.DiskuzCallSend({
        type: "call_reoffer",
        to_user_id: currentCall.userId,
        sdp: sdpPayload,
      });
      log("[*] Video on: sent call_reoffer");
      const vc = callUI && callUI.querySelector(".video-container");
      const lp = callUI && callUI.querySelector(".local-preview");
      if (vc) vc.style.display = "block";
      if (lp) lp.srcObject = stream;
      callUI && callUI.classList.add("diskuz-call-video-active");
      const vb = callUI && callUI.querySelector(".video-btn");
      if (vb) vb.classList.add("active");
    } catch (e) {
      console.error("[diskuz-call] rtcAddVideo failed", e);
      showToast("Could not start camera.");
    }
  }

  async function rtcRemoveVideo() {
    if (!rtcPeer || !currentCall.active || !currentCall.userId || !window.DiskuzCallSend) return;
    const sender = rtcPeer.getSenders().find((s) => s.track && s.track.kind === "video");
    if (!sender) {
      if (rtcLocalVideoStream) {
        rtcLocalVideoStream.getTracks().forEach((t) => t.stop());
        rtcLocalVideoStream = null;
      }
      applyVideoOffUI();
      return;
    }
    rtcPeer.removeTrack(sender);
    if (rtcLocalVideoStream) {
      rtcLocalVideoStream.getTracks().forEach((t) => t.stop());
      rtcLocalVideoStream = null;
    }
    const offer = await rtcPeer.createOffer();
    await rtcPeer.setLocalDescription(offer);
    window.DiskuzCallSend({
      type: "call_reoffer",
      to_user_id: currentCall.userId,
      sdp: serializeSdp(offer),
    });
    log("[*] Video off: sent call_reoffer");
    applyVideoOffUI();
  }

  function applyVideoOffUI() {
    const lp = callUI && callUI.querySelector(".local-preview");
    if (lp) lp.srcObject = null;
    callUI && callUI.classList.remove("diskuz-call-video-active");
    const vb = callUI && callUI.querySelector(".video-btn");
    if (vb) vb.classList.remove("active");
    const vc = callUI && callUI.querySelector(".video-container");
    const rv = callUI && callUI.querySelector(".remote-video");
    if (rv) rv.srcObject = null;
    if (vc) vc.style.display = "none";
  }

  async function toggleVideoDuringCall() {
    if (!videoEnabledByAdmin()) return;
    const hasVideo = rtcLocalVideoStream && rtcLocalVideoStream.active;
    if (hasVideo) await rtcRemoveVideo();
    else await rtcAddVideo();
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
    if (!currentCall.userId || !currentCall.offerSdp) {
      log("[CALLEE] rtcSendAnswer: skip, no userId or offerSdp");
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
    if (!rtcPeer) {
      log("[CALLER] rtcHandleAnswer: no rtcPeer, skip");
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

    if (!rtcPeer || !rtcPeer.remoteDescription) {
      if (isFromPeer) {
        iceCandidateQueue.push(data.candidate);
        log("[*] rtcHandleIce: queued candidate (remote description not set yet), queue size=", iceCandidateQueue.length);
      }
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
    if (rtcLocalVideoStream) {
      rtcLocalVideoStream.getTracks().forEach((t) => t.stop());
      rtcLocalVideoStream = null;
    }
    currentCall.offerSdp = null;
    iceCandidateQueue = [];
    pendingIceCandidatesToAdd = [];
    currentSinkId = "";
    currentSinkIndex = 0;
    callUI && callUI.classList.remove("diskuz-call-video-active");
  }

  function resetCurrentCall() {
    currentCall.active = false;
    currentCall.direction = null;
    currentCall.username = null;
    currentCall.userId = null;
    currentCall.isRinging = false;
    currentCall.offerSdp = null;
  }

  function endCurrentCall(result) {
    if (currentCall.active && currentCall.username) {
      addHistoryEntry({
        direction: currentCall.direction || "outgoing",
        result: result || "ended",
        username: currentCall.username,
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

    setIncomingCallButtonState(true);
    playIncomingCallRing();
    showBrowserNotification(data.from_username || "Someone");
    showIncomingCallUI(data.from_username, data.avatar_template);
  }

  function showIncomingCallUI(username, avatarTemplate) {
    createCallUI();

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

    let controls = callUI.querySelector(".controls");
    if (!controls) return;

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
    acceptBtn.textContent = "Accept";
    acceptBtn.style.flex = "1";
    acceptBtn.style.padding = "8px 10px";
    acceptBtn.style.borderRadius = "999px";
    acceptBtn.style.border = "none";
    acceptBtn.style.background = "#22c55e";
    acceptBtn.style.color = "#fff";
    acceptBtn.style.cursor = "pointer";
    acceptBtn.style.fontSize = "14px";

    const rejectBtn = document.createElement("button");
    rejectBtn.textContent = "Reject";
    rejectBtn.style.flex = "1";
    rejectBtn.style.padding = "8px 10px";
    rejectBtn.style.borderRadius = "999px";
    rejectBtn.style.border = "none";
    rejectBtn.style.background = "#ef4444";
    rejectBtn.style.color = "#fff";
    rejectBtn.style.cursor = "pointer";
    rejectBtn.style.fontSize = "14px";

    incomingRow.appendChild(acceptBtn);
    incomingRow.appendChild(rejectBtn);

    callUI.querySelector(".call-inner").insertBefore(incomingRow, controls);

    acceptBtn.addEventListener("click", () => {
      acceptIncomingCall();
    });

    rejectBtn.addEventListener("click", () => {
      rejectIncomingCall();
    });

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

  async function acceptIncomingCall() {
    log("[CALLEE] acceptIncomingCall clicked");
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
          addHistoryEntry({
            direction: currentCall.direction || "incoming",
            result: "ended",
            username: currentCall.username || "Unknown",
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

      case "call_reoffer":
        if (currentCall.active && currentCall.userId === data.from_user_id && rtcPeer) {
          handleReoffer(data);
        }
        break;

      case "call_reanswer":
        if (currentCall.active && currentCall.userId === data.from_user_id && rtcPeer) {
          handleReanswer(data);
        }
        break;

      default:
        break;
    }
  });

  async function handleReoffer(data) {
    if (!data.sdp || !rtcPeer || !currentCall.userId || !window.DiskuzCallSend) return;
    try {
      await rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await rtcPeer.createAnswer();
      await rtcPeer.setLocalDescription(answer);
      window.DiskuzCallSend({
        type: "call_reanswer",
        to_user_id: currentCall.userId,
        sdp: serializeSdp(answer),
      });
      log("[*] handleReoffer: sent call_reanswer");
    } catch (e) {
      console.error("[diskuz-call] handleReoffer failed", e);
    }
  }

  async function handleReanswer(data) {
    if (!data.sdp || !rtcPeer) return;
    try {
      await rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp));
      log("[*] handleReanswer: set remote description OK");
    } catch (e) {
      console.error("[diskuz-call] handleReanswer failed", e);
    }
  }

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
    createFloatingButton();
    createWidget();
    updateCallFeatureVisibility();
  }
  window.addEventListener("diskuz-call-allowed-changed", updateCallFeatureVisibility);
  api.onPageChange(initPage);
  initPage();
});
