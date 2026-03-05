# diskuz Call

Discourse plugin for **P2P voice and video calls (WebRTC)** with built-in UI. Plugin directory name: **diskuz-call**. No theme component required.

**Authors:** diskuz.com, Cristian Deraco

---

## Installation

1. The plugin folder must be named **diskuz-call** (e.g. `plugins/diskuz-call`).
2. Admin → Plugins → enable **diskuz.com Call**.
3. Admin → Settings → Plugins → enable **Enable diskuz Call**.
4. Rebuild the container/site.

---

## Full feature list

### Calls
- **Voice call** between two users (WebRTC audio).
- **Video call** (optional): "Video call" checkbox in the widget; front camera by default; callee can answer with video if the caller started a video call.
- **Floating button** (bottom right): opens the widget to start a call (enter username).
- **User status:** Available, Busy, Not available; incoming calls can be auto-rejected when you are Busy or Not available.
- **Call history** (local, in browser): recent calls with direction, outcome, and date; "View call history" panel in the widget.

### During a call
- **Duration timer** in MM:SS from connection time.
- **Mute:** turn off microphone; button shows "Muted" (strikethrough) when active.
- **Speaker:** cycle audio outputs (desktop: default → other devices; mobile: earpiece → speaker → others). On mobile, audio starts in **earpiece mode** (not speakerphone).
- **Video:** button to show/hide video area; local preview and remote video when present.
- **Hang up:** end the call.
- **Ear mode:** proximity overlay (mobile).

### Incoming call
- **Floating button** **pulses** to draw attention.
- **Configurable sound** (none, default, ding, bell, chat).
- **Browser notification** (desktop) with caller name.
- **Discourse bell notification** with avatar and message (e.g. "is calling you").
- **Incoming UI** with Accept / Reject.
- **MessageBus subscription** in the UI as fallback so the callee receives the event even if the glue does not run.

### Desktop
- **Draggable call window:** top bar (⋮⋮) to move the window anywhere on the page; position is remembered.
- **While a call is active:** clicking the floating button **does not** open the widget but **shows/hides** the call window (minimize); the call stays active until Hang up or F5.

### Mobile
- Audio defaults to **earpiece** (not speakerphone); cycle speaker to change output.
- **Swipe down** on the call window to hang up.
- Touch-friendly layout and controls.

### WebRTC and signaling
- **Signaling** via MessageBus (channel `/diskuz-call/signals`, filtered by recipient).
- **SDP** (offer/answer) and **ICE candidates** forwarded by the backend; ICE queue on both caller and callee for candidates that arrive before the answer.
- Default **STUN** (3 Google servers); optional **TURN** configurable by admin (JSON setting).
- **ICE failed** state handling with user message and call end.
- **DiskuzCallSend fallback** in the UI if the glue is not loaded.

### Permissions and restrictions
- **Allowed groups:** only users in the configured groups can see and use diskuz Call (default: administrators, moderators, staff).
- **"Require follow" option:** when enabled (with discourse-follow plugin), the **callee must follow the caller** to receive calls; when disabled, any allowed user can call any other allowed user.
- **403 with reason:** clear messages (follow_required, target_not_in_allowed_groups, caller_not_in_allowed_groups) in console and toast.
- Cannot call yourself; server-side checks for groups and follow.

### Admin settings (Plugins)
- **Enable diskuz Call:** turn the plugin on or off.
- **Who can see and use diskuz Call:** groups that can use calls (default: 1|2|3). Supports "all" or list of IDs.
- **Require the callee to follow the caller:** require the callee to follow the caller (when discourse-follow is enabled). Type: boolean.
- **Sound for incoming calls:** incoming sound: `none`, `default`, `ding`, `bell`, `chat`.
- **ICE servers:** optional JSON for custom STUN/TURN servers; empty = Google STUN only.

### Backend API
- `GET /diskuz-call/status` — plugin state (enabled, incoming_sound, ice_servers).
- `PUT /diskuz-call/preferences` — user preferences.
- `GET /diskuz-call/can-call/:user_id` — check if the current user can call the given user (groups + follow).
- `POST /diskuz-call/signal` — send signal (offer, answer, ice_candidate, call_end, call_reject); delivery to recipient via MessageBus.

### Localization
- Strings and settings translated in **English** and **Italian** (client and server).

---

## If the call button does not show

1. **Settings:** Admin → Settings → Plugins → ensure **Enable diskuz Call** is enabled.
2. **Groups:** **Who can see and use diskuz Call** controls visibility. Default: 1|2|3. If your user is not in any of these groups, add the appropriate group (e.g. trust_level_1 = 11).
3. **Console:** F12 → Console. Look for `[diskuz-call]` messages (e.g. "initializer running", "initPage: user ..."). If none appear, the plugin JS may not be loading (rebuild and hard refresh).
4. **Refresh:** After changing settings, hard refresh (e.g. Ctrl+F5).

---

## Requirements
- Discourse with MessageBus.
- Optional: **discourse-follow** plugin for the "Require the callee to follow the caller" option.
- Browser with WebRTC support and (for video) `getUserMedia` for camera.
