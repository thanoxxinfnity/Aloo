/**
 * ALOO — Main entrance viewport.
 * ===========================================================================
 * Composition root. Layer order, back to front:
 *
 *   z-0   WebGL canvas          the avatar + space environment
 *   z-20  SciFiHudOverlay       grid, scanlines, telemetry (pointer-events:none)
 *   z-25  Interactive HUD       chat console / mobile sheet, camera tile, dock
 *   z-30  Settings scrim
 *   z-40  Settings drawer
 *
 * The canvas is loaded with `dynamic(..., { ssr: false })`: react-three-fiber
 * constructs a WebGLRenderer on mount, and there is no WebGL context on the
 * Node server — server-rendering it would throw during the render pass.
 *
 * TWO LAYOUTS, ONE STATE. Desktop floats panels in the gutters; a phone has no
 * gutters, so `MobileShell` puts the same components into a tabbed bottom
 * sheet. Both read the identical `useAlooBrain` instance, and the WebGL canvas
 * is mounted once outside the branch — switching orientation must never remount
 * the GL context, which would drop the loaded model and reset the camera.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import {
  Settings,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  MessageSquare,
  Search,
  Loader2,
  Zap,
  AlertTriangle,
  Square,
  X,
} from 'lucide-react';

import useAlooBrain from '@/hooks/useAlooBrain';
import useAssetAvailable from '@/hooks/useAssetAvailable';
import useIsMobile from '@/hooks/useIsMobile';
import useModelLibrary from '@/hooks/useModelLibrary';
import SciFiHudOverlay from '@/components/ui/SciFiHudOverlay';
import SettingsDrawer from '@/components/ui/SettingsDrawer';
import LiveCameraPreview from '@/components/ui/LiveCameraPreview';
import MobileShell from '@/components/ui/MobileShell';
import ChatWindow from '@/components/chat/ChatWindow';
import DeepResearchPanel from '@/components/chat/DeepResearchPanel';
import { VIEWPORT_MODES, VISION_CAPABLE, activeModel } from '@/lib/settingsStore';
import { stopSpeaking } from '@/services/ttsLipSyncService';
import { director } from '@/lib/animationDirector';

/** WebGL is client-only — see the note above. */
const AvatarCanvas = dynamic(() => import('@/components/3d/AvatarCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 size={22} className="animate-spin text-cyan-400/70" />
        <span className="px-6 text-center text-[10px] uppercase tracking-[0.3em] text-cyan-300/40">
          Initialising holo-projector
        </span>
      </div>
    </div>
  ),
});

/* -------------------------------------------------------------------------- */

/** Where the canvas sits for each viewport mode. */
const CANVAS_LAYOUT = {
  [VIEWPORT_MODES.FULLSCREEN]: 'absolute inset-0',
  [VIEWPORT_MODES.HUD]: 'absolute inset-y-0 left-0 right-0 lg:right-[400px]',
  [VIEWPORT_MODES.PIP]:
    'absolute bottom-24 left-4 h-56 w-44 md:h-72 md:w-56 overflow-hidden rounded-xl border border-cyan-400/25 shadow-glow',
};

function DockButton({ icon: Icon, label, active, danger, onClick, disabled, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      className={`hud-btn min-h-[44px] flex-col !gap-1 !px-3 !py-2 ${active ? 'hud-btn-active' : ''} ${
        danger ? 'hud-btn-danger' : ''
      }`}
    >
      <Icon size={14} />
      <span className="text-[8px] tracking-[0.1em]">{label}</span>
    </button>
  );
}

/** Compact round control used by the phone's right-edge rail. */
function RailButton({ icon: Icon, active, danger, onClick, disabled, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`glass flex h-11 w-11 items-center justify-center rounded-full border transition ${
        danger
          ? 'border-pink-400/60 bg-pink-400/20 text-pink-100'
          : active
          ? 'border-cyan-400/80 bg-cyan-400/25 text-cyan-50 shadow-glow'
          : 'border-cyan-400/25 text-cyan-200/70'
      } disabled:opacity-30`}
    >
      <Icon size={17} />
    </button>
  );
}

/* -------------------------------------------------------------------------- */

export default function AlooViewport() {
  const aloo = useAlooBrain();
  const {
    settings,
    set,
    update,
    reset,
    messages,
    streaming,
    error,
    setError,
    sendMessage,
    clearConversation,
    stopAll,
    research,
    runResearch,
    listening,
    speaking,
    interimTranscript,
    toggleVoice,
    sttSupported,
    webcam,
    describeScene,
    riggingReport,
    setRiggingReport,
    telemetry,
    setTelemetry,
    expression,
    hasActiveKey,
    providerLabel,
  } = aloo;

  const isMobile = useIsMobile();
  const library = useModelLibrary(settings, set);

  /**
   * With no key she cannot answer, so she SHOWS you where to fix it: every so
   * often she looks up at the settings gear and points at it.
   *
   * Repeating on a timer rather than firing once is deliberate — the user who
   * needs this hint is the one who just opened the app and is still looking
   * around, and a single gesture in the first two seconds is missed by exactly
   * that person. It stops the moment a key lands.
   */
  useEffect(() => {
    if (hasActiveKey || settings.autoGestures === false) return undefined;
    const point = () => {
      // Never interrupt her mid-sentence with an unrelated instruction.
      if (director.state === 'speaking') return;
      director.setEmotion('warm', 0.7);
      director.trigger('pointAtSettings');
    };
    const first = setTimeout(point, 4000);
    const repeat = setInterval(point, 22000);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [hasActiveKey, settings.autoGestures]);

  // The canvas takes URLs, the library stores IDs. Resolve here so nothing
  // below this line has to know the library exists.
  const sceneSettings = useMemo(
    () => ({
      ...settings,
      avatarModelUrl: library.resolved.avatarUrl,
      spaceModelUrl: library.resolved.spaceUrl,
    }),
    [settings, library.resolved]
  );

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [researchOpen, setResearchOpen] = useState(false);
  const [keyPromptDismissed, setKeyPromptDismissed] = useState(false);

  // Mobile sheet state.
  const [sheetTab, setSheetTab] = useState('comms');
  const [sheetExpanded, setSheetExpanded] = useState(false);

  // Probe the avatar GLB once so the canvas can pick GLB vs procedural without
  // ever risking a Suspense throw. See hooks/useAssetAvailable.
  const modelStatus = useAssetAvailable(sceneSettings.avatarModelUrl);

  // A stale rig report from the previous GLB must not linger once the scene
  // falls back to the procedural construct — the HUD would report bones that
  // are no longer in the scene.
  useEffect(() => {
    if (modelStatus === 'missing') setRiggingReport(null);
  }, [modelStatus, setRiggingReport]);

  const model = activeModel(settings);
  const visionReady = VISION_CAPABLE.includes(model);

  const status = streaming
    ? research.active
      ? 'RESEARCHING'
      : 'PROCESSING'
    : listening
    ? 'LISTENING'
    : speaking
    ? 'SPEAKING'
    : hasActiveKey
    ? 'STANDBY'
    : 'AWAITING KEY';

  /** Open the research view automatically when a run starts. */
  const onResearch = useCallback(
    (q) => {
      if (isMobile) {
        setSheetTab('deep');
        setSheetExpanded(true);
      } else {
        setResearchOpen(true);
      }
      runResearch(q);
    },
    [runResearch, isMobile]
  );

  // The same failure is already rendered as an assistant message, so the toast
  // is a transient nudge, not the record — leaving it pinned just covers the UI.
  useEffect(() => {
    if (!error) return undefined;
    const id = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(id);
  }, [error, setError]);

  const toggleTts = useCallback(() => {
    if (settings.ttsEnabled) stopSpeaking();
    set('ttsEnabled', !settings.ttsEnabled);
  }, [settings.ttsEnabled, set]);

  const canvasClass = useMemo(
    () => CANVAS_LAYOUT[settings.viewportMode] || CANVAS_LAYOUT[VIEWPORT_MODES.FULLSCREEN],
    [settings.viewportMode]
  );

  return (
    <>
      <Head>
        <title>ALOO · Holographic AI Interface</title>
      </Head>

      {/* 100dvh, not 100vh: mobile browsers count the collapsing address bar in
          `vh`, which pushes the composer underneath the URL bar on iOS. */}
      <main className="relative w-screen overflow-hidden bg-abyss" style={{ height: '100dvh' }}>
        {/* ================= LAYER 0 — WebGL ================= */}
        <div className={`z-0 ${isMobile ? 'absolute inset-0' : canvasClass}`}>
          <AvatarCanvas
            settings={sceneSettings}
            modelStatus={modelStatus}
            onRiggingReport={setRiggingReport}
            onTelemetry={setTelemetry}
            // The expanded mobile sheet hides ~68% of the screen; tell the
            // camera so it reframes her face into the visible strip.
            uiBias={isMobile && sheetExpanded ? 0.68 : 0}
            className="h-full w-full"
          />
        </div>

        {/* ================= LAYER 20 — Passive HUD ================= */}
        <SciFiHudOverlay
          showGrid={settings.hudGrid}
          showScanlines={settings.hudScanlines}
          showTelemetry={settings.showTelemetry}
          compact={isMobile}
          telemetry={telemetry}
          status={status}
          provider={providerLabel}
          model={model}
          riggingReport={riggingReport}
          connected={hasActiveKey}
          listening={listening}
          speaking={speaking}
          streaming={streaming}
          cameraActive={webcam.active}
          expression={expression}
        />

        {/* ================= LAYER 25 — Interactive HUD ================= */}

        {/* --- Top-right controls (both layouts) --- */}
        <div className="absolute right-3 top-3 z-25 flex items-center gap-2 md:right-4 md:top-4">
          {!isMobile && (
            <button
              type="button"
              onClick={() => setChatOpen((v) => !v)}
              className={`hud-btn !px-2.5 !py-2 ${chatOpen ? 'hud-btn-active' : ''}`}
              title="Toggle comms channel"
            >
              <MessageSquare size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="hud-btn min-h-[40px] min-w-[40px] !px-2.5 !py-2"
            title="Open control drawer"
          >
            <Settings size={15} />
          </button>
        </div>

        {isMobile ? (
          <>
            {/* --- Phone: right-edge action rail, clear of the sheet --- */}
            {/* The rail sits clear of the sheet in both snap positions. The
                collapsed sheet is the tab bar plus the composer (~7.5rem). */}
            <div
              className="absolute right-3 z-25 flex flex-col gap-2"
              style={{ bottom: sheetExpanded ? 'calc(min(68dvh, 620px) + 0.75rem)' : '7.75rem' }}
            >
              {/* No mic here — the composer's mic button is always on screen. */}
              <RailButton
                icon={settings.ttsEnabled ? Volume2 : VolumeX}
                active={settings.ttsEnabled}
                onClick={toggleTts}
                title="Spoken replies"
              />
              <RailButton
                icon={settings.cameraEnabled ? Video : VideoOff}
                active={settings.cameraEnabled}
                onClick={() => set('cameraEnabled', !settings.cameraEnabled)}
                title="Live camera feed"
              />
              {streaming && <RailButton icon={Square} danger onClick={stopAll} title="Stop" />}
            </div>

            <MobileShell
              tab={sheetTab}
              onTabChange={setSheetTab}
              expanded={sheetExpanded}
              onToggleExpanded={() => setSheetExpanded((v) => !v)}
              messages={messages}
              streaming={streaming}
              listening={listening}
              speaking={speaking}
              interimTranscript={interimTranscript}
              sttSupported={sttSupported}
              showVisualizer={settings.showVisualizer}
              onSend={sendMessage}
              onResearch={onResearch}
              onStop={stopAll}
              onClear={clearConversation}
              onToggleVoice={toggleVoice}
              research={research}
              provider={providerLabel}
              model={model}
              connected={hasActiveKey}
              telemetry={telemetry}
              riggingReport={riggingReport}
              cameraActive={webcam.active}
              expression={expression}
              webcam={webcam}
              settings={settings}
              visionReady={visionReady}
              onDescribe={describeScene}
            />
          </>
        ) : (
          <>
            {/* --- Desktop: floating camera tile --- */}
            <LiveCameraPreview
              className="absolute left-4 z-25 w-40 md:w-48"
              videoRef={webcam.videoRef}
              active={webcam.active}
              enabled={settings.cameraEnabled}
              error={webcam.error}
              frameCount={webcam.frameCount}
              resolution={webcam.resolution}
              visionReady={visionReady}
              onDescribe={describeScene}
              style={{ top: settings.showTelemetry ? '19rem' : '4rem' }}
            />

            {/* --- Desktop: bottom dock --- */}
            <div className="absolute bottom-5 left-1/2 z-25 -translate-x-1/2">
              <div className="glass bracket flex items-center gap-1.5 rounded-xl px-2.5 py-2">
                <DockButton
                  icon={listening ? Mic : MicOff}
                  label={listening ? 'LIVE' : 'MIC'}
                  active={listening}
                  onClick={toggleVoice}
                  disabled={!sttSupported}
                  title={
                    sttSupported
                      ? listening
                        ? 'Stop listening'
                        : 'Start voice input'
                      : 'Speech recognition needs Chrome or Edge'
                  }
                />
                <DockButton
                  icon={settings.ttsEnabled ? Volume2 : VolumeX}
                  label="VOICE"
                  active={settings.ttsEnabled}
                  onClick={toggleTts}
                  title="Toggle spoken replies"
                />
                <DockButton
                  icon={settings.cameraEnabled ? Video : VideoOff}
                  label="OPTIC"
                  active={settings.cameraEnabled}
                  onClick={() => set('cameraEnabled', !settings.cameraEnabled)}
                  title="Toggle the live camera feed"
                />
                <DockButton
                  icon={Search}
                  label="DEEP"
                  active={researchOpen}
                  onClick={() => setResearchOpen((v) => !v)}
                  title="Toggle the deep research panel"
                />
                <span className="mx-1 h-8 w-px bg-cyan-400/15" />
                <DockButton
                  icon={streaming ? Loader2 : Zap}
                  label={streaming ? 'STOP' : 'READY'}
                  danger={streaming}
                  onClick={streaming ? stopAll : () => setDrawerOpen(true)}
                  title={streaming ? 'Abort the current turn' : 'Open configuration'}
                />
              </div>
            </div>

            {/* --- Desktop: comms console --- */}
            {chatOpen && (
              <ChatWindow
                className="absolute bottom-24 right-4 top-16 z-25 w-[min(400px,calc(100vw-2rem))]"
                messages={messages}
                streaming={streaming}
                listening={listening}
                speaking={speaking}
                interimTranscript={interimTranscript}
                sttSupported={sttSupported}
                showVisualizer={settings.showVisualizer}
                onSend={sendMessage}
                onResearch={onResearch}
                onStop={stopAll}
                onClear={clearConversation}
                onToggleVoice={toggleVoice}
              />
            )}

            {/* --- Desktop: deep research panel --- */}
            {researchOpen && (research.stage || research.report) && (
              <DeepResearchPanel
                className="absolute bottom-24 left-4 top-16 z-25 w-[min(420px,calc(100vw-2rem))]"
                research={research}
                onClose={() => setResearchOpen(false)}
              />
            )}
          </>
        )}

        {/* --- First-run key prompt ---
            POINTER-EVENTS MATTER HERE. This card is on screen exactly when the
            operator has no key yet — i.e. while they are trying to reach the
            settings, the tabs and the rail. A full-width interactive wrapper
            swallowed every one of those taps, so the wrapper is inert and only
            the card itself takes input. It is also dismissible, because a
            permanent overlay on a phone is a wall. */}
        {!hasActiveKey && !keyPromptDismissed &&
          (isMobile ? (
            /* Phone: a compact banner pinned under the status pill. Floating a
               card in the middle of the screen put it straight on top of the
               sheet tabs and the right-edge rail — the very controls someone
               with no key still needs to reach. */
            <div className="pointer-events-none absolute inset-x-3 top-12 z-25">
              <div className="glass-strong bracket pointer-events-auto flex items-center gap-2 rounded-lg p-2.5">
                <AlertTriangle size={14} className="shrink-0 text-amber-400" />
                <span className="flex-1 text-[10.5px] leading-snug text-cyan-100/70">
                  No API key yet — ALOO cannot think until you add one.
                </span>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="hud-btn hud-btn-active shrink-0 !px-2 !py-1.5 text-[9px]"
                >
                  Add key
                </button>
                <button
                  type="button"
                  onClick={() => setKeyPromptDismissed(true)}
                  aria-label="Dismiss"
                  className="shrink-0 rounded p-1 text-cyan-300/40"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ) : (
            <div className="pointer-events-none absolute left-1/2 top-1/2 z-25 w-[min(430px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2">
              <div className="glass-strong bracket pointer-events-auto relative rounded-xl p-5 text-center">
                <button
                  type="button"
                  onClick={() => setKeyPromptDismissed(true)}
                  aria-label="Dismiss"
                  className="absolute right-2 top-2 rounded p-1 text-cyan-300/40 transition hover:text-cyan-200"
                >
                  <X size={12} />
                </button>
                <div className="mb-2 text-[11px] uppercase tracking-[0.32em] text-cyan-200/80">
                  Neural Link Offline
                </div>
                <p className="mb-4 text-[11.5px] leading-relaxed text-cyan-100/60">
                  ALOO needs an API key to think. Add a free key for{' '}
                  <span className="text-cyan-300">Google Gemini</span> or{' '}
                  <span className="text-cyan-300">NVIDIA NIM</span> in the control drawer — it is
                  stored only in this browser.
                </p>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="hud-btn hud-btn-active mx-auto min-h-[44px]"
                >
                  <Settings size={12} />
                  Open Control Drawer
                </button>
              </div>
            </div>
          ))}

        {/* --- Error toast --- */}
        {error && (
          <div
            className="absolute left-1/2 z-30 w-[min(460px,calc(100vw-1.5rem))] -translate-x-1/2"
            style={{
              bottom: isMobile
                ? sheetExpanded
                  ? 'calc(min(68dvh, 620px) + 0.75rem)'
                  : 'calc(9rem + env(safe-area-inset-bottom))'
                : '6rem',
            }}
          >
            <div className="glass-strong flex items-start gap-2 rounded-lg border-pink-400/35 p-3">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-pink-400" />
              <span className="flex-1 text-[11px] leading-relaxed text-pink-100/85">{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="rounded p-0.5 text-pink-300/60 transition hover:text-pink-200"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        )}

        {/* ================= LAYER 30/40 — Settings ================= */}
        <SettingsDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          settings={settings}
          set={set}
          update={update}
          reset={reset}
          riggingReport={riggingReport}
          modelStatus={modelStatus}
          library={library}
        />
      </main>
    </>
  );
}
