/**
 * ALOO — Global settings store.
 * ---------------------------------------------------------------------------
 * A tiny observable store persisted to localStorage. We deliberately avoid a
 * heavy state library: settings are read from *both* React components and
 * non-React service singletons (TTS driver, STT driver, API services), so a
 * plain pub/sub singleton is the least surprising shared surface.
 *
 * SECURITY NOTE: API keys live in localStorage. That is what the PRD asks for
 * (bring-your-own-key, no server account). It means any script running on this
 * origin can read them — acceptable for a local/self-hosted assistant, NOT for
 * a multi-tenant deployment. For production, swap `apiKeys` for a server-side
 * session and drop the `x-*-api-key` headers.
 */

const STORAGE_KEY = 'aloo.settings.v1';

export const CAMERA_PRESETS = {
  CLOSEUP: 'Close-Up (Facial Focus)',
  UPPER_BODY: 'Upper Body (Standard)',
  FULL_VIEW: 'Full View',
  CINEMATIC: 'Dynamic Cinematic Camera',
};

export const VIEWPORT_MODES = {
  FULLSCREEN: 'Full Screen',
  PIP: 'Floating PIP Overlay',
  HUD: 'HUD Mode',
};

export const PROVIDERS = {
  NVIDIA: 'nvidia',
  GEMINI: 'gemini',
};

/** Curated model lists. Both providers accept free-text ids too. */
export const NVIDIA_MODELS = [
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-405b-instruct',
  'meta/llama-3.1-8b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'mistralai/mixtral-8x22b-instruct-v0.1',
  'microsoft/phi-3.5-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct',
];

export const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b',
];

/** Models we know can accept image parts (used to gate vision frame injection). */
export const VISION_CAPABLE = [
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b',
  'microsoft/phi-3.5-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct',
];

export const DEFAULT_SETTINGS = {
  // --- AI routing -----------------------------------------------------------
  provider: PROVIDERS.GEMINI,
  nvidiaApiKey: '',
  geminiApiKey: '',
  tavilyApiKey: '',
  nvidiaModel: NVIDIA_MODELS[0],
  geminiModel: GEMINI_MODELS[0],
  temperature: 0.7,
  maxTokens: 1024,
  systemPrompt:
    'You are ALOO, a warm, quick-witted holographic AI companion from the year 2100. ' +
    'Speak naturally and conversationally — your words are spoken aloud, so avoid ' +
    'markdown tables, code fences and bullet spam unless explicitly asked. Keep ' +
    'answers tight unless depth is requested.',

  // --- Voice ----------------------------------------------------------------
  sttEnabled: false,
  sttLanguage: 'en-US',
  handsFree: false, // auto re-arm the mic after ALOO finishes speaking
  vadSilenceMs: 1400, // silence duration that ends an utterance
  ttsEnabled: true,
  ttsVoiceURI: '',
  ttsRate: 1.02,
  ttsPitch: 1.0,
  ttsVolume: 1.0,
  // Optional high-fidelity neural TTS. Any endpoint that accepts
  // POST { text, voice } and replies with audio bytes (audio/mpeg, audio/wav…)
  // will be used instead of the browser engine — and because we decode it
  // ourselves, lip-sync is driven by the REAL waveform rather than an estimate.
  neuralTtsUrl: '',
  neuralTtsVoice: '',
  neuralTtsKey: '',

  // --- Vision ---------------------------------------------------------------
  cameraEnabled: false,
  visionCaptureMs: 2500, // snapshot cadence while camera is live
  visionQuality: 0.7, // JPEG quality 0..1
  visionAttachLatest: true, // inject newest frame into the next prompt

  // --- 3D viewport ----------------------------------------------------------
  avatarModelUrl: '/models/avatar.glb',
  spaceModelUrl: '/models/space.glb',
  cameraPreset: CAMERA_PRESETS.UPPER_BODY,
  viewportMode: VIEWPORT_MODES.FULLSCREEN,
  avatarScale: 1.0,
  avatarOffsetX: 0,
  avatarOffsetY: 0,
  avatarOffsetZ: 0,
  canvasOpacity: 1.0,
  orbitEnabled: true,
  minPolar: 55, // degrees — stops the user orbiting under the floor
  maxPolar: 105,
  minAzimuth: -75,
  maxAzimuth: 75,
  minZoom: 0.7,
  maxZoom: 4.5,
  ambientRotationSpeed: 0.015, // space background drift
  particleDensity: 1400,
  bloomIntensity: 0.9,

  // --- HUD ------------------------------------------------------------------
  hudGrid: true,
  hudScanlines: true,
  showVisualizer: true,
  showTelemetry: true,

  // --- Research -------------------------------------------------------------
  researchDepth: 3, // number of sub-queries per research run
  researchResultsPerQuery: 5,
};

let state = { ...DEFAULT_SETTINGS };
const listeners = new Set();
let hydrated = false;

/** Read persisted settings once, on the client. Safe to call repeatedly. */
export function hydrateSettings() {
  if (hydrated || typeof window === 'undefined') return state;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Merge over defaults so newly-added keys appear for existing users.
      state = { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (err) {
    console.warn('[ALOO/settings] Could not read localStorage:', err);
  }
  emit();
  return state;
}

export function getSettings() {
  return state;
}

export function setSettings(patch) {
  state = { ...state, ...patch };
  persist();
  emit();
  return state;
}

export function resetSettings() {
  // Keep the keys — nobody wants to re-paste credentials after a UI reset.
  const { nvidiaApiKey, geminiApiKey, tavilyApiKey } = state;
  state = { ...DEFAULT_SETTINGS, nvidiaApiKey, geminiApiKey, tavilyApiKey };
  persist();
  emit();
  return state;
}

export function subscribeSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      console.error('[ALOO/settings] listener threw:', err);
    }
  });
}

function persist() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[ALOO/settings] Could not persist localStorage:', err);
  }
}

/** Active model id for the currently selected provider. */
export function activeModel(s = state) {
  return s.provider === PROVIDERS.NVIDIA ? s.nvidiaModel : s.geminiModel;
}

/** Whether the active model can accept image parts. */
export function activeModelSupportsVision(s = state) {
  return VISION_CAPABLE.includes(activeModel(s));
}
