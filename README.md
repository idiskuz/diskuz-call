# diskuz Call

Discourse plugin for **P2P voice and video calls (WebRTC)** with a built-in UI. One plugin, no theme component. Plugin directory name: **diskuz-call**.

**Authors:** diskuz.com, Cristian Deraco

---

## Installation

1. On the server where Discourse runs, go to the plugins directory (e.g. Docker: `cd /var/www/discourse`).
2. Clone: `git clone https://github.com/idiskuz/diskuz-call`
3. Rebuild (e.g. `./launcher rebuild app`).
4. **Admin → Plugins** → enable **diskuz.com Call**.
5. **Admin → Settings → Plugins** → enable **Enable diskuz Call**.

---

## Features

### Starting a call
- **Floating button** (bottom right): opens the widget to enter a username and start a call. The button is hidden when the topic composer or **chat** is open. **Admin** can turn the floating button **off** for the whole site (then only the chat Call button can start calls, if enabled).
- **Call button in chat:** in 1:1 chat, a **Call** icon in the composer starts a call with the other user. Visible only to **allowed groups**; **admin** can hide it for everyone (then only the floating button can start calls, if enabled).
- **User status:** Online, Busy, Offline (stored in the browser). Incoming calls can be auto-rejected when status is Busy or Offline.
- **Widget errors:** e.g. "You cannot call yourself.", follow/groups reasons; shown at the bottom of the widget and auto-dismiss after 5 seconds.
- **Outgoing call:** if the callee does not answer within **30 seconds**, the call ends; status and toasts show the outcome (e.g. user not available).

### During a call
- **Duration** from connection (MM:SS or HH:MM:SS).
- **Desktop — other tab / background:** if the user switches to another browser tab or minimizes the window, a **60-second** timer starts; if they do not return within 60 seconds, the call ends automatically. The media stream is not intentionally disconnected while in the background.
- **Voice and video:** toggle camera on/off; the other side sees a placeholder (avatar + duration) when video is off.
- **Blur (desktop and Android only):** optional blur of your camera image; not available on iOS (browser limitation).
- **Mute:** microphone on/off. Each **new call** starts with the mic on (mute state is not carried over).
- **Speaker — desktop:** cycles audio output (default vs other devices). **Mobile (iOS and Android):** the speaker button does **not** change the audio route; tapping it shows a message to use the **phone’s volume keys**.
- **Volume on mobile:** voice-only calls use lower remote volume (0.5); when the call has video, remote volume is set to 1. Applied on iOS and Android.
- **Hide / Show controls:** hide the control row; tap again to show. On mobile landscape the label is "Hide buttons" / "Show".
- **Ear mode (mobile):** full-screen dark overlay so you can hold the phone to your ear. Unlock by tapping the screen **3 times**. Layout: logo and slogan at the top, "Ear mode" and unlock hint in the center. **Auto-activates after 1 minute** on voice-only calls. In landscape voice-only, ear buttons are hidden and avatar/name appear bottom-left.
- **Local video preview:** fixed at top-left when video is active and draggable; position is reset when entering each video call.

### Incoming call
- **Floating button** pulses (green) when there is an incoming call.
- **Ringtone:** configurable in Admin. Options: `none`, `default`, `ding`, `bell`, `chat`, **`custom`** (user picks one of up to 10 admin MP3s in the widget, with Preview and Select), or **`alternative`** (built-in presets). Ringtone plays for up to **48 seconds**.
- **Browser notification** (if permitted) with caller name; click to focus the tab.
- **Discourse bell:** custom notification type. Incoming: "is calling you" style. **Missed:** title "Missed call" / "Chiamata persa", description includes the time (from `event_at`).
- **Incoming UI:** Accept and Reject; after accepting, Mute, Speaker, Video, Hang up, and Hide controls appear.

### Widget
- **Two pages:** home ("Call a friend") and **Notifications**. Notifications has tabs: Received, Sent, Recent, Missed (up to **10 entries per tab**). Back button returns to home. Usernames in the list are clickable to start a call.
- **Desktop:** draggable by the top bar; "diskuz Call" and "by diskuz.com" on one line. **Resizable** (min 360×560); position and size saved and restored. Hide button on both pages.
- **Mobile:** when open, the widget is full-page (covers the screen). Hide button to close.
- **Custom ringtones:** when Sound is **custom**, a Ringtones section in the widget lists admin-configured MP3s with Preview (~12 s) and Select; selection is saved per user.

### Call window
- **Desktop:** draggable, resizable window; top bar with "diskuz Call", "by diskuz.com", and Ko-fi link. Avatar, username, status, duration, then controls at the bottom. Video area with remote stream (or placeholder) and local preview.
- **Mobile:** call UI is **full-screen** (Android and iOS). **Portrait:** controls with blur at the bottom. **Landscape:** single-row top bar (logo left, then Hide buttons, Mute, Speaker, Video, Hang up, Ko-fi right) with animated background; fullscreen button for video; local preview at top-left.
- **Fullscreen (video):** desktop and mobile landscape support fullscreen on the video element (or CSS fallback on iOS).

### WebRTC
- Calls use **WebRTC** (voice and video). Default **STUN** (Google). Optional **TURN** in Admin (JSON) for stricter NATs and corporate/mobile networks.
- If the connection fails (e.g. ICE failure), a message is shown and the call ends.

### Permissions
- **Allowed groups:** only users in the configured groups can see and use diskuz Call.
- **Show floating button** (Admin): if **ON**, the floating button is shown only to allowed groups; if **OFF**, it is hidden for everyone (allowed users can still start calls from the chat Call button if that is enabled).
- **Show chat button** (Admin): if **ON**, the Call button in 1:1 chat is shown only to allowed groups; if **OFF**, it is hidden for everyone (allowed users can still start calls from the floating button if that is enabled).
- **Require follow:** when enabled (with discourse-follow), the **callee must follow the caller** to receive calls.
- **Video allowed groups:** separate setting for who can use the **Video** button during a call.
- 403 reasons (e.g. cannot_call_yourself, follow_required, group restrictions) are shown in the UI and in toasts.

### Admin settings
- **Enable diskuz Call** — master switch.
- **Who can see and use diskuz Call** — group list (e.g. `1|2|3`).
- **Show floating button** — if ON, the floating button is visible only to allowed groups; if OFF, hidden for everyone.
- **Show chat button** — if ON, the Call button in 1:1 chat is visible only to allowed groups; if OFF, hidden for everyone.
- **Require the callee to follow the caller** — when discourse-follow is enabled.
- **Primary color** — hex (e.g. `#13c98c`) for button and accents.
- **Sound for incoming calls** — `none`, `default`, `ding`, `bell`, `chat`, `custom`, `alternative`.
- **Custom ringtones 1–10** — MP3 URLs; user chooses one in the widget when Sound is **custom**.
- **Alternative ringtone** — preset when Sound is **alternative** (e.g. soft, classic, modern, festivo, marimba, relax1–5).
- **Groups that can enable video** — group list for the Video button in call.
- **ICE servers** — optional JSON array; empty = Google STUN only.
- **Debug log** — when enabled, `[diskuz-call]` messages in the browser console (F12).

### API (for integration)
- Endpoints are available for status, preferences, callability check, and signaling. See the plugin source or documentation for details.

### Localization
- **English** and **Italian** (client and server).

---

## Why calls or audio sometimes fail

- **NAT/firewall:** With STUN only, many connections work; with symmetric NATs or corporate firewalls, add **TURN** in Admin → Plugins → **ICE servers** (JSON).
- **Microphone and camera:** The user must allow microphone (and camera for video) access in the browser.
- **Recommendation:** Configure **TURN** when users report failed calls or one-way audio.

---

## If the Call button does not show

1. **Admin → Settings → Plugins:** ensure **Enable diskuz Call** is on.
2. **Who can see and use diskuz Call:** your user must be in one of the listed groups.
3. **Show floating button** / **Show chat button:** ensure the button you expect (floating or chat) is enabled in Admin.
4. **Console (F12):** look for `[diskuz-call]` messages; rebuild and hard refresh (Ctrl+F5) if the plugin does not load.

### Widget too small on desktop

Minimum size **360×560** is enforced. To reset: **F12 → Application → Local Storage** → your site → delete **diskuz_call_widget_rect** → reload.

---

## Requirements

- Discourse with MessageBus.
- Optional: **discourse-follow** for "Require the callee to follow the caller".
- Browser with WebRTC support and microphone (and camera for video).

---

## Disclaimer (public repository)

This plugin is provided as-is. If the repository is **public**:

- There is no guarantee of ongoing development, maintenance, or compatibility with future Discourse or browser versions.
- Use at your own risk; you are responsible for testing and any impact on your site.
- No warranty. For critical use, consider forking or contacting the authors for support.

---

**Version:** 0.4.0-beta · **URL:** https://github.com/idiskuz/diskuz-call
