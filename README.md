# diskuz Call

Discourse plugin for **P2P voice and video calls (WebRTC)** with built-in UI. Plugin directory name: **diskuz-call**. No theme component required.

**Authors:** diskuz.com, Cristian Deraco

---

## Installation (from zip / download link)

If you received a download link to the plugin (no repository access):

1. Download the **diskuz-call** `.zip` file from the link provided to you.
2. Extract the zip. You must get a single folder named **diskuz-call** containing `plugin.rb`, `assets`, `app`, `config`, etc.
3. Copy (or upload) that **diskuz-call** folder into your Discourse **plugins** directory, so the path is `plugins/diskuz-call/plugin.rb`.
4. Rebuild the container/site (e.g. `./launcher rebuild app` for Docker, or your host’s rebuild command).
5. In Discourse: **Admin → Plugins** → enable **diskuz.com Call**.
6. **Admin → Settings → Plugins** → enable **Enable diskuz Call**.

---

## Installation (from plugin folder)

If you already have the **diskuz-call** folder (e.g. from a zip or clone):

1. The plugin folder must be named **diskuz-call** and placed in your Discourse `plugins/` directory (e.g. `plugins/diskuz-call`).
2. Rebuild the container/site.
3. Admin → Plugins → enable **diskuz.com Call**.
4. Admin → Settings → Plugins → enable **Enable diskuz Call**.

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

## Perché a volte la chiamata o l’audio non funziona

Le chiamate WebRTC possono andare a buon fine o fallire (o l’audio può non partire) a seconda di questi fattori:

1. **Rete e NAT**
   - Con **solo STUN** (predefinito: server Google), due utenti dietro NAT “facili” spesso si connettono. Con **NAT simmetrici** o firewall aziendali il collegamento può fallire.
   - **Soluzione:** in **Admin → Settings → Plugins → ICE servers** configurare anche server **TURN** (in JSON). Un server TURN fa da relay quando la connessione diretta P2P non riesce e aumenta molto la percentuale di chiamate riuscite.

2. **Ordine dei messaggi di signaling**
   - I candidati ICE devono essere aggiunti alla peer connection **dopo** la descrizione remota (offer/answer) e **in ordine**. Se arrivano molti candidati insieme e venivano aggiunti in parallelo, potevano generare errori intermittenti.
   - **Cosa fa il plugin:** i candidati ICE vengono ora accodati e aggiunti **uno alla volta** (in sequenza), così l’ordine è rispettato e si riducono i fallimenti legati al timing.

3. **Riproduzione audio nel browser**
   - Su alcuni browser/dispositivi l’elemento `<audio>` remoto non parte da solo (politiche autoplay).
   - **Cosa fa il plugin:** quando arriva la traccia audio remota (`ontrack`) viene chiamato esplicitamente `play()` sull’elemento audio, per favorire l’avvio dell’audio.

4. **Permessi microfono**
   - Se l’utente nega il microfono o il browser blocca l’accesso, la chiamata non può partire (o l’altro non sente). Controllare che il sito abbia permesso per microfono (e, in video, per la camera).

In sintesi: per massima stabilità conviene **configurare dei server TURN**; le modifiche al plugin (coda ICE sequenziale e `play()` sull’audio remoto) migliorano ulteriormente la stabilità e l’avvio dell’audio.

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

---

## Distributing the plugin (without sharing the repository)

To let others install the plugin on their site without giving them access to the repository:

1. **Build the zip:** From the folder that contains `diskuz-call`, run:
   ```powershell
   .\diskuz-call\build-release.ps1
   ```
   This creates `diskuz-call.zip`.

2. **Upload** the zip to a download URL you control (e.g. diskuz.com, S3, or any file host). Do not use GitHub Releases if the repo is private and you want to hide it.

3. **Share only the download link** with installers. They follow **Installation (from zip / download link)** above; they never need the repository URL.
