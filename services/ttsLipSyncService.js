/**
 * ALOO — Text-To-Speech engine + real-time viseme / morph-target driver.
 * ===========================================================================
 *
 * TWO SPEECH PATHS, ONE LIP-SYNC OUTPUT
 * -------------------------------------
 * A) NEURAL PATH (preferred, when `neuralTtsUrl` is configured)
 *      POST text -> receive audio bytes -> decodeAudioData -> BufferSource ->
 *      shared TTS gain -> AnalyserNode -> speakers.
 *      Because the audio flows through our own AnalyserNode we can read the
 *      REAL amplitude + spectral centroid every frame and derive genuinely
 *      synchronised mouth shapes.
 *
 * B) BROWSER PATH (default, zero-config, works offline)
 *      window.speechSynthesis plays through the OS mixer and exposes no
 *      MediaStream — its waveform is unreachable from JavaScript. So we build a
 *      *predicted* viseme timeline from the text itself, run it on a clock, and
 *      re-anchor that clock on every `onboundary` (word) event the engine
 *      fires. The result is estimated, not measured — but it is frame-accurate
 *      to the word and reads correctly on a face.
 *
 * Both paths write into ONE mutable frame object (`lipSync.frame`) that
 * AvatarCanvas samples inside useFrame. Nothing here triggers a React render:
 * a 60fps mouth must never go through the reconciler.
 */

import {
  getAudioContext,
  getTtsChannel,
  setSynthetic,
  getTtsLevel,
  getBrightness,
  setTtsVolume,
} from '@/lib/audioGraph';
import { getSettings } from '@/lib/settingsStore';
import { isNative } from '@/lib/runtime';

/* -------------------------------------------------------------------------- */
/* Viseme vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Oculus / ReadyPlayerMe standard viseme set. These are the morph target names
 * we try to drive on the loaded GLB; RiggingValidator reports which are absent.
 */
export const VISEMES = [
  'sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH',
  'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U',
];

/** How far the jaw drops for each viseme (0 = closed lips, 1 = wide open). */
const VISEME_OPENNESS = {
  sil: 0.0, PP: 0.04, FF: 0.22, TH: 0.34, DD: 0.32, kk: 0.38, CH: 0.4,
  SS: 0.22, nn: 0.28, RR: 0.44, aa: 1.0, E: 0.62, I: 0.4, O: 0.78, U: 0.38,
};

/**
 * Grapheme -> viseme. English orthography is not phonetic, so this is an
 * approximation tuned by eye; digraphs are checked first in `textToVisemes`.
 */
const DIGRAPHS = {
  th: 'TH', ch: 'CH', sh: 'CH', ph: 'FF', wh: 'U', ck: 'kk',
  ng: 'nn', qu: 'kk', oo: 'U', ee: 'I', ou: 'O', ow: 'O', ai: 'E', ea: 'I',
};

const LETTERS = {
  a: 'aa', e: 'E', i: 'I', o: 'O', u: 'U', y: 'I',
  p: 'PP', b: 'PP', m: 'PP',
  f: 'FF', v: 'FF',
  t: 'DD', d: 'DD', l: 'DD',
  n: 'nn',
  k: 'kk', g: 'kk', c: 'kk', q: 'kk', x: 'kk',
  j: 'CH',
  s: 'SS', z: 'SS',
  r: 'RR',
  w: 'U', h: 'aa',
};

/* -------------------------------------------------------------------------- */
/* The shared frame object                                                     */
/* -------------------------------------------------------------------------- */

function blankWeights() {
  const w = {};
  VISEMES.forEach((v) => {
    w[v] = 0;
  });
  w.sil = 1;
  return w;
}

export const lipSync = {
  /**
   * RIG TUNING HOLD. Set to a number 0..1 to pin the mouth open at that amount,
   * or null to resume normal driving. Writing to `frame` directly does not work
   * — the driver damps every channel back toward its target on the next frame —
   * so this is the supported way to calibrate a new rig's jaw swing/direction:
   *
   *   __alooLipSync.hold = 1     // mouth wide open, hold it
   *   __alooLipSync.hold = null  // release
   */
  hold: null,
  /** Sampled every render frame by the avatar. Mutated in place — never replaced. */
  frame: {
    speaking: false,
    energy: 0, // 0..1 loudness
    mouthOpen: 0, // 0..1 -> morph `mouthOpen`
    jawOpen: 0, // 0..1 -> morph `jawOpen`
    brightness: 0.35, // 0..1 spectral tilt -> mouth width
    mouthSmile: 0,
    blink: 0,
    viseme: 'sil',
    weights: blankWeights(),
  },
  /** Set by the brain so idle animations can react to "thinking". */
  thinking: false,
};

/* -------------------------------------------------------------------------- */
/* Internal driver state                                                       */
/* -------------------------------------------------------------------------- */

let rafId = null;
let timeline = null; // [{ viseme, start, end }] in ms, browser path only
let timelineT0 = 0;
let timelineRate = 1;
let currentUtterance = null;
// Identifies the in-flight NATIVE utterance. The plugin returns no handle, so
// this is how a barge-in tells its own completion from a stale one's.
let nativeSpeechToken = null;
let currentSource = null; // AudioBufferSourceNode for the neural path
let mode = 'idle'; // 'idle' | 'browser' | 'neural'
let lastBlink = 0;
let nextBlinkAt = 1500;
let blinkPhase = -1;
let keepAlive = false; // idle loop pinned on so blinks continue between replies
const listeners = new Set();

export function subscribeSpeaking(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emitSpeaking(v) {
  listeners.forEach((fn) => {
    try {
      fn(v);
    } catch (err) {
      console.error('[ALOO/tts] listener threw:', err);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Text -> predicted viseme timeline                                           */
/* -------------------------------------------------------------------------- */

/**
 * Convert raw text into a timed viseme track.
 * `charsPerSecond` approximates conversational English at rate 1.0; the caller
 * scales it by the SpeechSynthesis `rate` so fast speech gets a fast mouth.
 */
export function textToVisemes(text, charsPerSecond = 13.5) {
  const clean = String(text || '')
    .replace(/[*_`#>[\]()]/g, ' ') // strip markdown noise the voice won't say
    .toLowerCase();
  const track = [];
  let t = 0;
  const msPerChar = 1000 / charsPerSecond;

  for (let i = 0; i < clean.length; i++) {
    const two = clean.slice(i, i + 2);
    let viseme;
    let width = 1;

    if (DIGRAPHS[two]) {
      viseme = DIGRAPHS[two];
      width = 2;
      i++; // consume the second character
    } else {
      const ch = clean[i];
      if (LETTERS[ch]) {
        viseme = LETTERS[ch];
      } else if (/\s/.test(ch)) {
        viseme = 'sil';
      } else if (/[.,;:!?—-]/.test(ch)) {
        viseme = 'sil';
        width = 2.5; // punctuation = a real pause
      } else {
        continue; // digits, emoji, anything the mouth doesn't shape
      }
    }

    // Vowels are held longer than consonants — this is most of what makes a
    // predicted track feel like speech rather than a machine gun.
    const isVowel = ['aa', 'E', 'I', 'O', 'U'].includes(viseme);
    const dur = msPerChar * width * (isVowel ? 1.55 : 0.85);

    const prev = track[track.length - 1];
    if (prev && prev.viseme === viseme) {
      prev.end += dur; // merge doubled letters into one held shape
    } else {
      track.push({ viseme, start: t, end: t + dur, charIndex: i });
    }
    t += dur;
  }

  if (!track.length) track.push({ viseme: 'sil', start: 0, end: 300, charIndex: 0 });
  return track;
}

/* -------------------------------------------------------------------------- */
/* The 60fps driver loop                                                       */
/* -------------------------------------------------------------------------- */

function startLoop() {
  if (rafId != null) return;
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    updateFrame();
  };
  rafId = requestAnimationFrame(tick);
}

function stopLoopIfIdle() {
  if (keepAlive) return; // the avatar is mounted; keep blinking
  if (mode === 'idle' && rafId != null) {
    // Keep the loop alive briefly so the mouth eases shut instead of snapping.
    setTimeout(() => {
      // Re-check keepAlive HERE, not just on entry. React StrictMode mounts,
      // unmounts and remounts every effect in development: the unmount clears
      // keepAlive and schedules this timeout, the remount sets keepAlive again
      // and finds the loop still running (so startLoop no-ops) — and then this
      // timeout would fire and kill the loop of a live, mounted avatar. That
      // silently froze every idle animation, including blinking.
      if (keepAlive) return;
      if (mode === 'idle' && rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        decayToRest();
      }
    }, 400);
  }
}

function decayToRest() {
  const f = lipSync.frame;
  f.speaking = false;
  f.energy = 0;
  f.mouthOpen = 0;
  f.jawOpen = 0;
  VISEMES.forEach((v) => {
    f.weights[v] = v === 'sil' ? 1 : 0;
  });
  f.viseme = 'sil';
}

/** Exponential smoothing — frame-rate independent enough for our purposes. */
function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

let lastTickMs = 0;

function updateFrame() {
  const now = performance.now();
  const dt = lastTickMs ? Math.min(0.1, (now - lastTickMs) / 1000) : 0.016;
  lastTickMs = now;

  const f = lipSync.frame;
  let targetViseme = 'sil';
  let targetOpen = 0;
  let energy = 0;
  let brightness = f.brightness;

  if (mode === 'neural') {
    // ---- Measured path: the waveform itself drives the face. --------------
    energy = getTtsLevel();
    brightness = getBrightness();
    // Pick a vowel shape from spectral brightness: dark -> O/U, bright -> I/E.
    if (energy < 0.06) targetViseme = 'sil';
    else if (brightness < 0.22) targetViseme = 'U';
    else if (brightness < 0.34) targetViseme = 'O';
    else if (brightness < 0.48) targetViseme = 'aa';
    else if (brightness < 0.62) targetViseme = 'E';
    else targetViseme = 'I';
    // Perceptual curve: quiet audio should still open the mouth a little.
    targetOpen = Math.min(1, Math.pow(energy, 0.65) * 1.15);
  } else if (mode === 'browser' && timeline) {
    // ---- Predicted path: run the timeline clock. --------------------------
    const elapsed = (now - timelineT0) * timelineRate;
    const seg = seekSegment(timeline, elapsed);
    if (seg) {
      targetViseme = seg.viseme;
      // Envelope inside the segment: rise, hold, fall — prevents the "jaw
      // vibrating at a constant amplitude" look.
      const span = Math.max(1, seg.end - seg.start);
      const p = Math.min(1, Math.max(0, (elapsed - seg.start) / span));
      const env = Math.sin(Math.PI * Math.min(1, p * 1.15)) * 0.85 + 0.15;
      targetOpen = VISEME_OPENNESS[seg.viseme] * env;
      // A slow syllabic wobble on top keeps repeated shapes from looking looped.
      targetOpen *= 0.88 + 0.12 * Math.sin(now / 90);
      energy = targetOpen * 0.9;
      brightness = ['I', 'E', 'SS', 'CH'].includes(seg.viseme)
        ? 0.68
        : ['O', 'U', 'PP'].includes(seg.viseme)
        ? 0.2
        : 0.42;
    } else {
      // Past the end of the predicted track but the engine is still going —
      // hold a soft idle mouth rather than snapping shut mid-sentence.
      targetViseme = 'sil';
      targetOpen = 0.05;
      energy = 0.05;
    }
    // Feed the HUD visualiser with the same envelope.
    setSynthetic(true, energy, brightness);
  }

  // A tuning hold overrides the computed target (see lipSync.hold).
  if (lipSync.hold != null) {
    targetOpen = Math.max(0, Math.min(1, lipSync.hold));
    energy = targetOpen;
    if (targetOpen > 0.02 && targetViseme === 'sil') targetViseme = 'aa';
  }

  // ---- Smooth every channel toward its target. ---------------------------
  // Lips are fast (lambda 22) but not instant; the jaw trails slightly (16),
  // which is what real jaws do and reads as weight.
  f.mouthOpen = damp(f.mouthOpen, targetOpen, 22, dt);
  f.jawOpen = damp(f.jawOpen, targetOpen * 0.82, 16, dt);
  f.energy = damp(f.energy, energy, 14, dt);
  f.brightness = damp(f.brightness, brightness, 10, dt);
  f.viseme = targetViseme;

  VISEMES.forEach((v) => {
    const target = v === targetViseme ? Math.max(0.15, targetOpen) : 0;
    f.weights[v] = damp(f.weights[v], target, v === targetViseme ? 24 : 14, dt);
  });

  // ---- Idle blink, independent of speech. --------------------------------
  if (blinkPhase < 0) {
    if (now - lastBlink > nextBlinkAt) {
      blinkPhase = 0;
      lastBlink = now;
      nextBlinkAt = 2200 + Math.random() * 4200; // humans blink irregularly
    }
  } else {
    blinkPhase += dt / 0.14; // a blink lasts ~140ms
    if (blinkPhase >= 1) blinkPhase = -1;
  }
  f.blink = blinkPhase < 0 ? 0 : Math.sin(Math.PI * blinkPhase);

  // A faint smile while idle keeps the face from reading as dead.
  f.mouthSmile = damp(f.mouthSmile, mode === 'idle' ? 0.18 : 0.05, 3, dt);
}

/** Binary search the timeline for the segment covering `t` ms. */
function seekSegment(track, t) {
  if (!track.length || t < 0) return null;
  if (t > track[track.length - 1].end) return null;
  let lo = 0;
  let hi = track.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = track[mid];
    if (t < seg.start) hi = mid - 1;
    else if (t > seg.end) lo = mid + 1;
    else return seg;
  }
  return track[Math.min(lo, track.length - 1)];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function listVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices();
}

/**
 * Voice lists load asynchronously in Chrome. Resolve once they exist.
 */
export function waitForVoices(timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return resolve([]);
    const existing = window.speechSynthesis.getVoices();
    if (existing.length) return resolve(existing);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Speak `text`. Resolves when playback finishes (or is cancelled).
 * Returns immediately for empty input so callers can await unconditionally.
 */
export async function speak(text, opts = {}) {
  const s = { ...getSettings(), ...opts };
  const clean = sanitizeForSpeech(text);
  if (!clean || !s.ttsEnabled) return;

  stopSpeaking(); // never overlap two utterances

  if (s.neuralTtsUrl) {
    try {
      await speakNeural(clean, s);
      return;
    } catch (err) {
      console.warn('[ALOO/tts] Neural endpoint failed, falling back to browser TTS:', err);
    }
  }

  /* INSIDE THE APK, `window.speechSynthesis` IS A TRAP.
     Android's WebView exposes the object, so every feature check passes, but
     `getVoices()` commonly returns an empty list and `speak()` then resolves
     without producing a sound. From the app's side that is indistinguishable
     from success: no error, no event, and the reply is simply never heard.
     The native TTS plugin talks to the system engine directly and has none of
     that, so on device it is tried first and the browser engine is the
     fallback rather than the other way round. */
  if (nativeTtsAvailable()) {
    try {
      await speakNative(clean, s);
      return;
    } catch (err) {
      console.warn('[ALOO/tts] Native TTS failed, falling back to the WebView engine:', err);
    }
  }

  await speakBrowser(clean, s);
}

/** The Capacitor TextToSpeech plugin, if this build is running on a device. */
function nativeTts() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.TextToSpeech || null;
}

function nativeTtsAvailable() {
  return isNative() && !!nativeTts()?.speak;
}

/**
 * Path C: the device's own TTS engine.
 *
 * The plugin gives no word-boundary callbacks, which costs nothing here: the
 * mouth was never driven by them. `textToVisemes` builds the whole predicted
 * track up front and `onboundary` only ever RE-ANCHORED it to stop drift over
 * a long paragraph. Without it the track free-runs, which is accurate enough
 * across a sentence or two and is exactly what the neural path does too.
 */
async function speakNative(text, s) {
  const plugin = nativeTts();

  timeline = textToVisemes(text, 13.5 * (s.ttsRate || 1));
  timelineT0 = performance.now();
  timelineRate = 1;
  mode = 'browser'; // same timeline-driven mouth mode
  lipSync.frame.speaking = true;
  emitSpeaking(true);
  startLoop();

  // A token so a barge-in can tell "my utterance finished" from "someone
  // else's did" — the plugin has no per-utterance handle to compare.
  const token = {};
  nativeSpeechToken = token;

  try {
    await plugin.speak({
      text,
      lang: s.ttsLanguage || s.sttLanguage || 'en-US',
      // The plugin's rate is a plain multiplier, same as the Web Speech API's.
      rate: s.ttsRate ?? 1,
      pitch: s.ttsPitch ?? 1,
      volume: s.ttsVolume ?? 1,
      category: 'playback',
    });
  } finally {
    if (nativeSpeechToken === token) {
      nativeSpeechToken = null;
      timeline = null;
      mode = 'idle';
      setSynthetic(false);
      lipSync.frame.speaking = false;
      emitSpeaking(false);
      stopLoopIfIdle();
    }
  }
}

/** Strip markdown / code so the voice doesn't read asterisks aloud. */
export function sanitizeForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/(\*\*|__|\*|_)/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---- Path A: neural endpoint --------------------------------------------- */

async function speakNeural(text, s) {
  const channel = getTtsChannel();
  if (!channel) throw new Error('No AudioContext available');

  const res = await fetch(s.neuralTtsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(s.neuralTtsKey ? { Authorization: `Bearer ${s.neuralTtsKey}` } : {}),
    },
    body: JSON.stringify({ text, voice: s.neuralTtsVoice || undefined }),
  });
  if (!res.ok) throw new Error(`TTS endpoint ${res.status}: ${await res.text()}`);

  const bytes = await res.arrayBuffer();
  const buffer = await channel.ctx.decodeAudioData(bytes);

  setTtsVolume(s.ttsVolume);
  setSynthetic(false);
  mode = 'neural';
  lipSync.frame.speaking = true;
  emitSpeaking(true);
  startLoop();

  return new Promise((resolve) => {
    const src = channel.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = s.ttsRate || 1;
    src.connect(channel.gain); // -> analyser -> speakers
    currentSource = src;
    src.onended = () => {
      if (currentSource === src) {
        currentSource = null;
        mode = 'idle';
        lipSync.frame.speaking = false;
        emitSpeaking(false);
        stopLoopIfIdle();
      }
      resolve();
    };
    src.start();
  });
}

/* ---- Path B: browser SpeechSynthesis ------------------------------------- */

function speakBrowser(text, s) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      console.warn('[ALOO/tts] SpeechSynthesis unsupported — skipping speech.');
      return resolve();
    }

    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = s.ttsRate ?? 1;
    utter.pitch = s.ttsPitch ?? 1;
    utter.volume = s.ttsVolume ?? 1;
    // Speaking locale, not the listening one — see settings.ttsLanguage.
    utter.lang = s.ttsLanguage || s.sttLanguage || 'en-US';

    const voices = window.speechSynthesis.getVoices();
    if (s.ttsVoiceURI) {
      const v = voices.find((x) => x.voiceURI === s.ttsVoiceURI);
      if (v) utter.voice = v;
    } else {
      /* SETTING `lang` ALONE IS NOT ENOUGH IN A BROWSER.
         Chrome honours `utter.lang` only when it has no voice to fall back on;
         with a default voice installed it speaks US English regardless, and the
         requested accent silently does not happen. Picking the voice ourselves
         is what actually makes en-IN sound Indian. Exact locale first, then the
         same base language, then leave it to the engine. */
      const want = (utter.lang || '').toLowerCase();
      const base = want.split('-')[0];
      const match =
        voices.find((v) => v.lang?.toLowerCase().replace('_', '-') === want) ||
        voices.find((v) => v.lang?.toLowerCase().startsWith(`${base}-`));
      if (match) utter.voice = match;
    }

    // Build the predicted mouth track, scaled by the requested speech rate.
    timeline = textToVisemes(text, 13.5 * (utter.rate || 1));
    timelineT0 = performance.now();
    timelineRate = 1;
    mode = 'browser';
    lipSync.frame.speaking = true;
    emitSpeaking(true);
    startLoop();

    // `onboundary` fires at word starts with a charIndex — the only ground
    // truth the browser gives us. We use it to re-anchor the clock so drift
    // can never accumulate across a long paragraph.
    utter.onboundary = (ev) => {
      if (typeof ev.charIndex !== 'number' || !timeline) return;
      const seg = timeline.find((sg) => sg.charIndex >= ev.charIndex);
      if (seg) timelineT0 = performance.now() - seg.start;
    };

    const finish = () => {
      if (currentUtterance !== utter) return;
      currentUtterance = null;
      timeline = null;
      mode = 'idle';
      setSynthetic(false);
      lipSync.frame.speaking = false;
      emitSpeaking(false);
      stopLoopIfIdle();
      resolve();
    };

    utter.onend = finish;
    utter.onerror = (e) => {
      // 'interrupted'/'canceled' are normal when the user barges in.
      if (e?.error && !['interrupted', 'canceled'].includes(e.error)) {
        console.warn('[ALOO/tts] utterance error:', e.error);
      }
      finish();
    };

    currentUtterance = utter;
    // Chrome bug: a queued utterance can stall if the engine is left paused.
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utter);
  });
}

/** Hard-stop any speech in flight (barge-in, provider switch, unmount). */
export function stopSpeaking() {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    currentUtterance = null;
    window.speechSynthesis.cancel();
  }
  // Barge-in on the device engine. Clearing the token first means the speak()
  // promise that is about to reject knows it is stale and leaves the mouth
  // state to whatever replaced it.
  if (nativeSpeechToken) {
    nativeSpeechToken = null;
    nativeTts()?.stop?.().catch(() => {
      /* nothing was speaking */
    });
  }
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch {
      /* already stopped */
    }
    currentSource = null;
  }
  timeline = null;
  mode = 'idle';
  setSynthetic(false);
  lipSync.frame.speaking = false;
  emitSpeaking(false);
  stopLoopIfIdle();
}

export function isSpeaking() {
  return mode !== 'idle';
}

/**
 * DEV AFFORDANCE: expose the frame object so a new rig's jaw axis, sign and
 * swing can be tuned from the console without waiting for speech —
 *
 *   __alooLipSync.frame.jawOpen = 1     // hold the mouth open
 *   __alooLipSync.frame.speaking = true
 *
 * Guarded to development so it is not part of the shipped surface.
 */
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  window.__alooLipSync = lipSync;
}

/**
 * Pin the driver loop on while the avatar is mounted, so idle blinks and mouth
 * easing keep running between replies. Call the returned disposer on unmount.
 */
export function startIdleAnimation() {
  keepAlive = true;
  startLoop();
  return () => {
    keepAlive = false;
    stopLoopIfIdle();
  };
}
