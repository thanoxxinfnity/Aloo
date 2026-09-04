/**
 * ALOO — Speech-To-Text with Voice Activity Detection.
 * ===========================================================================
 * Built on the Web Speech API (`webkitSpeechRecognition` / `SpeechRecognition`).
 * Supported in Chrome, Edge and Chromium derivatives; Firefox and Safari do not
 * ship it, so `isSttSupported()` gates the UI rather than throwing.
 *
 * WHY OUR OWN VAD?
 * `continuous = true` keeps the engine open indefinitely, which is what we want
 * for hands-free operation — but it means the engine never tells us "the human
 * finished a thought". So we run a two-signal end-of-utterance detector:
 *
 *   1. TRANSCRIPT SILENCE — no new interim result for `vadSilenceMs`.
 *   2. ACOUSTIC SILENCE   — mic RMS (from the shared audio graph) has been
 *                           below the noise floor for the same window.
 *
 * Requiring both avoids two classic failure modes: cutting someone off while
 * they pause mid-sentence, and hanging forever on room noise the recogniser
 * never turns into words.
 */

import { attachMicStream, detachMicStream, getMicLevel, getAudioContext } from '@/lib/audioGraph';
import { getSettings } from '@/lib/settingsStore';
import { isNative } from '@/lib/runtime';

const SILENCE_FLOOR = 0.045; // mic RMS below this counts as "not talking"

let recognition = null;
let micStream = null;
let listening = false;
let vadTimer = null;
let vadRaf = null;
let lastVoiceAt = 0;
let finalBuffer = '';
let interimBuffer = '';
let manualStop = false;
/** Native path only: plugin listener handles and the hands-free re-arm timer. */
const nativeListeners = [];
let nativeRestartTimer = null;

const handlers = {
  onInterim: null,
  onFinal: null,
  onStateChange: null,
  onError: null,
};

/**
 * The Capacitor SpeechRecognition plugin, when running on a device.
 *
 * ANDROID'S WEBVIEW HAS NO WEB SPEECH API. This is the single reason voice
 * input did not work in the APK: `webkitSpeechRecognition` is a Chrome-browser
 * feature, not part of the System WebView that a Capacitor app renders in. So
 * `isSttSupported()` was correctly returning false on device and the mic was
 * disabled — the feature was never broken, it was never present. The plugin
 * drives Android's native SpeechRecognizer instead, which is what the platform
 * actually provides.
 */
function nativeStt() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.SpeechRecognition || null;
}

function nativeSttAvailable() {
  return isNative() && !!nativeStt()?.start;
}

export function isSttSupported() {
  if (typeof window === 'undefined') return false;
  if (nativeSttAvailable()) return true;
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function isListening() {
  return listening;
}

export function setSttHandlers(next = {}) {
  Object.assign(handlers, next);
}

function emitState(state) {
  handlers.onStateChange?.(state);
}

/**
 * Begin listening. Idempotent — calling twice is a no-op.
 * `onFinal(text)` fires once VAD decides the utterance ended.
 */
export async function startListening() {
  if (listening) return;
  if (!isSttSupported()) {
    handlers.onError?.(
      new Error('Speech recognition is not supported in this browser. Try Chrome or Edge.')
    );
    return;
  }

  const s = getSettings();

  if (nativeSttAvailable()) {
    await startListeningNative(s);
    return;
  }

  // Mic capture serves two purposes: the acoustic half of VAD, and the HUD
  // waveform. The recogniser opens its own capture internally — this is a
  // second, parallel stream, which browsers permit.
  try {
    getAudioContext(); // created inside the user gesture that reached here
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    attachMicStream(micStream);
  } catch (err) {
    handlers.onError?.(new Error(`Microphone access denied: ${err.message}`));
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = s.sttLanguage || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  finalBuffer = '';
  interimBuffer = '';
  manualStop = false;
  lastVoiceAt = performance.now();

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) finalBuffer += `${text} `;
      else interim += text;
    }
    interimBuffer = interim;
    lastVoiceAt = performance.now(); // any transcript activity = still talking
    handlers.onInterim?.((finalBuffer + interim).trim());
  };

  recognition.onerror = (event) => {
    // 'no-speech' and 'aborted' are routine in hands-free mode; don't alarm.
    if (['no-speech', 'aborted'].includes(event.error)) return;
    if (event.error === 'not-allowed') {
      handlers.onError?.(new Error('Microphone permission blocked. Enable it in site settings.'));
      stopListening();
      return;
    }
    handlers.onError?.(new Error(`Speech recognition error: ${event.error}`));
  };

  recognition.onend = () => {
    // Chrome silently ends the session every ~60s. In continuous mode we
    // restart it unless the user actually asked us to stop.
    if (listening && !manualStop) {
      try {
        recognition.start();
      } catch {
        /* already restarting */
      }
    }
  };

  try {
    recognition.start();
  } catch (err) {
    handlers.onError?.(new Error(`Could not start recognition: ${err.message}`));
    return;
  }

  listening = true;
  emitState('listening');
  startVad();
}

/**
 * Android's native recogniser, via Capacitor.
 *
 * It differs from the Web Speech API in one way that shapes everything here:
 * ANDROID'S RECOGNISER ENDS THE SESSION ITSELF once it decides you have stopped
 * talking. There is no `continuous` mode to keep it open, so the end-of-session
 * event IS the end-of-utterance signal, and our own silence-timer VAD is not
 * just unnecessary — running it too would cut the user off mid-sentence, before
 * the engine had decided anything.
 *
 * So on this path the engine owns utterance segmentation, and hands-free mode
 * is implemented by restarting it after each result rather than by holding one
 * session open.
 */
async function startListeningNative(s) {
  const plugin = nativeStt();

  // Android will not open the recogniser without RECORD_AUDIO, and a denied
  // request looks exactly like a recogniser that silently does nothing.
  try {
    const status = await plugin.checkPermissions();
    if (status?.speechRecognition !== 'granted') {
      const asked = await plugin.requestPermissions();
      if (asked?.speechRecognition !== 'granted') {
        handlers.onError?.(
          new Error('Microphone permission denied. Enable it for ALOO in Android settings.')
        );
        return;
      }
    }
  } catch {
    // Older plugin builds expose no permission API; start() will surface it.
  }

  try {
    const avail = await plugin.available();
    if (avail && avail.available === false) {
      handlers.onError?.(
        new Error('This device has no speech recognition service installed.')
      );
      return;
    }
  } catch {
    /* treat an unanswerable availability check as "try it and see" */
  }

  // The mic feed for the HUD waveform is independent of recognition, and is
  // best-effort: on some devices the native recogniser takes exclusive hold of
  // the microphone, and losing the visualiser is far better than losing speech.
  try {
    getAudioContext();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    attachMicStream(micStream);
  } catch {
    micStream = null;
  }

  finalBuffer = '';
  interimBuffer = '';
  manualStop = false;

  await plugin.removeAllListeners().catch(() => {});

  nativeListeners.push(
    await plugin.addListener('partialResults', (data) => {
      const text = data?.matches?.[0];
      if (typeof text !== 'string') return;
      interimBuffer = text;
      handlers.onInterim?.(text.trim());
    })
  );

  nativeListeners.push(
    await plugin.addListener('listeningState', (data) => {
      if (data?.status !== 'stopped' || !listening) return;
      // The engine decided the utterance ended. Deliver it, then re-arm if the
      // user asked for hands-free.
      const pending = (finalBuffer + interimBuffer).trim();
      finalBuffer = '';
      interimBuffer = '';
      if (pending) handlers.onFinal?.(pending);

      if (manualStop || !getSettings().handsFree) {
        stopListening({ flush: false });
      } else {
        restartNative();
      }
    })
  );

  listening = true;
  emitState('listening');
  await beginNativeSession(s);
}

/** One recognition session. Resolved matches are the engine's final answer. */
async function beginNativeSession(s = getSettings()) {
  try {
    const res = await nativeStt().start({
      language: s.sttLanguage || 'en-US',
      maxResults: 1,
      partialResults: true,
      popup: false, // never hand the user Android's own dialog — this is the HUD
    });
    // Some Android versions resolve with the final matches instead of firing a
    // listeningState event. Buffer it so whichever arrives first still works.
    const text = res?.matches?.[0];
    if (typeof text === 'string' && text.trim()) interimBuffer = text;
  } catch (err) {
    if (listening && !manualStop) {
      handlers.onError?.(new Error(`Speech recognition failed: ${err?.message || err}`));
      stopListening({ flush: false });
    }
  }
}

/** Re-arm after the engine closed a session, for hands-free mode. */
function restartNative() {
  // A beat of delay: restarting inside the stop callback makes Android refuse
  // the new session while the old one is still tearing down.
  nativeRestartTimer = setTimeout(() => {
    if (listening && !manualStop) beginNativeSession();
  }, 350);
}

/** Stop listening and release the mic. Any buffered speech is flushed first. */
export function stopListening({ flush = true } = {}) {
  manualStop = true;
  stopVad();

  if (nativeRestartTimer) {
    clearTimeout(nativeRestartTimer);
    nativeRestartTimer = null;
  }
  if (nativeListeners.length) {
    nativeListeners.forEach((l) => l?.remove?.());
    nativeListeners.length = 0;
  }
  const np = nativeStt();
  if (np && isNative()) {
    np.stop?.().catch(() => {
      /* not running */
    });
  }

  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* not running */
    }
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    recognition = null;
  }

  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  detachMicStream();

  const pending = (finalBuffer + interimBuffer).trim();
  finalBuffer = '';
  interimBuffer = '';
  listening = false;
  emitState('idle');

  if (flush && pending) handlers.onFinal?.(pending);
}

/* -------------------------------------------------------------------------- */
/* Voice Activity Detection                                                    */
/* -------------------------------------------------------------------------- */

function startVad() {
  stopVad();
  const tick = () => {
    vadRaf = requestAnimationFrame(tick);
    if (getMicLevel() > SILENCE_FLOOR) lastVoiceAt = performance.now();
  };
  vadRaf = requestAnimationFrame(tick);

  // Poll on a timer rather than per-frame: end-of-utterance is a ~100ms-grain
  // decision and this keeps the check off the render-critical path.
  vadTimer = setInterval(() => {
    const s = getSettings();
    const silentFor = performance.now() - lastVoiceAt;
    const pending = (finalBuffer + interimBuffer).trim();
    if (pending && silentFor >= (s.vadSilenceMs || 1400)) {
      commitUtterance(pending);
    }
  }, 150);
}

function stopVad() {
  if (vadRaf != null) cancelAnimationFrame(vadRaf);
  if (vadTimer != null) clearInterval(vadTimer);
  vadRaf = null;
  vadTimer = null;
}

function commitUtterance(text) {
  finalBuffer = '';
  interimBuffer = '';
  lastVoiceAt = performance.now();
  emitState('processing');
  handlers.onFinal?.(text);
  // We stay open: in hands-free mode the next turn should need no click.
  emitState(listening ? 'listening' : 'idle');
}

/** Discard whatever has been heard so far without ending the session. */
export function clearBuffer() {
  finalBuffer = '';
  interimBuffer = '';
  lastVoiceAt = performance.now();
}

/** Language codes offered in the settings drawer. */
export const STT_LANGUAGES = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { code: 'es-ES', label: 'Español' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'zh-CN', label: '中文 (简体)' },
  { code: 'ar-SA', label: 'العربية' },
  { code: 'pt-BR', label: 'Português (BR)' },
  { code: 'ru-RU', label: 'Русский' },
];
