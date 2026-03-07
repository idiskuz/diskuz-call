# diskuz Call – New features and fixes

## Video calls

- **Admin setting:** New option **“Groups that can enable video during a call”** (`diskuz_call_video_allowed_groups`). Same format as “Who can use diskuz Call”; only users in these groups see the Video button once the call is connected.
- **Video button:** Shown in the call UI **after the call is established** (when connection is stable). Icon: webcam/video. Click toggles the user’s camera on or off.
- **Layout:**
  - **Mobile:** Full-screen vertical layout: remote video fills the screen; small vertical preview (bottom-right) for the local camera; only the existing **“Show buttons”** control visible at the bottom when controls are hidden.
  - **Desktop:** Same remote + local preview layout; **fullscreen button** (⛶) appears during an active video call so the user can enter fullscreen.
- **Mirror (front camera):** Checkbox overlay **“Mirror camera”** on the local preview. **Enabled by default**; user can turn it off. Preference stored in `localStorage` (`diskuz_call_video_mirror`).
- **Behavior:** User can turn their own video off and keep watching the remote video. When **both** have video off, the UI reverts to the standard voice-call layout (avatar, status, duration, etc.). Front camera is used for video (`facingMode: "user"`). Renegotiation uses `video_offer` / `video_answer` over the existing signaling channel.

---

## Ringtones and preview

- **Preview stop:** When listening to a ringtone preview, starting another preview **stops the previous one** immediately. Clicking **“Select”** (Imposta/Seleziona) **stops any playing preview** immediately before saving.
- **Default ringtone:** When not set by the admin, the default alternative ringtone is **ringtone 3 (“soft”)** instead of “classic” (settings, controller, and frontend fallbacks updated).
- **Custom ringtones:** Up to 10 admin-configured MP3 URLs; user chooses one in the widget with Preview and Select; selection is saved per user.

---

## Notifications page and back button

- **Back button:** The **“← Back”** / **“← Indietro”** button on the Notifications page is more visible: it now shows **label + arrow**, has a **solid green** background and white text, and is clearly distinct from the page title. Styling is consistent on desktop and mobile (larger tap target on mobile).
- **Scrollbar (desktop):** The notifications list uses a **minimal, styled scrollbar** (thin, green thumb; no gray bar with up/down arrows), matching the rest of the UI.
- **Records per tab:** Limited to **10 entries per tab** (Received, Sent, Recent, Missed).

---

## Widget and call UI (desktop)

- **Resizable:** Widget and call UI are **resizable** like windows (`resize: both`) with min 360×520 px and max 90vw×85vh.
- **Size persistence:** **ResizeObserver** saves the current size when the user resizes the widget or call UI so it is restored on next open. Position was already saved on drag/close.
- **Minimum size safeguard:** A **minimum size (360×520)** is enforced in JS when **loading** from localStorage, **applying** the rect to the widget/call UI, and **saving** after capture. This prevents the widget from staying “shrunk” if an invalid size was ever stored (e.g. after an accidental resize). Users who still see an old narrow layout can clear the key `diskuz_call_widget_rect` in Local Storage to reset to default size.

---

## Speaker and audio (mobile)

- **Native audio picker:** On **mobile**, the **Speaker** button now uses **`navigator.mediaDevices.selectAudioOutput()`** when available, opening the **device’s native audio output picker** (earpiece, speaker, Bluetooth, etc.), similar to Meet. If the API is not supported, a short message suggests using the device’s volume keys or sound settings. On desktop, behavior is unchanged (cycle through outputs).

---

## Other behavior and UI

- **Widget when closed:** When the widget is closed, it is **fully hidden** (no transparent clickable area) so it does not intercept clicks (e.g. on chat attachments).
- **Install button:** Only one install button remains: **“Install diskuz.com app”** (single PWA install for the full site).
- **Default widget size (desktop):** 360×520 px to reduce the need for scrollbars.

---

## Backend and API

- **Status API:** Response now includes **`video_allowed`** (boolean) for the current user, based on `diskuz_call_video_allowed_groups`.
- **Signaling:** **`video_offer`** and **`video_answer`** are forwarded like other signal types; no backend logic change beyond forwarding.

---

## Documentation

- **README:** Updated with video call, ringtones, resize/min size, notifications back button, speaker on mobile, and a short “If the widget appears too small on desktop” section (including clearing `diskuz_call_widget_rect`). Version set to **0.4.0-beta**.

---

## Summary

This PR adds **optional video calls** (admin-controlled by group), **improved ringtone preview and default**, a **clearer Notifications back button**, **resizable widget/call UI with size persistence and min-size protection**, **native audio picker on mobile** for the Speaker button, and several UX and stability improvements. All changes are backward compatible; existing sites keep current behavior until they adjust settings or users use the new options.
