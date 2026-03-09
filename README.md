# diskuz Call

**Discourse** plugin that enables **P2P voice calls (WebRTC)** with a built-in UI. Single plugin, no theme component required. Plugin directory name: **diskuz-call**.

**Authors:** diskuz.com, Cristian Deraco

---

## Installation

Installation is done **on the server** by cloning the GitHub repository into your Discourse plugins directory.

1. **On the server** where Discourse runs, go to the plugins directory (e.g. for Docker: `cd /var/www/discourse` then into the folder that contains `plugins`, or the path used by your installation).
2. Clone the repository:
   ```bash
   git clone https://github.com/idiskuz/diskuz-call
   ```
   This creates the `diskuz-call` folder with `plugin.rb`, `assets`, `app`, and `config` inside it.
3. Rebuild the container/site (e.g. with Docker: `./launcher rebuild app`, or your installation’s rebuild command).
4. In Discourse: **Admin → Plugins** → enable **diskuz.com Call**.
5. **Admin → Settings → Plugins** → turn on **Enable diskuz Call**.

---

## Features

### Calls
- **Voice and video call** between two users (WebRTC). Video can be toggled on/off during the call; when one user turns video off, the other sees a placeholder (avatar + duration) instead of a black frame.
- **Floating button** (bottom right): opens the widget to start a call (enter username). The button is **hidden** when the Discourse composer (new post / reply) is open or when **chat is open** (drawer or full-page), because the chat has its own **Call** button in the composer for 1:1 conversations.
- **Chat call button:** in the Discourse chat composer (1:1 channel), a **Call** (phone) button starts a call with the other user in the channel. When a chat is open, only this button is used; the floating button stays hidden.
- **User status:** **Online**, **Busy**, **Offline** (Italian: **Occupato** for Busy). Status is saved in the browser (localStorage) and restored on reload; default on first load is **Online**. Incoming calls can be auto-rejected when status is Busy or Offline.
- **Widget errors:** entering your own username shows "You cannot call yourself." (not "User not found"); calling a user who doesn't follow you (when require-follow is on) shows the exact reason at the bottom of the widget ("You cannot call a user who doesn't follow you."). If the signal send fails (403, network), the operation ends immediately and the error is shown at the bottom of the main widget. All errors at the bottom of the widget **disappear automatically after 5 seconds**.
- **Outgoing call timeout:** if the callee doesn't answer within ~50 seconds, the call ends and the status message shows "User not available or not connected." Reject reasons (busy, not available, rejected) are shown in the call window status line and as a toast before the UI closes.
- **Notifications** (call history): second page of the main widget (same layout and position). Clicking **Notifications** opens the Notifications view with tabs **Received**, **Sent**, **Recent**, **Missed** (up to 10 entries per tab). A prominent **← Indietro / ← Back** button in the header returns to the "Call a friend" page. All nicknames are clickable to start a call. Time in **HH:mm**; for completed calls, **duration** is shown (e.g. **Duration mm:ss** or **hh:mm:ss** if ≥ 1 hour). Notifications have a time limit to act (e.g. 10 s) and to answer when on the page (e.g. 30 s).

### During a call
- **Duration timer** from connection time (MM:SS or HH:MM:SS); it is not reset when switching between voice-only and video.
- **Video:** toggle camera on/off during the call. When you turn video off, the other user sees your placeholder (avatar + duration on a styled background) instead of a black screen; when they turn video off, you see the same. Turning video back on restores the live stream on both sides.
- **Mute:** turn off microphone; button shows "Muted" when active.
- **Speaker:** on **desktop**, cycles audio outputs (default → other devices). On **mobile**, when the browser supports it, opens the **native audio output picker** (e.g. earpiece, speaker, Bluetooth) so the user chooses where to hear the call from the device UI (similar to Meet); otherwise a message suggests using the device’s volume keys or sound settings.
- **Hang up:** end the call.
- **Hide / Show buttons:** hide the control row (Mute, Speaker, Hang up) toward the bottom; one tap/click shows it again.
- **Ear mode** (mobile): full-screen overlay (dark screen) so you can put the phone to your ear; tap to dismiss. On iPhone the overlay is brought to the front so it stays visible.

### Incoming call
- The **floating button** **pulses** (green) to draw attention.
- **Configurable ringtone:** **Sound for incoming calls** can be: `none`, `default`, `ding`, `bell`, `chat`, **`custom`** (user picks one of up to 10 admin-configured MP3s in the widget, with preview), or **`alternative`** (built-in presets). Ringtone plays for up to **48 seconds**. Default built-in preset when not set by admin: **ringtone 3 (soft)**.
- **Custom ringtones (widget):** when Sound is **custom**, the widget shows a **Suonerie / Ringtones** block: each item has **Preview** (plays ~12 s) and **Seleziona / Select**; playback stops immediately when starting another preview or when clicking Select. Selected ringtone is saved per user.
- **Browser notification** (when permitted) with caller name.
- **Discourse bell notification** with text such as "Calling you" and icon.
- **Incoming UI** with **Accept** and **Reject**. If the window does not appear automatically, clicking the flashing floating button opens the screen with Accept/Reject. Only Accept and Reject are shown while ringing; Mute, Speaker, and Hang up appear after accepting.

### Main widget
- **Top bar** (desktop): draggable by the top bar to move the widget; **diskuz Call** (green) and **by diskuz.com** are on the **same line**. The widget has two pages: "Call a friend" (home) and Notifications; switching between them keeps the same window position and size.
- **Desktop size and resize:** default size **360×520** px. Widget is **resizable** like a window (drag the edge/corner); **minimum 360×520** is enforced so a shrunk size is never saved or restored. Position and size are saved to localStorage and restored on reopen; ResizeObserver updates the saved size when the user resizes.
- **Center phrase:** the home page shows a line such as "Call people who follow you on [site name]." The site name is taken from the page (e.g. meta og:site_name or document title).
- **Description:** below the Notifications button, a short text explains the widget: "This widget lets you call your friends on [site]. Set your status to Online to receive calls, or use Busy and Offline if you don't want to be disturbed."
- **Hide button:** on both home and Notifications pages, a **Hide** (Italian: **Nascondi**) button closes the widget. When the widget is closed it is fully hidden (no transparent clickable area).
- **Layout:** the username field is spaced from the Call button. **Border-radius 15px** on the whole widget. Buttons use a frosted blur style (semi-transparent with backdrop blur).
- **Notifications page:** header with a visible **← Indietro / ← Back** button (green, solid) to return to the home page; tabs **Received, Sent, Recent, Missed**; list scrollable with a **minimal styled scrollbar** (thin, green); up to **10 records per tab**; footer with **Hide**.
- **Mobile:** when the widget is open it is **full page**: it covers the entire screen. The user closes it with **Hide** to see the site again. Buttons are larger and use a stronger frosted effect for easier tapping.

### Call window
- **Top bar** (desktop): draggable; shows **diskuz Call** (green) and **by diskuz.com** on the **same line**. Used to move the call window.
- **Content order:** avatar, username, status (e.g. "Calling..." / "In call..."), then **diskuz Call** logo + by diskuz.com + slogan *Real Conversations, No Algorithms :-)*, then duration, then controls at the **bottom** (Hide, Mute, Video, Speaker, Hang up). When video is on, local preview and remote video (or placeholder when the other has video off) are shown.
- **Desktop:** window is **resizable** like the widget (same min 360×520); position and size follow the widget when opening and are saved (ResizeObserver); when hidden, controls slide off the bottom. Opening/closing the call UI uses a short vortex animation toward/from the floating button.
- **Mobile:** full-screen call UI; controls at bottom; Ear mode available.

### WebRTC and signaling
- **Signaling** via MessageBus (channel `/diskuz-call/signals`, filtered by recipient).
- **SDP** (offer/answer) and **ICE candidates** forwarded by the backend; ICE queue on both sides for candidates that arrive before the answer; candidates added sequentially.
- Default **STUN** (Google servers); optional **TURN** configurable by admin (JSON). TURN improves success on symmetric NATs and corporate/mobile networks.
- **ICE failed** handling with user message and call end.
- **DiskuzCallSend** fallback in the UI if the glue is not loaded.

### Permissions and restrictions
- **Allowed groups:** only users in the configured groups can see and use diskuz Call (default: administrators, moderators, staff).
- **Require follow:** when enabled (with discourse-follow), the **callee must follow the caller** to receive calls. If the call is not allowed, the UI shows "You cannot call a user who doesn't follow you." (or equivalent in Italian).
- **403 reasons:** clear messages (cannot_call_yourself, follow_required, target_not_in_allowed_groups, caller_not_in_allowed_groups) in response, toast, and in the call window status before it closes.
- Cannot call yourself (widget shows "You cannot call yourself."); server-side checks for groups and follow.

### Admin settings (Plugins)
- **Enable diskuz Call:** turn the plugin on or off.
- **Who can see and use diskuz Call:** groups that can use calls (default: 1|2|3). Supports "all" or list of group IDs.
- **Require the callee to follow the caller:** when discourse-follow is enabled. Boolean.
- **Primary colour:** hex colour (e.g. `#13c98c`) for the floating button, accents, and backgrounds. A darker shade is computed automatically for gradients. Default: `#13c98c`.
- **Sound for incoming calls:** `none`, `default`, `ding`, `bell`, `chat`, **`custom`** (user chooses one of up to 10 MP3s in the widget), or **`alternative`** (built-in presets). Ringtone plays up to 48 seconds.
- **Custom ringtones (1–10):** up to 10 settings `diskuz_call_custom_ringtone_1` … `diskuz_call_custom_ringtone_10`; each is a full or relative MP3 URL. Used when Sound is **custom**; the user picks one in the widget (Preview + Select). Recommended max size ~500 KB per file.
- **Alternative ringtone:** used when Sound is **alternative**. Presets: classic, modern, soft, double, melodic, retro, digital, pulse, star, cascade; lively: festivo, allegro, vivace, brillante, energico, dinamico, scintilla, campanella, trillo, marimba; relax: relax1–relax5. **Default when not set: soft (ringtone 3).**
- **ICE servers:** optional JSON array for STUN/TURN; empty = Google STUN only. Example: `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]`.

### Backend API
- `GET /diskuz-call/status` — plugin state: enabled, incoming_sound, **primary_color**, **primary_color_dark**, **custom_ringtones** (array), **custom_ringtone_url** (selected URL), **alternative_ringtone**, ice_servers.
- `GET /diskuz-call/watermark.png` — diskuz logo image for the call UI.
- `PUT /diskuz-call/preferences` — user preferences (e.g. **selected_custom_ringtone_index** for custom ringtone choice).
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
   The plugin calls `play()` on the remote audio element when the track arrives to help with autoplay policies.

4. **Microphone permission**  
   The user must allow the microphone; without it, the other party will not hear.

**Summary:** For best stability, **configure TURN servers** when needed.

---

## If the Call button does not show

1. **Admin → Settings → Plugins:** ensure **Enable diskuz Call** is enabled.
2. **Who can see and use diskuz Call:** your user must be in one of the allowed groups (e.g. add the correct group ID).
3. **Console (F12):** look for `[diskuz-call]` messages. If none, rebuild and hard refresh (Ctrl+F5).

### If the widget appears too small on desktop

The plugin enforces a **minimum size (360×520 px)** when saving and restoring the widget; a previously saved “shrunk” size is no longer applied. If you still see an old narrow layout, clear the stored rect: **F12 → Application → Local Storage** → select your site → delete the key **diskuz_call_widget_rect**. Reload the page; the widget will open at default size and position.

---

## Requirements

- Discourse with MessageBus.
- Optional: **discourse-follow** for the “Require the callee to follow the caller” option.
- Browser with WebRTC support and microphone access.

---

## Disclaimer (public repository)

This plugin is provided as-is. If the repository is **public**:

- **There is no guarantee of continuous development, maintenance, or updates.** The authors are not committed to releasing new versions, fixing bugs, or keeping the plugin compatible with future Discourse or browser versions.
- **Use at your own risk.** You are responsible for testing the plugin in your environment and for any impact on your community or infrastructure.
- **No warranty** is given. For critical deployments, consider forking the repository and maintaining your own version, or reaching out to the authors for commercial or dedicated support if available.

---

**Version:** 0.4.0-beta · **URL:** https://github.com/idiskuz/diskuz-call
