/**
 * Plugin diskuz-call: invio segnali (DiskuzCallSend), status, e ricezione via MessageBus.
 * La UI è in diskuz-call-ui.js (stesso plugin).
 */
import apiInitializer from "discourse/lib/api";
import MessageBus from "message-bus-client";
import { ajax } from "discourse/lib/ajax"; /* used by DiskuzCallSend */

const LOG = (...args) => console.log("[diskuz-call glue]", ...args);

apiInitializer("0.7", (api) => {
  const currentUser = api.getCurrentUser();

  window.DiskuzCallAllowed = false;
  window.DiskuzCallStatusLoaded = false;

  window.DiskuzCallSend = (data) => {
    if (!currentUser) {
      LOG("glue: DiskuzCallSend called but no current user");
      return Promise.reject(new Error("diskuz-call: not logged in"));
    }
    const { to_user_id, type, ...rest } = data;
    LOG("glue: DiskuzCallSend called", type, "to_user_id", to_user_id, "payload keys", Object.keys(rest || {}));
    const promise = ajax("/diskuz-call/signal", {
      type: "POST",
      data: { target_user_id: to_user_id, signal_type: type, payload: rest },
    });
    promise.then(
      () => LOG("glue: signal OK", type, "to_user_id", to_user_id),
      (err) => LOG("glue: signal FAIL", type, "to_user_id", to_user_id, err)
    );
    return promise;
  };
  LOG("glue: DiskuzCallSend registered (currentUser:", currentUser ? currentUser.username : "none", ")");

  if (!currentUser) return;

  /* Status viene caricato una sola volta da diskuz-call-ui.js (api 0.8) per evitare doppia chiamata /diskuz-call/status. */

  if (window.DiskuzCallMessageBusSubscribed) return;
  window.DiskuzCallMessageBusSubscribed = true;
  MessageBus.subscribe("/diskuz-call/signals", (data) => {
    LOG("glue: MessageBus message received", data.signal_type, "from_user_id", data.from_user_id, "from_username", data.from_username);
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
    LOG("glue: dispatching diskuz-call-signal", detail.type, "hasSdp?", !!detail.sdp, "hasCandidate?", !!detail.candidate);
    window.dispatchEvent(new CustomEvent("diskuz-call-signal", { detail }));
  });
  LOG("glue: MessageBus subscribed to /diskuz-call/signals");
});
