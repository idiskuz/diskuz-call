# diskuz Call

Discourse plugin for **P2P voice and video calls (WebRTC)** with built-in UI. Plugin directory name: **diskuz-call**. No theme component required.

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
- **Voice call** between two users (WebRTC audio).
- **Video call** (optional): "Video call" checkbox in the widget; front camera by default; callee can answer with video if the caller started a video call.
- **Floating button** (bottom right): opens the widget to start a call (enter username).
- **User status:** Available, Busy, Not available; incoming calls can be auto-rejected when you are Busy or Not available.
- **Call history** (local, in browser): recent calls with direction, outcome, and date; "View call history" panel in the widget.

### During a call
- **Duration timer** in MM:SS from connection time.
- **Mute:** turn off microphone; button shows "Muted" (strikethrough) when active.
- **Speaker:** cycle audio outputs (desktop: default → other devices; mobile: earpiece → speaker → others). On mobile, audio starts in **earpiece mode** (not speakerphone).
- **Video:** button to show/hide video; when video is on, the button **pulses** slowly in diskuz green. Local preview and remote video when present.
- **Hang up:** end the call.
- **Ear mode:** proximity overlay (mobile only; hidden on desktop).

### Incoming call
- **Floating button** **pulses** to draw attention.
- **Configurable sound:** none, default, ding, bell, chat, or **custom** (custom ringtone URL from admin).
- **Browser notification** (desktop) with caller name.
- **Discourse bell notification** with caller avatar, name, and description (e.g. "is calling you"); notification data includes a phone icon hint for themes.
- **Incoming UI** with Accept / Reject (on mobile, Accept/Reject are at the bottom).
- **MessageBus subscription** in the UI as fallback so the callee receives the event even if the glue does not run.

### Desktop
- **Larger default call window** (320×440 px); resizable via the window edge.
- **Draggable call window:** the **entire top bar** is draggable to move the window anywhere on the page; position is remembered. Fullscreen button does not start a drag.
- **Controls (Mute, Speaker, Video, Hang up)** are at the **bottom** of the call panel (voice and video).
- **Diskuz logo watermark** at the **bottom** of the call area during a call (or call attempt).
- **Video call layout:** remote video fills the top area (no black bar); avatar, name, and status are hidden during video; controls stay at the bottom.
- **While a call is active:** clicking the floating button **does not** open the widget but **shows/hides** the call window (minimize); the call stays active until Hang up or F5.

### Mobile
- Audio defaults to **earpiece** (not speakerphone); cycle speaker to change output.
- **Accept / Reject** buttons are at the **bottom** of the screen.
- **Show buttons / Hide buttons:** toggle to show or hide the control row (Mute, Speaker, Video, Hang up) and the Accept/Reject row; useful to free the screen.
- **Video call:** remote video is **full screen** (WhatsApp-style); local preview is small in the **bottom-right** corner.
- **Swipe down** on the call window to hang up.
- Touch-friendly layout and controls.

### WebRTC and signaling
- **Signaling** via MessageBus (channel `/diskuz-call/signals`, filtered by recipient).
- **SDP** (offer/answer) and **ICE candidates** forwarded by the backend; ICE queue on both caller and callee for candidates that arrive before the answer; candidates are added **sequentially** to avoid timing issues.
- Default **STUN** (3 Google servers); optional **TURN** configurable by admin (JSON setting).
- **ICE failed** state handling with user message and call end.
- **DiskuzCallSend fallback** in the UI if the glue is not loaded.

### Permissions and restrictions
- **Allowed groups:** only users in the configured groups can see and use diskuz Call (default: administrators, moderators, staff).
- **"Require follow" option:** when enabled (with discourse-follow plugin), the **callee must follow the caller** to receive calls; when disabled, any allowed user can call any other allowed user. If the call is not allowed because of follow, the toast shows: **"To call NICKNAME you need to follow each other."** (US English).
- **403 with reason:** clear messages (follow_required, target_not_in_allowed_groups, caller_not_in_allowed_groups) in console and toast.
- Cannot call yourself; server-side checks for groups and follow.

### Admin settings (Plugins)
- **Enable diskuz Call:** turn the plugin on or off.
- **Who can see and use diskuz Call:** groups that can use calls (default: 1|2|3). Supports "all" or list of IDs.
- **Require the callee to follow the caller:** require the callee to follow the caller (when discourse-follow is enabled). Type: boolean.
- **Sound for incoming calls:** `none`, `default`, `ding`, `bell`, `chat`, or **`custom`** (uses the Custom ringtone URL below).
- **Custom ringtone URL:** optional. Paste the full URL of an MP3 file (e.g. from your site uploads). Used when Sound for incoming calls is set to **custom**. Recommended max size **500 KB** to avoid slowing page load.
- **ICE servers:** optional JSON for custom STUN/TURN servers; empty = Google STUN only.

### Backend API
- `GET /diskuz-call/status` — plugin state (enabled, incoming_sound, custom_ringtone_url, ice_servers, video_enabled_mobile, video_enabled_desktop).
- `GET /diskuz-call/watermark.png` — diskuz logo image for the call UI watermark.
- `PUT /diskuz-call/preferences` — user preferences.
- `GET /diskuz-call/can-call/:user_id` — check if the current user can call the given user (groups + follow).
- `POST /diskuz-call/signal` — send signal (offer, answer, ice_candidate, call_end, call_reject); delivery to recipient via MessageBus.

### Localization
- Strings and settings translated in **English** and **Italian** (client and server).

---

## Why calls or audio sometimes fail

WebRTC calls can succeed or fail (or audio may not start) depending on these factors:

1. **Network and NAT**
   - With **STUN only** (default: Google servers), two users behind “easy” NATs often connect. With **symmetric NATs** or corporate firewalls, the connection may fail.
   - **Fix:** In **Admin → Settings → Plugins → ICE servers**, configure **TURN** servers (JSON). A TURN server relays media when direct P2P fails and greatly improves call success rate.

2. **Signaling message order**
   - ICE candidates must be added to the peer connection **after** the remote description (offer/answer) and **in order**. If many candidates arrived at once and were added in parallel, that could cause intermittent errors.
   - **What the plugin does:** ICE candidates are now **queued and added one at a time** (sequentially), so order is preserved and timing-related failures are reduced.

3. **Browser audio playback**
   - On some browsers/devices the remote `<audio>` element does not start by itself (autoplay policies).
   - **What the plugin does:** When the remote audio track arrives (`ontrack`), it explicitly calls `play()` on the audio element to help audio start.

4. **Microphone permission**
   - If the user denies the microphone or the browser blocks access, the call cannot start (or the other party will not hear). Ensure the site has microphone permission (and, for video, camera).

**Summary:** For best stability, **configure TURN servers**. The plugin’s sequential ICE queue and remote-audio `play()` further improve stability and audio startup.

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

