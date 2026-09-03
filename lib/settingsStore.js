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
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'meta/llama-3.1-405b-instruct',
  'meta/llama-3.1-8b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-7b-instruct',
  'mistralai/mixtral-8x22b-instruct-v0.1',
  'microsoft/phi-3.5-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct',
];

/**
 * Newest first. The 1.5 line is kept at the bottom for older keys, but Google
 * has been retiring it — if a request 404s on a 1.5 id, move up this list.
 */
export const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

/** Models we know can accept image parts (used to gate vision frame injection). */
export const VISION_CAPABLE = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'microsoft/phi-3.5-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct',
];

/**
 * The persona is the single biggest lever on answer quality, so it is written
 * as explicit behaviour rules rather than adjectives. Two things it fixes that
 * a generic prompt does not:
 *   • Replies are SPOKEN aloud, so markdown scaffolding actively hurts.
 *   • A companion that mirrors the user's language keeps a conversation alive;
 *     one that always answers in English ends it.
 */
export const DEFAULT_PERSONA = [
  'You are ALOO — a warm, sharp, genuinely curious holographic companion projected from the year 2100.',
  '',
  'HOW YOU TALK',
  '- Your words are spoken aloud by a voice engine. Write like a person speaking, not like a document.',
  '- Never use markdown headings, tables, bullet lists or code fences unless the user explicitly asks for structure or for code.',
  '- Default to 2-4 sentences. Go long only when the question genuinely needs it.',
  '- Answer the actual question first, then add colour. Never open with filler like "Great question!".',
  '- Mirror the user\'s language exactly. If they write Hinglish, reply in Hinglish. If Hindi, reply in Hindi. If English, English.',
  '',
  'HOW YOU THINK',
  '- Be concrete. Prefer a specific example over an abstract description.',
  '- If you are unsure or lack current information, say so plainly and offer to run deep research instead of guessing.',
  '- Never invent facts, numbers, links or citations.',
  '- Disagree when you have reason to. Agreeing with everything is not warmth, it is uselessness.',
  '',
  'WHAT YOU CAN DO (mention only when relevant)',
  '- You can see through the camera when the operator enables the optic feed.',
  '- You can research the live web in depth on request.',
  '- You have a physical holographic body that reacts as you speak.',
].join('\n');

export const DEFAULT_SETTINGS = {
  // --- AI routing -----------------------------------------------------------
  provider: PROVIDERS.GEMINI,
  nvidiaApiKey: '',
  geminiApiKey: '',
  tavilyApiKey: '',
  nvidiaModel: NVIDIA_MODELS[0],
  geminiModel: GEMINI_MODELS[0],
  temperature: 0.8,
  maxTokens: 2048,
  systemPrompt: DEFAULT_PERSONA,

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
  // Selection is by LIBRARY ENTRY ID, not by URL: an uploaded model's object
  // URL is minted fresh each session, so a persisted URL would break on reload.
  // See lib/modelLibrary.js.
  avatarModelId: 'builtin:avatar',
  spaceModelId: 'builtin:space',
  // Kept for the "paste a path" escape hatch and for anyone editing settings
  // directly; the library overrides these when an entry is selected.
  avatarModelUrl: '/models/avatar.glb',
  spaceModelUrl: '/models/space.glb',
  // Imported models arrive in wildly different units (this project's avatar is
  // ~23 units tall). Auto-fit measures the bounding box on load and normalises
  // to `avatarTargetHeight` metres with the feet on the floor, so a new model
  // never needs manual slider hunting.
  autoFit: true,
  avatarTargetHeight: 1.72,
  // The bundled space model is a galaxy disc (~8k star quads), not a skybox.
  // It is therefore normalised to a half-width and pushed back behind the
  // avatar rather than wrapped around the camera — inside the disc the
  // individual star quads read as grey slabs, not stars.
  spaceFitRadius: 95,
  spaceOffsetY: 14,
  spaceOffsetZ: -190,
  spaceTilt: 24,
  // T-posed rigs look like a mannequin. When no idle clip ships with the model,
  // ALOO rotates the upper-arm bones down into a relaxed A-pose on load.
  autoAPose: true,
  // 74°, not 62°: at 62 the arms still stand visibly away from the body. The
  // angle is measured down from the T-pose, so larger = arms closer in.
  aPoseAngle: 74,
  // A dead-straight arm and a flat splayed hand are the two clearest
  // "mannequin" cues on an otherwise good rig.
  elbowBend: 11,
  fingerCurl: 12,

  // --- Presence / interaction ----------------------------------------------
  idleLookAround: true, // glance away and back so she does not stare
  weightShift: true, // slow hip roll — nobody stands perfectly still
  tapReaction: true, // tap the avatar: she looks at you and waves
  speakOnTap: false, // …and greets you out loud (local TTS, no API call)
  // Jaw-bone lip-sync, used when a rig has no viseme blendshapes. Bind
  // orientation differs per rig, so the axis and direction are configurable.
  // The hinge axis is derived from the rig automatically; only the swing and
  // direction remain adjustable.
  jawOpenAngle: 22,
  jawInvert: false,
  eyeTracking: true,
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
