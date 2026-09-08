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

/**
 * Curated NIM model ids — a SEED list, not the truth.
 *
 * NVIDIA retires hosted models on a rolling schedule, and a retired id is not a
 * soft failure: `/v1/chat/completions` answers 410 ("has reached its end of
 * life") for a recently-retired id and a bare 404 ("404 page not found", the Go
 * router's default) once the route is gone entirely. A hard-coded list is
 * therefore guaranteed to rot — every id in the original list here was dead
 * within a year.
 *
 * So this list exists only to populate the dropdown before the network answers.
 * `lib/modelCatalog.js` fetches the LIVE catalogue from /v1/models (that
 * endpoint needs no auth) and replaces this at runtime, and `migrate()` below
 * repairs a saved id that has since been retired. Every id here was verified
 * live against the API at the time of writing.
 */
export const NVIDIA_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-nano-3-30b-a3b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'moonshotai/kimi-k3',
  'deepseek-ai/deepseek-v4-flash-0731',
  'deepseek-ai/deepseek-v4-pro-0813',
  'openai/gpt-oss-20b',
  'google/gemma-4-31b-it',
  'minimaxai/minimax-m3',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'meta/llama-3.2-90b-vision-instruct',
];

/**
 * Ids we KNOW are gone upstream. Keeping the graveyard explicit lets `migrate()`
 * silently move a user off a dead id on the next load instead of leaving them
 * staring at a 404 they cannot diagnose.
 */
export const RETIRED_MODELS = new Set([
  'meta/llama-3.3-70b-instruct',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'meta/llama-3.1-405b-instruct',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.1-70b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-7b-instruct',
  'mistralai/mixtral-8x22b-instruct-v0.1',
  'mistralai/mixtral-8x7b-instruct-v0.1',
  'microsoft/phi-3.5-vision-instruct',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
]);

/** Newest first. The 1.5 line is retired upstream and deliberately absent. */
export const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
];

/** Models we know can accept image parts (used to gate vision frame injection). */
export const VISION_CAPABLE = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'meta/llama-3.2-90b-vision-instruct',
  'meta/llama-3.2-11b-vision-instruct',
  'nvidia/cosmos-reason2-8b',
  'nvidia/vila',
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
  sttLanguage: 'en-IN',
  handsFree: false, // auto re-arm the mic after ALOO finishes speaking
  vadSilenceMs: 1400, // silence duration that ends an utterance
  ttsEnabled: true,
  /**
   * The language ALOO SPEAKS, kept separate from the language she LISTENS for.
   * They were one setting, which meant you could not have an Indian-accented
   * voice without also forcing the recogniser onto that locale, and vice versa.
   *
   * en-IN is the default because the engine's accent follows the locale: on
   * Android, Google's TTS ships Indian English, and this is the whole of what
   * makes her sound Indian rather than American. No extra service required, and
   * it works offline inside the APK.
   */
  ttsLanguage: 'en-IN',
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
  avatarModelId: 'builtin:miku',
  spaceModelId: 'builtin:space',
  // Kept for the "paste a path" escape hatch and for anyone editing settings
  // directly; the library overrides these when an entry is selected.
  avatarModelUrl: '/models/miku.glb',
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
  // Placement of the environment model, for when it is selected as the
  // backdrop. These are the values the model was authored around.
  spaceFitRadius: 95,
  spaceOffsetX: 0,
  spaceOffsetY: 14,
  spaceOffsetZ: -190,
  spaceTilt: 24,
  // T-posed rigs look like a mannequin. When no idle clip ships with the model,
  // ALOO rotates the upper-arm bones down into a relaxed A-pose on load.
  autoAPose: true,
  // 74°, not 62°: at 62 the arms still stand visibly away from the body. The
  // angle is measured down from the T-pose, so larger = arms closer in.
  // NOTE: values below ~45 leave the character in a splayed near-T-pose, which
  // reads as broken rather than as a style choice — the UI slider therefore
  // starts at 45 and `autoAPose: false` is the way to ask for the raw bind pose.
  aPoseAngle: 74,
  // A dead-straight arm and a flat splayed hand are the two clearest
  // "mannequin" cues on an otherwise good rig.
  elbowBend: 11,
  /**
   * Degrees of curl at the knuckle. It COMPOUNDS down the chain — each joint
   * adds `curl * (0.6 + depth * 0.35)` on top of its parent — so the tip ends up
   * several times this value. At 12 that read as a closed fist rather than a
   * relaxed hand; 3 keeps the fingers open with just enough bend to avoid the
   * flat splayed mannequin look.
   */
  fingerCurl: 3,

  // --- Presence / interaction ----------------------------------------------
  idleLookAround: true, // glance away and back so she does not stare
  weightShift: true, // slow hip roll — nobody stands perfectly still
  tapReaction: true, // tap the avatar: she looks at you and waves
  speakOnTap: false, // …and greets you out loud (local TTS, no API call)
  // Generated body language. Gestures are synthesised from parametric
  // archetypes with randomised amplitude/timing/side, so they never repeat, and
  // the palette is chosen by the emotion inferred from each reply.
  autoGestures: true,
  gestureIntensity: 1.0,
  // She comes online rather than simply being there: a one-shot wake-up the
  // first time she appears, instead of opening on a motionless rest pose.
  introAnimation: true,
  emotionFromReply: true,
  // Facial expression, driven from the same emotion. Needs a model with
  // expression blendshapes — VRoid `Fcl_*`, ARKit, or ReadyPlayerMe naming are
  // all recognised. Models without them ignore it silently.
  facialExpression: true,
  expressionIntensity: 1.0,
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
  // Backdrop: 'stars' (the generated starfield — the look this app has always
  // actually shown) or 'model' (the supplied environment GLB, on its own).
  backdrop: 'stars',
  // The bundled environment is a POINT CLOUD, and glTF carries no point size —
  // three defaults to 1 world unit, which at backdrop distance is a sub-pixel
  // dot. This is that missing authoring value.
  spacePointSize: 1.6,

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
/**
 * Repair stored values that produce a visibly broken avatar.
 *
 * A settings slider is a loaded gun: a user exploring the drawer can leave
 * `aPoseAngle` at 0, which disables the A-pose correction entirely and leaves
 * the character splayed in her raw T-pose. From the outside that looks like the
 * MODEL is broken, not a setting — nobody connects "arms stuck out" to a slider
 * they nudged once. So a saved value in that dead zone is lifted back to the
 * default; asking for the bind pose is what `autoAPose: false` is for.
 */
function migrate(saved) {
  const out = { ...saved };
  if (out.autoAPose !== false && Number(out.aPoseAngle) < 45) {
    console.info(
      `[ALOO/settings] Repaired aPoseAngle ${out.aPoseAngle} -> ${DEFAULT_SETTINGS.aPoseAngle}` +
        ' (below 45 leaves the avatar in a T-pose).'
    );
    out.aPoseAngle = DEFAULT_SETTINGS.aPoseAngle;
  }

  /* A model id saved months ago may have been retired upstream since. Left
   * alone it produces an opaque "404 page not found" on the first message —
   * the provider's router answering for a route that no longer exists. Move
   * the user to a live default instead, and say so in the console. */
  for (const [key, live] of [
    ['nvidiaModel', NVIDIA_MODELS[0]],
    ['geminiModel', GEMINI_MODELS[0]],
  ]) {
    if (out[key] && RETIRED_MODELS.has(out[key])) {
      console.info(`[ALOO/settings] Model "${out[key]}" was retired upstream -> "${live}".`);
      out[key] = live;
    }
  }

  /* Both experiments with the backdrop are reverted to the generated starfield
   * the app has always actually displayed. A stored 'galaxy' no longer resolves
   * to anything, and 'model' was only ever set by that short-lived default. */
  if (out.backdrop === 'galaxy' || out.backdrop === 'model') out.backdrop = 'stars';

  /* The bundled avatar changed. Anyone still sitting on the previous default
   * moves with it; a model chosen from the library or uploaded is untouched. */
  if (out.avatarModelId === 'builtin:avatar' && !out.__avatarChosen) {
    out.avatarModelId = DEFAULT_SETTINGS.avatarModelId;
    out.avatarModelUrl = DEFAULT_SETTINGS.avatarModelUrl;
  }

  /* The finger curl default dropped from 12 to 3 because 12 compounded into a
   * closed fist. Anyone still sitting on the old default gets the new one —
   * this moves a stale default, not a choice, and the slider still overrides it. */
  if (Number(out.fingerCurl) === 12) out.fingerCurl = DEFAULT_SETTINGS.fingerCurl;
  delete out.galaxyStars;
  delete out.galaxySpin;

  return out;
}

export function hydrateSettings() {
  if (hydrated || typeof window === 'undefined') return state;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Merge over defaults so newly-added keys appear for existing users.
      state = { ...DEFAULT_SETTINGS, ...migrate(parsed) };
      persist();
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
