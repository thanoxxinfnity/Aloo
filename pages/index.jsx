/**
 * ALOO — Main entrance viewport.
 * ===========================================================================
 * Composition root. Layer order, back to front:
 *
 *   z-0   WebGL canvas          the avatar + space environment
 *   z-20  SciFiHudOverlay       grid, scanlines, telemetry (pointer-events:none)
 *   z-25  Interactive HUD       chat console, camera tile, quick-action dock
 *   z-30  Settings scrim
 *   z-40  Settings drawer
 *
 * The canvas is loaded with `dynamic(..., { ssr: false })`: react-three-fiber
 * constructs a WebGLRenderer on mount, and there is no WebGL context on the
 * Node server — server-rendering it would throw during the render pass.
 *
 * VIEWPORT MODES change only where the canvas lives, never what it contains,
 * so switching modes never remounts the WebGL context (which would drop the
 * loaded model and reset the camera).
 */

import { useCallback, useMemo, useState } from 'react';
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
  X,
} from 'lucide-react';

import useAlooBrain from '@/hooks/useAlooBrain';
import useAssetAvailable from '@/hooks/useAssetAvailable';
import SciFiHudOverlay from '@/components/ui/SciFiHudOverlay';
import SettingsDrawer from '@/components/ui/SettingsDrawer';
import LiveCameraPreview from '@/components/ui/LiveCameraPreview';
import ChatWindow from '@/components/chat/ChatWindow';
import DeepResearchPanel from '@/components/chat/DeepResearchPanel';
import { VIEWPORT_MODES, VISION_CAPABLE, activeModel } from '@/lib/settingsStore';
import { stopSpeaking } from '@/services/ttsLipSyncService';

/** WebGL is client-only — see the note above. */
const AvatarCanvas = dynamic(() => import('@/components/3d/AvatarCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 size={22} className="animate-spin text-cyan-400/70" />
        <span className="text-[10px] uppercase tracking-[0.3em] text-cyan-300/40">
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
      className={`hud-btn flex-col !gap-1 !px-3 !py-2 ${active ? 'hud-btn-active' : ''} ${
        danger ? 'hud-btn-danger' : ''
      }`}
    >
      <Icon size={14} />
      <span className="text-[8px] tracking-[0.1em]">{label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */

export default function AlooViewport() {
  const aloo = useAlooBrain();
  const {
    settings,
    set,
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
    hasActiveKey,
    providerLabel,
  } = aloo;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [researchOpen, setResearchOpen] = useState(false);

  // Probe the avatar GLB once so the canvas can pick GLB vs procedural without
  // ever risking a Suspense throw. See hooks/useAssetAvailable.
  const modelStatus = useAssetAvailable(settings.avatarModelUrl);

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

  /** Open the research panel automatically when a run starts. */
  const onResearch = useCallback(
    (q) => {
      setResearchOpen(true);
      runResearch(q);
    },
    [runResearch]
  );

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

      <main className="relative h-screen w-screen overflow-hidden bg-abyss">
        {/* ================= LAYER 0 — WebGL ================= */}
        <div className={`z-0 ${canvasClass}`}>
          <AvatarCanvas
            settings={settings}
            modelStatus={modelStatus}
            onRiggingReport={setRiggingReport}
            onTelemetry={setTelemetry}
            className="h-full w-full"
          />
        </div>

        {/* ================= LAYER 20 — Passive HUD ================= */}
        <SciFiHudOverlay
          showGrid={settings.hudGrid}
          showScanlines={settings.hudScanlines}
          showTelemetry={settings.showTelemetry}
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
        />

        {/* ================= LAYER 25 — Interactive HUD ================= */}

        {/* --- Top-right controls --- */}
        <div className="absolute right-4 top-4 z-25 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            className={`hud-btn !px-2.5 !py-2 ${chatOpen ? 'hud-btn-active' : ''}`}
            title="Toggle comms channel"
          >
            <MessageSquare size={13} />
          </button>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="hud-btn !px-2.5 !py-2"
            title="Open control drawer"
          >
            <Settings size={13} />
          </button>
        </div>

        {/* --- Camera tile --- */}
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
          // Sits under the left telemetry column when it is visible.
          style={{ top: settings.showTelemetry ? '19rem' : '4rem' }}
        />

        {/* --- Bottom quick-action dock --- */}
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

        {/* --- Comms console --- */}
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

        {/* --- Deep research panel --- */}
        {researchOpen && (research.stage || research.report) && (
          <DeepResearchPanel
            className="absolute bottom-24 left-4 top-16 z-25 w-[min(420px,calc(100vw-2rem))]"
            research={research}
            onClose={() => setResearchOpen(false)}
          />
        )}

        {/* --- First-run key prompt --- */}
        {!hasActiveKey && (
          <div className="absolute left-1/2 top-1/2 z-25 w-[min(430px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2">
            <div className="glass-strong bracket rounded-xl p-5 text-center">
              <div className="mb-2 text-[11px] uppercase tracking-[0.32em] text-cyan-200/80">
                Neural Link Offline
              </div>
              <p className="mb-4 text-[11.5px] leading-relaxed text-cyan-100/60">
                ALOO needs an API key to think. Add a free key for{' '}
                <span className="text-cyan-300">Google Gemini</span> or{' '}
                <span className="text-cyan-300">NVIDIA NIM</span> in the control drawer — it is stored
                only in this browser.
              </p>
              <button type="button" onClick={() => setDrawerOpen(true)} className="hud-btn hud-btn-active mx-auto">
                <Settings size={12} />
                Open Control Drawer
              </button>
            </div>
          </div>
        )}

        {/* --- Error toast --- */}
        {error && (
          <div className="absolute bottom-24 left-1/2 z-30 w-[min(460px,calc(100vw-2rem))] -translate-x-1/2">
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
          reset={reset}
          riggingReport={riggingReport}
          modelStatus={modelStatus}
        />
      </main>
    </>
  );
}
