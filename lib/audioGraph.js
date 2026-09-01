/**
 * ALOO — Shared Web Audio graph.
 * ---------------------------------------------------------------------------
 * One AudioContext for the whole app, with three signal sources feeding the
 * HUD visualiser and the avatar's lip-sync driver:
 *
 *   1. MIC        — the user's microphone (while STT is listening).
 *   2. TTS        — decoded neural-TTS audio we play ourselves.
 *   3. SYNTHETIC  — a procedural envelope used when speech comes from the
 *                   browser's SpeechSynthesis engine. That engine plays through
 *                   the OS audio path and exposes **no** MediaStream, so it is
 *                   physically impossible to analyse its real waveform from JS.
 *                   Instead we generate a syllable-rate envelope from the text
 *                   and word-boundary events, which reads convincingly on a
 *                   face at 60fps.
 *
 * Everything here is imperative and ref-based on purpose: the render loop reads
 * it 60 times a second and must never trigger React re-renders.
 */

const FFT_SIZE = 512;
const BINS = FFT_SIZE / 2; // 256 frequency bins

let ctx = null;
let micAnalyser = null;
let micSource = null;
let ttsAnalyser = null;
let ttsGain = null;

// Scratch buffers — allocated once, reused every frame (zero GC pressure).
const micBuf = new Uint8Array(BINS);
const ttsBuf = new Uint8Array(BINS);
const outBuf = new Uint8Array(BINS);
const timeBuf = new Uint8Array(FFT_SIZE);

/** Procedural envelope state, driven by ttsLipSyncService. */
const synthetic = {
  active: false,
  level: 0, // 0..1 overall loudness
  tilt: 0.5, // 0 = dark/closed vowel, 1 = bright/open vowel — shapes the fake spectrum
};

export const AUDIO_BINS = BINS;

/** Lazily create the AudioContext. Must be called from a user gesture path. */
export function getAudioContext() {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      console.warn('[ALOO/audio] Web Audio API unavailable in this browser.');
      return null;
    }
    ctx = new AC();
  }
  // Browsers suspend contexts created outside a gesture; resume opportunistically.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Microphone channel                                                          */
/* -------------------------------------------------------------------------- */

/** Route a getUserMedia stream into the analyser (not into the speakers). */
export function attachMicStream(stream) {
  const audio = getAudioContext();
  if (!audio || !stream) return null;
  detachMicStream();
  try {
    micSource = audio.createMediaStreamSource(stream);
    micAnalyser = audio.createAnalyser();
    micAnalyser.fftSize = FFT_SIZE;
    micAnalyser.smoothingTimeConstant = 0.75;
    micSource.connect(micAnalyser);
    // Deliberately NOT connected to destination — that would echo the user.
  } catch (err) {
    console.warn('[ALOO/audio] attachMicStream failed:', err);
  }
  return micAnalyser;
}

export function detachMicStream() {
  try {
    if (micSource) micSource.disconnect();
    if (micAnalyser) micAnalyser.disconnect();
  } catch {
    /* node already torn down */
  }
  micSource = null;
  micAnalyser = null;
}

/* -------------------------------------------------------------------------- */
/* TTS playback channel                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Returns { gain, analyser } — connect your AudioBufferSourceNode or
 * MediaElementSource into `gain` and the audio reaches the speakers *through*
 * the analyser, giving us real amplitude data for lip-sync.
 */
export function getTtsChannel() {
  const audio = getAudioContext();
  if (!audio) return null;
  if (!ttsAnalyser) {
    ttsAnalyser = audio.createAnalyser();
    ttsAnalyser.fftSize = FFT_SIZE;
    ttsAnalyser.smoothingTimeConstant = 0.7;
    ttsGain = audio.createGain();
    ttsGain.gain.value = 1;
    ttsGain.connect(ttsAnalyser);
    ttsAnalyser.connect(audio.destination);
  }
  return { ctx: audio, gain: ttsGain, analyser: ttsAnalyser };
}

export function setTtsVolume(v) {
  if (ttsGain) ttsGain.gain.value = Math.max(0, Math.min(1, v));
}

/* -------------------------------------------------------------------------- */
/* Synthetic channel (browser SpeechSynthesis fallback)                        */
/* -------------------------------------------------------------------------- */

export function setSynthetic(active, level = 0, tilt = 0.5) {
  synthetic.active = active;
  synthetic.level = active ? Math.max(0, Math.min(1, level)) : 0;
  synthetic.tilt = tilt;
}

/* -------------------------------------------------------------------------- */
/* Read-out used by the visualiser and the viseme driver                       */
/* -------------------------------------------------------------------------- */

/**
 * Fill and return a 256-bin 0..255 spectrum blending every live source.
 * The returned array is reused — copy it if you need to keep it.
 */
export function getSpectrum() {
  outBuf.fill(0);

  if (micAnalyser) {
    micAnalyser.getByteFrequencyData(micBuf);
    for (let i = 0; i < BINS; i++) if (micBuf[i] > outBuf[i]) outBuf[i] = micBuf[i];
  }

  if (ttsAnalyser) {
    ttsAnalyser.getByteFrequencyData(ttsBuf);
    for (let i = 0; i < BINS; i++) if (ttsBuf[i] > outBuf[i]) outBuf[i] = ttsBuf[i];
  }

  if (synthetic.active && synthetic.level > 0.001) {
    // Build a formant-ish curve: a low body + a movable "brightness" bump whose
    // position tracks vowel openness. Cheap, but it reads as a voice on a meter.
    const t = performance.now() / 1000;
    const bright = 0.18 + synthetic.tilt * 0.42;
    for (let i = 0; i < BINS; i++) {
      const f = i / BINS;
      const body = Math.exp(-Math.pow((f - 0.05) / 0.09, 2));
      const formant = 0.75 * Math.exp(-Math.pow((f - bright) / 0.11, 2));
      const air = 0.12 * Math.exp(-Math.pow((f - 0.72) / 0.3, 2));
      // A little per-bin shimmer stops the curve looking like a static hill.
      const shimmer = 0.85 + 0.15 * Math.sin(t * 11 + i * 0.7);
      const v = (body + formant + air) * synthetic.level * shimmer * 235;
      if (v > outBuf[i]) outBuf[i] = Math.min(255, v);
    }
  }

  return outBuf;
}

/** Normalised 0..1 loudness across every live source. */
export function getLevel() {
  let peak = 0;

  if (ttsAnalyser) {
    ttsAnalyser.getByteTimeDomainData(timeBuf);
    peak = Math.max(peak, rmsFromTimeDomain(timeBuf));
  }
  if (micAnalyser) {
    micAnalyser.getByteTimeDomainData(timeBuf);
    peak = Math.max(peak, rmsFromTimeDomain(timeBuf));
  }
  if (synthetic.active) peak = Math.max(peak, synthetic.level);

  return Math.min(1, peak);
}

/** Mic-only level — used by Voice Activity Detection so TTS can't trip it. */
export function getMicLevel() {
  if (!micAnalyser) return 0;
  micAnalyser.getByteTimeDomainData(timeBuf);
  return rmsFromTimeDomain(timeBuf);
}

/** Is real (non-synthetic) TTS audio currently moving? */
export function getTtsLevel() {
  if (synthetic.active) return synthetic.level;
  if (!ttsAnalyser) return 0;
  ttsAnalyser.getByteTimeDomainData(timeBuf);
  return rmsFromTimeDomain(timeBuf);
}

function rmsFromTimeDomain(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128; // byte samples are centred on 128
    sum += v * v;
  }
  // ~3.2x gain maps typical speech RMS (~0.1-0.3) onto a usable 0..1 range.
  return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
}

/**
 * Spectral centroid 0..1 — how "bright" the current sound is. Bright sounds
 * (ee, s, t) map to wide/flat mouth shapes, dark sounds (oo, oh) to rounded
 * ones. This is what lets us pick a plausible viseme from real audio.
 */
export function getBrightness() {
  const spec = getSpectrum();
  let num = 0;
  let den = 0;
  for (let i = 0; i < BINS; i++) {
    num += i * spec[i];
    den += spec[i];
  }
  if (den < 1) return 0.35;
  // Speech energy sits in the bottom ~40% of bins; rescale so it spans 0..1.
  return Math.min(1, num / den / BINS / 0.4);
}
