/**
 * Bootstrap diskuz-call: solo il floating button per utenti loggati.
 * Al primo click si carica il plugin completo (lazy); ai click successivi si apre/chiude il widget.
 */
import apiInitializer from "discourse/lib/api";

const LAZY_CHUNK_PATH = "discourse/lazy/diskuz-call-full";

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
  if (document.body && document.body.classList && (document.body.classList.contains("composer-open") || document.body.classList.contains("has-composer"))) return true;
  return false;
}

function updateBootstrapButtonVisibility(btn) {
  if (!btn) return;
  btn.style.display = isComposerVisible() ? "none" : "";
}

apiInitializer("0.7", (api) => {
  const currentUser = api.getCurrentUser();
  if (!currentUser) return;

  window.DiskuzCallAllowed = false;
  window.DiskuzCallStatusLoaded = false;

  let btn = document.getElementById("diskuz-call-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "diskuz-call-btn";
    btn.type = "button";
    btn.innerHTML = `<span class="diskuz-call-btn-icon" aria-hidden="true">📱</span><span class="diskuz-call-btn-label">Call</span>`;
    btn.setAttribute("aria-label", "Call");
    document.body.appendChild(btn);

    btn.addEventListener("click", function () {
      if (window.__DiskuzCallFullLoaded && typeof window.DiskuzCallToggleWidget === "function") {
        window.DiskuzCallToggleWidget();
        return;
      }
      import(
        /* webpackChunkName: "diskuz-call-full" */
        "../lazy/diskuz-call-full"
      )
        .then((module) => {
          const init = module.default;
          if (typeof init === "function") init(api);
        })
        .catch((err) => {
          console.warn("[diskuz-call] Lazy load failed", err);
        });
    });
  }

  updateBootstrapButtonVisibility(btn);
  let composerCheckScheduled = false;
  function scheduleComposerCheck() {
    if (composerCheckScheduled) return;
    composerCheckScheduled = true;
    requestAnimationFrame(() => {
      composerCheckScheduled = false;
      updateBootstrapButtonVisibility(document.getElementById("diskuz-call-btn"));
    });
  }
  const composerObserver = new MutationObserver(scheduleComposerCheck);
  composerObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  document.addEventListener("visibilitychange", () => updateBootstrapButtonVisibility(document.getElementById("diskuz-call-btn")));
});
