# diskuz Call

Discourse plugin for **P2P voice calls (WebRTC)** with built-in UI. One plugin, no theme component required. Plugin directory name: **diskuz-call**.

**Authors:** diskuz.com, Cristian Deraco

---

## Installation

1. Place the **diskuz-call** plugin folder in your Discourse **plugins** directory (e.g. `plugins/diskuz-call`), so that `plugin.rb`, `assets`, `app`, and `config` are inside `plugins/diskuz-call/`.
2. Rebuild the container/site (e.g. `./launcher rebuild app` for Docker, or your host’s rebuild command).
3. In Discourse: **Admin → Plugins** → enable **diskuz.com Call**.
4. **Admin → Settings → Plugins** → enable **Enable diskuz Call**.

---

## Full feature list

### Calls
- **Voice call** between two users (WebRTC audio, no video).
- **Floating button** (bottom right): opens the widget to start a call (enter username).
- **User status:** **Online**, **Busy**, **Offline**. Status is saved in the browser (localStorage) and restored on reload; default on first load is **Online**. Incoming calls can be auto-rejected when status is Busy or Offline.
- **Notifications** (ex Call history): panel with tabs **Received**, **Sent**, **Recent contacts**, **Missed**. All nicknames are clickable to start a call. Call time in **HH:mm**; for completed calls, duration in **mm:ss** or **hh:mm:ss** if ≥ 1 hour. On desktop, the panel can open attached below the widget; on mobile it stays on screen and can be closed with **✕**.

### During a call
- **Duration timer** from connection time (MM:SS or HH:MM:SS).
- **Mute:** turn off microphone; button shows "Muted" when active.
- **Speaker:** cycle audio outputs (desktop: default → other devices; mobile: earpiece → speaker → others). On mobile, audio can start in earpiece.
- **Hang up:** end the call.
- **Hide / Show buttons:** hide the control row (Mute, Speaker, Hang up) toward the bottom of the UI; show again with one tap/click.
- **Ear mode** (mobile): full-screen proximity overlay (dark screen) so you can put the phone to your ear; tap to dismiss. On iPhone the overlay is brought to the front so it stays visible.

### Incoming call
- **Floating button** **pulses** (green) to draw attention.
- **Configurable ringtone:** none, default, ding, bell, chat, or **custom** (URL from admin; supports relative paths and full URLs like `https://yoursite.com/ring.mp3`).
- **Browser notification** (when permitted) with caller name.
- **Discourse bell notification** with text such as "Calling you" / "Ti sto chiamando" and icon.
- **Incoming UI** with **Accept** and **Reject**. If the full UI does not appear automatically, clicking the flashing floating button opens the call screen with Accept/Reject. Only Accept/Reject are shown while ringing; Mute/Speaker/Hang up appear after accepting.

### Call UI (window)
- **Top bar** (desktop): draggable; shows **diskuz Call** (green) and **by diskuz.com**. Used to move the call window.
- **Content order:** avatar, username, status (e.g. "Calling..." / "In call..."), then **diskuz Call** logo + by diskuz.com + slogan *Real Conversations, No Algorithms :-)*, then duration, then controls at the **bottom** (Hide, Mute, Speaker, Hang up). No fullscreen/video mode.
- **Desktop:** window is resizable; controls are anchored at the bottom; when hidden they slide off the bottom.
- **Mobile:** full-screen call UI; controls at the bottom; Ear mode available.

### WebRTC and signaling
- **Signaling** via MessageBus (channel `/diskuz-call/signals`, filtered by recipient).
- **SDP** (offer/answer) and **ICE candidates** forwarded by the backend; ICE queue on both sides for candidates that arrive before the answer; candidates added sequentially.
- Default **STUN** (Google servers); optional **TURN** configurable by admin (JSON). TURN improves success on symmetric NATs and corporate/mobile networks.
- **ICE failed** handling with user message and call end.
- **DiskuzCallSend** fallback in the UI if the glue is not loaded.

### Permissions and restrictions
- **Allowed groups:** only users in the configured groups can see and use diskuz Call (default: administrators, moderators, staff).
- **Require follow:** when enabled (with discourse-follow), the **callee must follow the caller** to receive calls. If the call is not allowed, the toast explains (e.g. "To call NICKNAME you need to follow each other.").
- **403 reasons:** clear messages (follow_required, target_not_in_allowed_groups, caller_not_in_allowed_groups) in response and toast.
- Cannot call yourself; server-side checks for groups and follow.

### Admin settings (Plugins)
- **Enable diskuz Call:** turn the plugin on or off.
- **Who can see and use diskuz Call:** groups that can use calls (default: 1|2|3). Supports "all" or list of group IDs.
- **Require the callee to follow the caller:** when discourse-follow is enabled. Boolean.
- **Sound for incoming calls:** `none`, `default`, `ding`, `bell`, `chat`, or **`custom`** (uses Custom ringtone URL).
- **Custom ringtone URL:** full or relative URL of an MP3 (e.g. `https://yoursite.com/ring.mp3` or `/uploads/...`). Used when Sound is **custom**. Recommended max size ~500 KB.
- **ICE servers:** optional JSON array for STUN/TURN; empty = Google STUN only. Example: `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]`.

### Backend API
- `GET /diskuz-call/status` — plugin state (enabled, incoming_sound, custom_ringtone_url, ice_servers).
- `GET /diskuz-call/watermark.png` — diskuz logo image for the call UI.
- `PUT /diskuz-call/preferences` — user preferences.
- `GET /diskuz-call/can-call/:user_id` — check if the current user can call the given user (groups + follow).
- `POST /diskuz-call/signal` — send signal (offer, answer, ice_candidate, call_end, call_reject); delivery to recipient via MessageBus.

### Localization
- Strings and settings in **English** and **Italian** (client and server).

---

## Why calls or audio sometimes fail

1. **Network and NAT**  
   With **STUN only**, two users behind “easy” NATs often connect. With symmetric NATs or corporate firewalls, the connection may fail. **Fix:** configure **TURN** in Admin → Settings → Plugins → **ICE servers** (JSON). TURN relays media when P2P fails and greatly improves success.

2. **Signaling and ICE order**  
   ICE candidates are queued and added **sequentially** after the remote description to avoid timing issues.

3. **Browser audio**  
   The plugin calls `play()` on the remote audio element when the track arrives to help autoplay policies.

4. **Microphone permission**  
   The user must allow the microphone; without it, the other party will not hear.

**Summary:** For best stability, **configure TURN servers** when needed.

---

## If the call button does not show

1. **Admin → Settings → Plugins:** ensure **Enable diskuz Call** is enabled.
2. **Who can see and use diskuz Call:** your user must be in one of the allowed groups (e.g. add the right group ID).
3. **Console (F12):** look for `[diskuz-call]` messages. If none, rebuild and hard refresh (Ctrl+F5).

---

## Requirements

- Discourse with MessageBus.
- Optional: **discourse-follow** for the “Require the callee to follow the caller” option.
- Browser with WebRTC support and microphone access.

---

## Disclaimer (public repository)

This plugin is provided as-is. If the repository is **public**, the following applies:

- **There is no guarantee of continuous development, maintenance, or updates.** The authors are not committed to releasing new versions, fixing bugs, or keeping the plugin compatible with future Discourse or browser versions.
- **Use at your own risk.** You are responsible for testing the plugin in your environment and for any impact on your community or infrastructure.
- **No warranty** is given. For critical deployments, consider forking the repository and maintaining your own version, or reaching out to the authors for commercial or dedicated support if available.

---

**Version:** 0.3.0-beta · **URL:** https://github.com/idiskuz/diskuz-call
