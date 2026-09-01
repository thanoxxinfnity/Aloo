/**
 * ALOO — Live camera preview + vision frame telemetry.
 * ===========================================================================
 * Renders the webcam feed as a floating HUD tile. The <video> element is always
 * mounted (never conditionally removed) because `useWebcam` attaches the
 * MediaStream to its ref — unmounting it mid-stream would drop the srcObject
 * and leave a live track with nowhere to render.
 *
 * When the camera is off the tile collapses to nothing but the element stays in
 * the tree, hidden.
 */

import { Camera, Scan, AlertTriangle, Loader2 } from 'lucide-react';

export default function LiveCameraPreview({
  videoRef,
  active,
  enabled,
  error,
  frameCount,
  resolution,
  visionReady,
  onDescribe,
  className = '',
  style,
}) {
  return (
    <div className={className} style={{ ...style, display: enabled ? 'block' : 'none' }}>
      <div className="glass bracket relative overflow-hidden rounded-lg">
        {/* Header strip */}
        <div className="flex items-center justify-between border-b border-cyan-400/15 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <Camera size={11} className="text-cyan-300" />
            <span className="hud-label">Optic Feed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={`status-dot ${active ? 'bg-emerald-400' : 'bg-amber-400'} ${
                active ? 'animate-pulse' : ''
              }`}
            />
            <span className="hud-value text-[9px]">{active ? 'LIVE' : 'INIT'}</span>
          </div>
        </div>

        <div className="relative">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="block h-auto w-full bg-black/70"
            style={{
              // Mirror the feed: users expect a webcam to behave like a mirror.
              transform: 'scaleX(-1)',
              aspectRatio: '4 / 3',
              objectFit: 'cover',
            }}
          />

          {/* Targeting reticle overlay */}
          {active && (
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute left-2 top-2 h-3 w-3 border-l border-t border-cyan-400/70" />
              <div className="absolute right-2 top-2 h-3 w-3 border-r border-t border-cyan-400/70" />
              <div className="absolute bottom-2 left-2 h-3 w-3 border-b border-l border-cyan-400/70" />
              <div className="absolute bottom-2 right-2 h-3 w-3 border-b border-r border-cyan-400/70" />
              <div className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-400/25" />
              <div className="sweep absolute inset-x-0 h-8 animate-scan" />
            </div>
          )}

          {!active && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <Loader2 size={16} className="animate-spin text-cyan-300" />
            </div>
          )}

          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/80 px-3 text-center">
              <AlertTriangle size={16} className="text-pink-400" />
              <span className="text-[9px] leading-tight text-pink-200/80">{error}</span>
            </div>
          )}
        </div>

        {/* Telemetry footer */}
        <div className="flex items-center justify-between border-t border-cyan-400/15 px-2.5 py-1.5">
          <span className="hud-value text-[9px] text-cyan-300/60">
            {resolution ? `${resolution.w}×${resolution.h}` : '—'} · {frameCount} frames
          </span>
          <button
            type="button"
            onClick={onDescribe}
            disabled={!active}
            title={
              visionReady
                ? 'Ask ALOO to describe what the camera sees'
                : 'The active model has no vision capability — switch to Gemini 1.5 or a vision NIM'
            }
            className="flex items-center gap-1 rounded border border-cyan-400/25 px-1.5 py-0.5 text-[9px]
                       uppercase tracking-wider text-cyan-200/80 transition hover:border-cyan-400/70
                       hover:bg-cyan-400/10 disabled:opacity-30"
          >
            <Scan size={9} />
            Analyse
          </button>
        </div>

        {!visionReady && active && (
          <div className="border-t border-amber-400/20 bg-amber-400/5 px-2.5 py-1">
            <span className="text-[9px] leading-tight text-amber-200/70">
              Active model is text-only — frames will not be sent.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
