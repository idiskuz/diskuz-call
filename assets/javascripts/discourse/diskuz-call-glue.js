/**
 * Plugin diskuz-call: invio segnali (DiskuzCallSend), status, e ricezione via MessageBus.
 * La UI è in diskuz-call-ui.js (stesso plugin).
 */
import apiInitializer from "discourse/lib/api";
import MessageBus from "message-bus-client";
import { ajax } from "discourse/lib/ajax";

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

  ajax("/diskuz-call/status")
    .then((data) => {
      window.DiskuzCallStatusLoaded = true;
      window.DiskuzCallAllowed = data.enabled === true;
      window.DiskuzCallVideoAllowed = data.video_allowed === true;
      window.DiskuzCallShowFloatingButton = data.show_floating_button !== false;
      window.DiskuzCallShowChatButton = data.show_chat_button !== false;
      window.DiskuzCallIncomingSound = (data.incoming_sound && data.incoming_sound !== "") ? data.incoming_sound : "default";
      window.DiskuzCallCustomRingtoneUrl = (data.custom_ringtone_url && data.custom_ringtone_url !== "") ? data.custom_ringtone_url : "";
      window.DiskuzCallIceServers = Array.isArray(data.ice_servers) && data.ice_servers.length > 0 ? data.ice_servers : null;
      LOG("glue: status OK enabled=", window.DiskuzCallAllowed, "ice_servers=", window.DiskuzCallIceServers ? "custom" : "default");
      window.dispatchEvent(
        new CustomEvent("diskuz-call-allowed-changed", {
          detail: { allowed: window.DiskuzCallAllowed },
        })
      );
    })
    .catch((err) => {
      window.DiskuzCallStatusLoaded = true;
      window.DiskuzCallAllowed = false;
      window.DiskuzCallIncomingSound = "default";
      window.DiskuzCallCustomRingtoneUrl = "";
      window.DiskuzCallIceServers = null;
      LOG("glue: status FAIL", err);
      window.dispatchEvent(
        new CustomEvent("diskuz-call-allowed-changed", {
          detail: { allowed: false },
        })
      );
    });

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
  window.DiskuzCallMessageBusSubscribed = true;
  LOG("glue: MessageBus subscribed to /diskuz-call/signals");
});
