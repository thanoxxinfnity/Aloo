/**
 * ALOO — Phone layout.
 * ===========================================================================
 * A phone has no gutters, so the desktop's floating panels have nowhere to
 * float. Instead everything lives in one bottom sheet with three tabs:
 *
 *   COMMS   the conversation + composer
 *   DEEP    the research pipeline and its sources
 *   DATA    every telemetry card from the desktop gutters, plus the camera tile
 *
 * Nothing is dropped on mobile — the DATA tab exists precisely so the rig
 * diagnostics, camera telemetry and subsystem read-outs stay reachable at
 * 390px wide.
 *
 * SHEET HEIGHTS are two fixed snap points (peek / expanded) rather than free
 * dragging. Free drag on top of a WebGL canvas fights OrbitControls for the
 * same touch events, and the result is a sheet that jitters while the avatar
 * spins. Two taps beat one unreliable gesture.
 *
 * Layout uses `100dvh`, not `100vh`: mobile browsers include the collapsing
 * address bar in `vh`, which puts the composer under the URL bar on iOS Safari.
 */

import { ChevronDown, ChevronUp, MessageSquare, Search, Gauge } from 'lucide-react';
import ChatWindow from '@/components/chat/ChatWindow';
import DeepResearchPanel from '@/components/chat/DeepResearchPanel';
import LiveCameraPreview from '@/components/ui/LiveCameraPreview';
import {
  CoreCard,
  RigCard,
  CameraCard,
  SubsystemCard,
  useUptime,
} from '@/components/ui/SciFiHudOverlay';

const TABS = [
  { key: 'comms', label: 'Comms', icon: MessageSquare },
  { key: 'deep', label: 'Deep', icon: Search },
  { key: 'data', label: 'Data', icon: Gauge },
];

export default function MobileShell({
  tab,
  onTabChange,
  expanded,
  onToggleExpanded,
  // chat
  messages,
  streaming,
  listening,
  speaking,
  interimTranscript,
  sttSupported,
  showVisualizer,
  onSend,
  onResearch,
  onStop,
  onClear,
  onToggleVoice,
  // research
  research,
  // telemetry
  provider,
  model,
  connected,
  telemetry,
  riggingReport,
  cameraActive,
  expression,
  // camera
  webcam,
  settings,
  visionReady,
  onDescribe,
}) {
  const uptime = useUptime();

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-25 flex flex-col"
      style={{
        // Peek shows just the tab bar + composer; expanded takes most of the
        // screen but always leaves the avatar's head visible above it.
        height: expanded ? 'min(68dvh, 620px)' : 'auto',
      }}
    >
      <div className="glass-strong pointer-events-auto flex min-h-0 flex-1 flex-col rounded-t-2xl border-t border-cyan-400/25">
        {/* ---- Handle + tabs ---- */}
        <div className="flex items-center gap-1 border-b border-cyan-400/15 px-2 py-1.5">
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-cyan-300/60
                       transition active:bg-cyan-400/15"
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>

          <div className="flex flex-1 items-center gap-1">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onTabChange(key);
                  if (!expanded) onToggleExpanded();
                }}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5
                            text-[10px] uppercase tracking-[0.14em] transition ${
                              tab === key
                                ? 'border-cyan-400/70 bg-cyan-400/18 text-cyan-50'
                                : 'border-cyan-400/15 bg-transparent text-cyan-200/55'
                            }`}
              >
                <Icon size={11} />
                {label}
                {key === 'deep' && research?.active && (
                  <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Tab body (only when expanded) ---- */}
        {expanded && (
          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === 'comms' && (
              <ChatWindow
                className="h-full !rounded-none !border-0 !bg-transparent !shadow-none"
                chrome={false}
                messages={messages}
                streaming={streaming}
                listening={listening}
                speaking={speaking}
                interimTranscript={interimTranscript}
                sttSupported={sttSupported}
                showVisualizer={showVisualizer}
                onSend={onSend}
                onResearch={onResearch}
                onStop={onStop}
                onClear={onClear}
                onToggleVoice={onToggleVoice}
              />
            )}

            {tab === 'deep' &&
              (research?.stage || research?.report ? (
                <DeepResearchPanel
                  className="h-full !rounded-none !border-0 !bg-transparent"
                  research={research}
                  onClose={() => onTabChange('comms')}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                  <Search size={20} className="text-violet-300/40" />
                  <p className="text-[11px] leading-relaxed text-violet-200/50">
                    No research run yet. Type a question in Comms and tap the magnifier to plan
                    sub-queries, search the web and synthesise a cited report.
                  </p>
                </div>
              ))}

            {tab === 'data' && (
              <div className="h-full space-y-2 overflow-y-auto p-3">
                {settings.cameraEnabled && (
                  <LiveCameraPreview
                    videoRef={webcam.videoRef}
                    active={webcam.active}
                    enabled
                    error={webcam.error}
                    frameCount={webcam.frameCount}
                    resolution={webcam.resolution}
                    visionReady={visionReady}
                    onDescribe={onDescribe}
                  />
                )}
                <CoreCard provider={provider} model={model} connected={connected} uptime={uptime} />
                <RigCard riggingReport={riggingReport} />
                <CameraCard telemetry={telemetry} />
                <SubsystemCard
                  listening={listening}
                  speaking={speaking}
                  streaming={streaming}
                  cameraActive={cameraActive}
                  expression={expression}
                />
                {riggingReport && (
                  <div className="glass bracket rounded-lg p-3">
                    <div className="hud-label mb-1.5 border-b border-cyan-400/15 pb-1.5">
                      Diagnostic Log
                    </div>
                    <div className="max-h-40 space-y-0.5 overflow-y-auto font-mono">
                      {riggingReport.log.map((e, i) => (
                        <div
                          key={`${e.level}-${i}`}
                          className={`text-[9px] leading-relaxed ${
                            e.level === 'ok'
                              ? 'text-emerald-300/75'
                              : e.level === 'warn'
                              ? 'text-amber-300/75'
                              : e.level === 'error'
                              ? 'text-pink-300/80'
                              : 'text-cyan-300/55'
                          }`}
                        >
                          {e.message}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---- Collapsed: keep the composer reachable without expanding ---- */}
        {!expanded && tab === 'comms' && (
          <ChatWindow
            className="!rounded-none !border-0 !bg-transparent !shadow-none"
            chrome={false}
            composerOnly
            messages={messages}
            streaming={streaming}
            listening={listening}
            speaking={speaking}
            interimTranscript={interimTranscript}
            sttSupported={sttSupported}
            showVisualizer={false}
            onSend={onSend}
            onResearch={onResearch}
            onStop={onStop}
            onClear={onClear}
            onToggleVoice={onToggleVoice}
          />
        )}
      </div>
    </div>
  );
}
