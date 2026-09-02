# ALOO — Autonomous Linked Optical Operator

A Year-2100 3D interactive AI assistant for the browser: a rigged WebGL avatar
that lip-syncs to synthesised speech, sees through your webcam, listens
hands-free, routes to either **NVIDIA NIM** or **Google Gemini**, and runs an
autonomous multi-step deep-research pipeline over the live web.

Everything renders inside a glassmorphic sci-fi HUD. **It boots and works with
zero 3D assets** — drop in your own `.glb` when you have one.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

Or build the Android app:

```bash
npm run android:apk  # -> android/app/build/outputs/apk/debug/app-debug.apk
```

Then open the **control drawer** (gear, top right) → **API Keys** and paste at
least one key:

| Provider | Where to get a key | Free tier |
|---|---|---|
| Google Gemini | <https://aistudio.google.com/app/apikey> | yes |
| NVIDIA NIM | <https://build.nvidia.com> → pick a model → *Get API Key* | yes |
| Tavily (optional, improves Deep Research) | <https://tavily.com> | yes |

Keys are stored in this browser's `localStorage` and sent only to this app's own
server routes, which forward them upstream. Nothing is persisted server-side.

### Optional: server-side fallback keys

```bash
cp .env.example .env.local   # then fill in whichever keys you want as defaults
```

A request that arrives without a client key falls back to these.

### Production

```bash
npm run build && npm start
```

---

## Android APK

ALOO ships as a Capacitor app as well as a website. Everything — the 3D avatar,
the galaxy, both bundled models — is baked into the APK, so it runs without a
server.

```bash
npm run android:apk
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk` (~10 MB). Push it
with `adb install -r <path>`, or side-load it directly. CI builds it too — see
`.github/workflows/android-apk.yml`, which uploads the APK as a run artifact.

### How the native build differs

| | Web | Android APK |
|---|---|---|
| Reaches providers via | `/api/*` edge routes on this origin | direct calls through Capacitor's native HTTP bridge |
| CORS | solved by the proxy | not applicable — native HTTP is not subject to it |
| Token streaming | ✅ live SSE | ❌ the bridge buffers; replies arrive whole |
| Speech **input** | ✅ Chrome/Edge | ❌ Android WebView does not expose the Web Speech API |
| Speech **output**, lip-sync, vision, deep research, 3D | ✅ | ✅ |

`lib/runtime.js` detects which shell it is running in and picks the endpoints;
nothing above the service layer knows the difference. The mic control hides
itself where speech input is unavailable rather than failing at tap time.

The static export needs one wrinkle: `output: 'export'` refuses to build while
API routes exist, and the web build genuinely needs them. `scripts/build-static.mjs`
moves `pages/api` aside for the export and restores it in a `finally` plus
signal handlers, so an interrupted build cannot leave the repo without its
routes.

---

## Mobile layout

Below 768px the interface switches from floating panels to a tabbed bottom
sheet, because a phone has no gutters for panels to float in:

- **COMMS** — conversation and composer
- **DEEP** — the research pipeline and its sources
- **DATA** — every telemetry card from the desktop gutters (neural core, rig
  diagnostics with the full log, camera telemetry, subsystems) plus the camera
  preview

Nothing is dropped on mobile; the DATA tab exists precisely so the diagnostics
stay reachable at 390px. The sheet has two snap positions rather than free
dragging — a drag gesture on top of a WebGL canvas fights OrbitControls for the
same touch events. Voice, speaker and camera toggles live on a thumb-reachable
right-edge rail, tap targets are ≥44px, the composer uses 16px text (anything
smaller makes iOS Safari zoom the page), and the layout is sized in `dvh` so the
collapsing address bar cannot hide the input.

---

## Architecture blueprint

```
┌─────────────────────────────── BROWSER ───────────────────────────────┐
│                                                                       │
│  pages/index.jsx  ── composition root, 5 stacked layers ──────────┐    │
│    z0  AvatarCanvas ....... WebGL: avatar + space + camera        │    │
│    z20 SciFiHudOverlay .... grid, scanlines, telemetry (inert)    │    │
│    z25 ChatWindow / LiveCameraPreview / DeepResearchPanel / dock  │    │
│    z40 SettingsDrawer                                             │    │
│                                                                   │    │
│  hooks/useAlooBrain.js ── the conductor ───────────────────────────┘    │
│    │  conversation state · provider routing · vision attach ·          │
│    │  voice turn-taking · research runs · abort handling               │
│    ├── services/aiRouter.js ──┬── nvidiaNimService.js                  │
│    │                          └── geminiService.js                     │
│    ├── services/researchService.js   plan → search → read → synthesise │
│    ├── services/sttService.js        Web Speech API + custom VAD       │
│    ├── services/ttsLipSyncService.js speech → viseme frame  ───────┐   │
│    └── hooks/useWebcam.js            frames → base64 JPEG          │   │
│                                                                    │   │
│  lib/audioGraph.js  one AudioContext: mic ∥ TTS ∥ synthetic  ──────┤   │
│  lib/settingsStore.js  observable + localStorage                   │   │
│                                                                    ▼   │
│  components/3d/AvatarCanvas.jsx  useFrame() reads lipSync.frame 60×/s  │
│    ├── RiggingValidator.js   skeleton + blendshape diagnostics         │
│    ├── SpaceBackground.jsx   space.glb, else procedural starfield      │
│    └── CameraController.jsx  OrbitControls + preset director           │
└───────────────────────────────────────┬───────────────────────────────┘
                                        │  (same origin — no CORS)
┌───────────────────────────────── EDGE RUNTIME ────────────────────────┐
│  /api/nim/chat      → integrate.api.nvidia.com   SSE passthrough       │
│  /api/gemini/chat   → generativelanguage.google  SSE passthrough       │
│  /api/search        → Tavily → DuckDuckGo → Wikipedia, + page reader   │
└───────────────────────────────────────────────────────────────────────┘
```

### Why the proxies exist

Neither upstream sends CORS headers for browser origins, so a direct `fetch()`
from the page is blocked outright. Routing through **edge** routes also means
the SSE body is piped through unbuffered (first-token latency stays as low as
the upstream allows) and API keys never appear in a URL the browser's history or
referrer headers could leak.

---

## How the interesting parts work

### 1. Lip-sync — two paths, one output

`services/ttsLipSyncService.js` writes into a single mutable frame object that
`AvatarCanvas` samples inside `useFrame`. Nothing about the mouth ever passes
through React state — a 60fps face must not touch the reconciler.

**Neural path** (when a TTS endpoint is configured): audio bytes → `decodeAudioData`
→ `AudioBufferSourceNode` → shared gain → `AnalyserNode` → speakers. Because the
audio flows through our own analyser we read real amplitude and spectral
centroid every frame, and pick the mouth shape from measured sound: dark
spectrum → `O`/`U`, bright → `E`/`I`.

**Browser path** (default, zero-config): `window.speechSynthesis` plays through
the OS mixer and exposes no `MediaStream` — its waveform is unreachable from
JavaScript, full stop. So we build a *predicted* viseme timeline from the text
(digraph-aware grapheme → viseme mapping, vowels held ~1.8× longer than
consonants), run it on a clock, and re-anchor that clock on every `onboundary`
word event the engine fires so drift cannot accumulate across a paragraph.

Both paths feed the HUD spectrum visualiser through `lib/audioGraph.js`.

### 2. Rigging validation

`components/3d/RiggingValidator.js` exports `validateModelRigging(gltf)`, which
walks the imported scene and reports:

- skeleton presence, bone count, armature roots;
- whether the bones ALOO actually drives exist (head, neck, spine, arms, eyes);
- viseme coverage (`viseme_aa` … `viseme_U`), with `mouthOpen`/`jawOpen` as a
  documented fallback, and a jaw-bone rotation fallback below that;
- blink/expression morphs, baked animation clips, triangle and bone budgets.

Bone matching is deliberately **fuzzy**: Mixamo prefixes `mixamorig:`, VRM uses
`J_Bip_C_Head`, ReadyPlayerMe uses plain `Head`, Blender exports `DEF-spine`.
Exact string comparison would report a perfectly good rig as broken.

The report is printed to the console as a grouped table *and* rendered live in
**Settings → Rig Diagnostics**, graded `PASS` / `DEGRADED` / `PARTIAL` / `FAIL`.

### 3. Voice activity detection

`services/sttService.js` runs the recogniser in `continuous` mode, which never
tells you when a human finished a thought. Two signals must agree before we
commit an utterance:

1. no new interim transcript for `vadSilenceMs`, **and**
2. mic RMS below the noise floor for the same window.

Requiring both avoids cutting someone off mid-pause and avoids hanging forever
on room noise the recogniser never turns into words.

The mic is **closed while ALOO speaks**. Without that, browser TTS is transcribed
by the recogniser and the assistant talks to itself in an infinite loop.

### 4. Deep research

`services/researchService.js` runs four stages, each reported to the UI:

1. **Plan** — the active LLM decomposes the question into N orthogonal search
   queries (JSON out, defensively parsed, heuristic fallback if it misbehaves).
2. **Search** — every sub-query hits `/api/search` in parallel; results are
   deduplicated by URL.
3. **Read** — the top ~6 pages are fetched and reduced to plain text. This is the
   RAG step: real page bodies, not just snippets.
4. **Synthesise** — the corpus is streamed back through the LLM with an
   instruction to cite every claim by source number.

`DeepResearchPanel` renders the stages as a live timeline with the sub-queries
and the numbered source list that the `[n]` citations point at.

### 5. Vision

`hooks/useWebcam.js` owns the `MediaStream` lifecycle, rasterises the current
frame to a **downscaled** base64 JPEG (640px wide — a 1280×720 frame costs ~4×
the tokens for no accuracy gain on scene questions), and keeps the newest frame
available synchronously so a prompt sent at any moment carries what ALOO is
seeing right now.

Frames are stripped automatically when the selected model has no vision
capability, so a webcam frame can never 400 a text-only model.

---

## Adding your own 3D models

Drop files into `public/models/`:

| File | Purpose |
|---|---|
| `avatar.glb` | Foreground character. Needs a skeleton; visemes strongly recommended. |
| `space.glb` | Background environment. Auto-recentred and placed behind the avatar. |

Both paths are editable in **Settings → Holographic Projection** (a remote
`https://` URL works too). Draco-compressed GLBs are supported.

**The fastest path to a fully-rigged avatar:** create one free at
[readyplayer.me](https://readyplayer.me) and append
`?morphTargets=ARKit,Oculus%20Visemes` to the download URL. That export ships the
complete `viseme_*` set and passes the validator with `PASS`.

Without any model, ALOO renders a procedural holo-construct driven by the exact
same lip-sync frame — voice, vision and AI are all fully demonstrable first.

---

## Controls

| Action | Shortcut |
|---|---|
| Send message | `Enter` |
| Newline | `Shift` + `Enter` |
| Deep research | `Ctrl`/`Cmd` + `Enter` |
| Orbit / zoom the avatar | drag / scroll on the canvas |

Camera presets: **Close-Up**, **Upper Body**, **Full View**, **Dynamic
Cinematic**. Viewport modes: **Full Screen**, **Floating PIP Overlay**,
**HUD Mode**.

---

## Browser support

| Feature | Chrome / Edge | Safari | Firefox |
|---|---|---|---|
| 3D avatar, HUD, chat, vision | ✅ | ✅ | ✅ |
| Speech **output** (TTS) | ✅ | ✅ | ✅ |
| Speech **input** (STT) | ✅ | ❌ | ❌ |

`webkitSpeechRecognition` ships only in Chromium browsers. The mic control hides
itself where it is unavailable rather than failing at click time.

---

## Project layout

```
components/
  3d/      AvatarCanvas · SpaceBackground · CameraController · RiggingValidator
  ui/      SciFiHudOverlay · SettingsDrawer · AudioVisualizer · LiveCameraPreview
           MobileShell
  chat/    ChatWindow · DeepResearchPanel
services/  nvidiaNimService · geminiService · aiRouter · researchService
           sttService · ttsLipSyncService
hooks/     useAlooBrain · useWebcam · useSettings · useAssetAvailable · useIsMobile
lib/       settingsStore · audioGraph · sseStream · markdown · runtime
           searchProviders
pages/     index.jsx · _app.jsx · _document.jsx
           api/nim/chat · api/gemini/chat · api/search
scripts/   build-static.mjs
android/   Capacitor native project
```

---

## Security notes

- **Keys in `localStorage`** is what bring-your-own-key requires, and it means
  any script on this origin can read them. Fine for a local or self-hosted
  assistant; for a multi-tenant deployment, replace `apiKeys` in
  `lib/settingsStore.js` with a server-side session and drop the `x-*-api-key`
  headers.
- **Model output is untrusted.** `lib/markdown.js` escapes all HTML *first* and
  only then re-introduces its own tags, and refuses to build anchors for
  anything other than `http(s)` URLs.
- **The page reader refuses private addresses** (loopback, RFC1918, link-local),
  so a crafted "source" cannot pull an internal service through the server.
