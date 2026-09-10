import { useCallback, useEffect, useRef, useState } from 'react';

import useSettings from './useSettings';
import useWebcam from './useWebcam';
import { streamChat, providerLabel } from '@/services/aiRouter';
import { runDeepResearch } from '@/services/researchService';
import {
  speak,
  stopSpeaking,
  subscribeSpeaking,
  sanitizeForSpeech,
} from '@/services/ttsLipSyncService';
import {
  startListening,
  stopListening,
  setSttHandlers,
  isSttSupported,
} from '@/services/sttService';
import { PROVIDERS, activeModel } from '@/lib/settingsStore';
import { director } from '@/lib/animationDirector';
import {
  TV_COMMANDS,
  parseTvCommand,
  describeTvCommand,
  parseDeviceCommand,
  describeDeviceCommand,
  DEVICE_COMMANDS,
} from '@/lib/tvCommands';
import { runTvCommand } from '@/services/lgWebosService';
import { openHotspotSettings, openSettingsScreen } from '@/services/deviceSettingsService';

/**
 * ALOO — Central state & routing hook.
 * ===========================================================================
 * The single conductor for the whole assistant. Everything else is a leaf:
 * the 3D canvas reads a mutable frame object, the UI reads this hook.
 *
 * RESPONSIBILITIES
 *   • Conversation state and streaming assistant messages.
 *   • Provider routing (NVIDIA NIM vs Gemini) — see services/aiRouter.
 *   • Vision: attaching the newest webcam frame to outgoing prompts.
 *   • Voice: STT in, TTS out, and the hands-free turn-taking loop.
 *   • Deep research runs, with live progress.
 *   • Abort handling — one AbortController per turn, always cleaned up.
 *
 * TURN-TAKING RULE (the part that is easy to get wrong): the mic is CLOSED
 * while ALOO speaks. Without that, browser TTS is transcribed by the
 * recogniser and the assistant talks to itself in an infinite loop.
 */

let idSeq = 0;
const nextId = () => `m${Date.now().toString(36)}${(idSeq++).toString(36)}`;

const GREETING =
  'ALOO online. Neural link established, holographic projection stable. ' +
  'Ask me anything — or enable voice and camera from the control drawer.';

export default function useAlooBrain() {
  const { settings, update, set, reset } = useSettings();

  /* -- Conversation -------------------------------------------------------- */
  // NOTE: this message is rendered on the server. Its id and timestamp must be
  // deterministic, or React reports a hydration mismatch on first paint.
  const [messages, setMessages] = useState(() => [
    { id: 'aloo-greeting', role: 'assistant', content: GREETING, at: null, greeting: true },
  ]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);

  /* -- Voice --------------------------------------------------------------- */
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [speaking, setSpeaking] = useState(false);

  /* -- Research ------------------------------------------------------------ */
  const [research, setResearch] = useState({
    active: false,
    stage: null,
    detail: '',
    queries: [],
    sources: [],
    report: '',
  });

  /* -- Capability detection ------------------------------------------------ */
  // Resolved AFTER mount, never during render: the Web Speech API does not
  // exist on the Node server, so reading it inline would make the server and
  // client markup disagree and fail hydration.
  const [sttSupported, setSttSupported] = useState(false);
  useEffect(() => setSttSupported(isSttSupported()), []);

  /* -- 3D diagnostics ------------------------------------------------------ */
  const [riggingReport, setRiggingReport] = useState(null);
  const [telemetry, setTelemetry] = useState(null);
  const [expression, setExpression] = useState({ label: 'Neutral', emotion: 'neutral', last: null });

  useEffect(() => director.subscribe(setExpression), []);

  const abortRef = useRef(null);
  const streamingIdRef = useRef(null);
  const handsFreeRef = useRef(settings.handsFree);
  const busyRef = useRef(false); // guards against overlapping turns

  /* -- Vision -------------------------------------------------------------- */
  const webcam = useWebcam({
    enabled: settings.cameraEnabled,
    captureIntervalMs: settings.visionCaptureMs,
    quality: settings.visionQuality,
  });

  useEffect(() => {
    handsFreeRef.current = settings.handsFree;
  }, [settings.handsFree]);

  useEffect(() => subscribeSpeaking(setSpeaking), []);

  /* ======================================================================== */
  /* Core: send a turn                                                        */
  /* ======================================================================== */

  /**
   * Run a recognised TV command and report it in the conversation.
   *
   * It still writes both turns into the transcript, because a command that
   * leaves no trace is indistinguishable from one that was never heard — and
   * on a failure the user needs to see WHY, not just notice the TV did not
   * move. She speaks the confirmation too, so it works with the screen off.
   */
  const handleTvCommand = useCallback(
    async (content, tv) => {
      const userMsg = { id: nextId(), role: 'user', content, at: Date.now() };
      const replyId = nextId();
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: replyId, role: 'assistant', content: '', at: Date.now(), pending: true, tv: true },
      ]);

      // Two commands take real time — waking a TV means waiting for it to boot,
      // and playing something by name means a search first. Saying so beats a
      // silent pause that reads as a hang.
      const slow =
        tv.command === TV_COMMANDS.POWER_ON ? 'TV ko jaga raha hoon, ek minute…'
        : tv.command === TV_COMMANDS.PLAY_VIDEO ? `"${tv.args.query}" dhoond raha hoon…`
        : null;
      if (slow) {
        setMessages((prev) =>
          prev.map((m) => (m.id === replyId ? { ...m, content: slow } : m))
        );
      }

      let reply;
      let failed = false;
      try {
        const result = await runTvCommand(tv.command, tv.args);
        // playOnTv hands back what it actually found, so the confirmation can
        // name the video rather than claiming a generic success.
        reply = describeTvCommand(tv.command, { ...tv.args, title: result?.title });
        director.setEmotion('confident', 0.8);
      } catch (err) {
        failed = true;
        // The service already phrases its errors for a person ("accept the
        // prompt on your TV"), so pass them through rather than wrapping them
        // in something vaguer.
        if (err.openedApp) {
          // A search that found nothing still opened the app — reporting a flat
          // failure would contradict what the user can see on screen.
          failed = false;
          reply = `${err.message} App khol diya hai, waha se dhoond lo.`;
          director.setEmotion('concerned', 0.5);
        } else {
          reply = `TV se baat nahi ho payi — ${err.message}`;
          director.setEmotion('concerned', 0.85);
          setError(err.message);
        }
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === replyId ? { ...m, content: reply, pending: false, isError: failed } : m))
      );

      if (settings.ttsEnabled) {
        director.setState('speaking');
        await speak(sanitizeForSpeech(reply));
      }
      director.setState('idle');
      // The mic re-arms itself: an effect below watches speaking/streaming/
      // listening and re-opens it once all three are clear.
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.ttsEnabled]
  );

  /**
   * Open a phone settings screen and say what happened.
   *
   * The wording matters more than usual here: the app CANNOT switch the
   * hotspot on (Android reserves that for system apps), so the reply says the
   * page is open rather than claiming the job is done. A confirmation the user
   * disproves by glancing at their screen is worse than no confirmation.
   */
  const handleDeviceCommand = useCallback(
    async (content, cmd) => {
      const userMsg = { id: nextId(), role: 'user', content, at: Date.now() };
      const replyId = nextId();
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: replyId, role: 'assistant', content: '', at: Date.now(), pending: true },
      ]);

      let reply;
      let failed = false;
      try {
        if (cmd.command === DEVICE_COMMANDS.OPEN_HOTSPOT) {
          await openHotspotSettings();
        } else {
          const screen = {
            [DEVICE_COMMANDS.OPEN_WIFI]: 'wifi',
            [DEVICE_COMMANDS.OPEN_BLUETOOTH]: 'bluetooth',
            [DEVICE_COMMANDS.OPEN_DATA]: 'data',
            [DEVICE_COMMANDS.OPEN_TTS]: 'tts',
          }[cmd.command];
          await openSettingsScreen(screen);
        }
        reply = describeDeviceCommand(cmd.command);
        director.setEmotion('confident', 0.75);
      } catch (err) {
        failed = true;
        reply = err.message;
        director.setEmotion('concerned', 0.8);
        setError(err.message);
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === replyId ? { ...m, content: reply, pending: false, isError: failed } : m))
      );

      if (settings.ttsEnabled) {
        director.setState('speaking');
        await speak(sanitizeForSpeech(reply));
      }
      director.setState('idle');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.ttsEnabled]
  );

  const sendMessage = useCallback(
    async (text, { attachVision = true } = {}) => {
      const content = String(text || '').trim();
      if (!content || busyRef.current) return;

      busyRef.current = true;
      setError(null);
      setInterimTranscript('');
      stopSpeaking(); // barge-in: a new question cancels the old answer

      /* TV COMMANDS SHORT-CIRCUIT THE MODEL.
         "TV band karo" is unambiguous, and sending it to a language model so it
         can tell us what we already know costs a second of network latency on
         what should feel like pressing a button. Anything the matcher does not
         recognise falls straight through to the normal path, so conversation is
         unaffected. */
      if (settings.deviceCommands !== false) {
        const dev = parseDeviceCommand(content);
        if (dev) {
          busyRef.current = false;
          await handleDeviceCommand(content, dev);
          return;
        }
      }

      if (settings.tvEnabled && settings.tvVoiceCommands !== false) {
        const tv = parseTvCommand(content);
        if (tv) {
          busyRef.current = false;
          await handleTvCommand(content, tv);
          return;
        }
      }

      director.setState('thinking');

      // Attach the live camera frame if vision is on and the model can take it.
      let images;
      if (attachVision && settings.cameraEnabled && settings.visionAttachLatest) {
        const frame = webcam.getLatestFrame();
        if (frame) images = [frame];
      }

      const userMsg = { id: nextId(), role: 'user', content, images, at: Date.now() };
      const assistantId = nextId();
      streamingIdRef.current = assistantId;

      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          at: Date.now(),
          pending: true,
          provider: providerLabel(settings),
          model: activeModel(settings),
        },
      ]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // History for the model: drop the canned greeting and the placeholder we
      // just pushed, keep the last 20 turns to stay inside the context window.
      const history = messages
        .filter((m) => !m.greeting && !m.pending && !m.isError && m.content)
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content, images: m.images }));
      history.push({ role: 'user', content, images });

      let full = '';
      try {
        full = await streamChat({
          messages: history,
          signal: controller.signal,
          onToken: (_delta, accumulated) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m))
            );
          },
          // The provider retired the selected model and the service picked a
          // live one. The reply still arrives, so this is information rather
          // than an error — relabel the bubble instead of raising a toast.
          onNotice: (notice) => {
            console.info('[ALOO]', notice);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, model: activeModel(), notice } : m
              )
            );
          },
        });

        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: full, pending: false } : m))
        );

        // Let the body language match what she just said. Classification is
        // local (see lib/animationDirector) — no extra call, no added latency.
        if (settings.emotionFromReply !== false) director.setEmotionFromText(full);
        director.setState('speaking');

        // Speak the reply, then hand the mic back if hands-free is on.
        if (settings.ttsEnabled && full.trim()) {
          await speak(sanitizeForSpeech(full));
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `${m.content}\n\n_[stopped]_`, pending: false }
                : m
            )
          );
        } else {
          const msg = err.message || 'Unknown error';
          director.setEmotion('concerned', 0.9);
          setError(msg);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `⚠ ${msg}`, pending: false, isError: true }
                : m
            )
          );
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        streamingIdRef.current = null;
        busyRef.current = false;
        director.setState('idle');
      }
    },
    [messages, settings, webcam]
  );

  /* ======================================================================== */
  /* Deep research                                                            */
  /* ======================================================================== */

  const runResearch = useCallback(
    async (question) => {
      const q = String(question || '').trim();
      if (!q || busyRef.current) return;

      busyRef.current = true;
      setError(null);
      stopSpeaking();
      // A research run is a long deliberation — hold a thoughtful posture for it.
      director.setState('thinking');
      director.setEmotion('thoughtful', 0.85);

      const assistantId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: q, at: Date.now(), isResearch: true },
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          at: Date.now(),
          pending: true,
          isResearch: true,
          provider: providerLabel(settings),
          model: activeModel(settings),
        },
      ]);

      setResearch({
        active: true,
        stage: 'planning',
        detail: 'Initialising research protocol…',
        queries: [],
        sources: [],
        report: '',
        question: q,
      });
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const { report, sources, queries } = await runDeepResearch(q, {
          signal: controller.signal,
          onProgress: (p) =>
            setResearch((prev) => ({
              ...prev,
              stage: p.stage,
              detail: p.detail,
              queries: p.queries ?? prev.queries,
              sources: p.sources ?? prev.sources,
            })),
          onToken: (_d, accumulated) => {
            setResearch((prev) => ({ ...prev, report: accumulated }));
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m))
            );
          },
        });

        setResearch((prev) => ({ ...prev, active: false, stage: 'done', report, sources, queries }));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: report, sources, pending: false } : m
          )
        );

        if (settings.ttsEnabled && report.trim()) {
          // Reading a full report aloud is punishing; speak the summary only.
          const summary = report.split(/\n\s*\n/).slice(0, 2).join(' ');
          await speak(sanitizeForSpeech(summary));
        }
      } catch (err) {
        const aborted = err.name === 'AbortError';
        const msg = aborted ? 'Research stopped.' : err.message || 'Research failed';
        if (!aborted) setError(msg);
        setResearch((prev) => ({ ...prev, active: false, stage: aborted ? 'idle' : 'error', detail: msg }));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `⚠ ${msg}`, pending: false, isError: !aborted }
              : m
          )
        );
      } finally {
        setStreaming(false);
        abortRef.current = null;
        busyRef.current = false;
        director.setState('idle');
      }
    },
    [settings]
  );

  /* ======================================================================== */
  /* Voice                                                                    */
  /* ======================================================================== */

  // Register STT handlers once; they read live values through refs so the
  // recogniser never has to be torn down and rebuilt on a settings change.
  const sendRef = useRef(sendMessage);
  useEffect(() => {
    sendRef.current = sendMessage;
  }, [sendMessage]);

  useEffect(() => {
    setSttHandlers({
      onInterim: setInterimTranscript,
      onFinal: (text) => {
        setInterimTranscript('');
        // Close the mic before speaking, or TTS feeds straight back into STT.
        stopListening({ flush: false });
        setListening(false);
        sendRef.current(text);
      },
      onStateChange: (state) => setListening(state === 'listening'),
      onError: (err) => setError(err.message),
    });
  }, []);

  const startVoice = useCallback(async () => {
    if (listening) return;
    stopSpeaking();
    director.setState('listening');
    await startListening();
    setListening(true);
  }, [listening]);

  const stopVoice = useCallback(() => {
    stopListening({ flush: true });
    setListening(false);
    setInterimTranscript('');
  }, []);

  const toggleVoice = useCallback(() => {
    if (listening) stopVoice();
    else startVoice();
  }, [listening, startVoice, stopVoice]);

  // Hands-free loop: when ALOO finishes speaking and nothing else is in flight,
  // re-open the mic so the user can simply reply.
  useEffect(() => {
    if (!handsFreeRef.current) return undefined;
    if (speaking || streaming || listening) return undefined;
    // A short delay stops the mic catching the tail of the speaker output.
    const id = setTimeout(() => {
      if (handsFreeRef.current && !busyRef.current) startVoice();
    }, 550);
    return () => clearTimeout(id);
  }, [speaking, streaming, listening, startVoice]);

  /* ======================================================================== */
  /* Controls                                                                 */
  /* ======================================================================== */

  const stopAll = useCallback(() => {
    abortRef.current?.abort();
    stopSpeaking();
    setStreaming(false);
    setResearch((prev) => ({ ...prev, active: false }));
    busyRef.current = false;
  }, []);

  const clearConversation = useCallback(() => {
    stopAll();
    setMessages([
      { id: 'aloo-greeting', role: 'assistant', content: GREETING, at: null, greeting: true },
    ]);
    setResearch({ active: false, stage: null, detail: '', queries: [], sources: [], report: '' });
    setError(null);
  }, [stopAll]);

  const switchProvider = useCallback(
    (provider) => {
      stopSpeaking();
      set('provider', provider);
    },
    [set]
  );

  /** Ask ALOO about the current camera frame in one click. */
  const describeScene = useCallback(() => {
    if (!settings.cameraEnabled) {
      setError('Enable the live camera feed first.');
      return;
    }
    sendMessage('Look through my camera and describe what you can see, in detail.');
  }, [settings.cameraEnabled, sendMessage]);

  /* -- Teardown ------------------------------------------------------------ */
  useEffect(
    () => () => {
      abortRef.current?.abort();
      stopSpeaking();
      stopListening({ flush: false });
    },
    []
  );

  return {
    // settings
    settings,
    update,
    set,
    reset,
    switchProvider,
    providerLabel: providerLabel(settings),
    activeModel: activeModel(settings),
    hasActiveKey:
      settings.provider === PROVIDERS.NVIDIA ? !!settings.nvidiaApiKey : !!settings.geminiApiKey,

    // conversation
    messages,
    streaming,
    error,
    setError,
    sendMessage,
    clearConversation,
    stopAll,

    // research
    research,
    runResearch,

    // voice
    listening,
    speaking,
    interimTranscript,
    toggleVoice,
    startVoice,
    stopVoice,
    sttSupported,

    // vision
    webcam,
    describeScene,

    // 3D
    riggingReport,
    setRiggingReport,
    telemetry,
    setTelemetry,
    expression,
  };
}
