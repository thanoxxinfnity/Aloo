/**
 * ALOO — Year 2100 HUD overlay.
 * ===========================================================================
 * The chrome that sits between the user and the WebGL scene: animated grid,
 * scanlines, corner brackets, and live telemetry read-outs.
 *
 * Every layer is `pointer-events-none` so it never intercepts a drag meant for
 * OrbitControls — the single most common way an overlay like this breaks a 3D
 * app. Interactive children opt back in explicitly with `pointer-events-auto`.
 */

import { useEffect, useState } from 'react';
import { Activity, Cpu, Radio, Boxes, Gauge, Zap } from 'lucide-react';

/** A labelled telemetry cell. */
function Readout({ label, value, tone = 'cyan' }) {
  const toneClass =
    tone === 'ok'
      ? 'text-emerald-300'
      : tone === 'warn'
      ? 'text-amber-300'
      : tone === 'danger'
      ? 'text-pink-300'
      : 'text-cyan-200';
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="hud-label">{label}</span>
      <span className={`hud-value ${toneClass}`}>{value}</span>
    </div>
  );
}

export default function SciFiHudOverlay({
  showGrid = true,
  showScanlines = true,
  showTelemetry = true,
  telemetry,
  status = 'IDLE',
  provider = '—',
  model = '—',
  riggingReport,
  connected = false,
  listening = false,
  speaking = false,
  streaming = false,
  cameraActive = false,
}) {
  const [clock, setClock] = useState('--:--:--');
  const [uptime, setUptime] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => {
      const now = new Date();
      setClock(
        `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(
          now.getUTCSeconds()
        ).padStart(2, '0')}`
      );
      setUptime(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const statusTone = streaming
    ? 'warn'
    : listening
    ? 'ok'
    : speaking
    ? 'cyan'
    : connected
    ? 'cyan'
    : 'danger';

  const rigTone =
    !riggingReport
      ? 'cyan'
      : riggingReport.grade === 'PASS'
      ? 'ok'
      : riggingReport.grade === 'FAIL'
      ? 'danger'
      : 'warn';

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {/* --- Background layers --------------------------------------------- */}
      {showGrid && <div className="hud-grid absolute inset-0 opacity-70" />}
      {showScanlines && <div className="scanlines absolute inset-0" />}

      {/* Vignette — pulls the eye to the centre where the avatar is. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 32%, rgba(3,6,14,0.55) 78%, rgba(3,6,14,0.92) 100%)',
        }}
      />

      {/* A single sweeping scanline, slow enough not to distract. */}
      <div className="sweep absolute inset-x-0 h-40 animate-scan opacity-40" />

      {/* --- Frame brackets -------------------------------------------------- */}
      <div className="absolute left-3 top-3 h-8 w-8 border-l border-t border-cyan-400/35" />
      <div className="absolute right-3 top-3 h-8 w-8 border-r border-t border-cyan-400/35" />
      <div className="absolute bottom-3 left-3 h-8 w-8 border-b border-l border-cyan-400/35" />
      <div className="absolute bottom-3 right-3 h-8 w-8 border-b border-r border-cyan-400/35" />

      {/* --- Top-centre status ribbon ---------------------------------------- */}
      <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3">
        <div className="glass flex items-center gap-2.5 rounded-full px-4 py-1.5">
          <span
            className={`status-dot ${
              statusTone === 'ok'
                ? 'bg-emerald-400'
                : statusTone === 'warn'
                ? 'bg-amber-400'
                : statusTone === 'danger'
                ? 'bg-pink-400'
                : 'bg-cyan-400'
            } animate-pulse`}
          />
          <span className="text-[10px] uppercase tracking-[0.3em] text-cyan-100/90">{status}</span>
          <span className="h-3 w-px bg-cyan-400/20" />
          <span className="hud-value text-[10px] text-cyan-300/60">{clock} UTC</span>
        </div>
      </div>

      {/* --- Left telemetry column ------------------------------------------- */}
      {showTelemetry && (
        <div className="absolute left-4 top-16 hidden w-52 flex-col gap-2 md:flex">
          <div className="glass bracket rounded-lg p-3">
            <div className="mb-2 flex items-center gap-1.5 border-b border-cyan-400/15 pb-1.5">
              <Cpu size={11} className="text-cyan-300" />
              <span className="hud-label">Neural Core</span>
            </div>
            <div className="space-y-1">
              <Readout label="Provider" value={provider} />
              <Readout
                label="Model"
                value={model.length > 18 ? `…${model.slice(-17)}` : model}
              />
              <Readout label="Link" value={connected ? 'SECURE' : 'NO KEY'} tone={connected ? 'ok' : 'danger'} />
              <Readout label="Uptime" value={`${String(Math.floor(uptime / 60)).padStart(2, '0')}:${String(uptime % 60).padStart(2, '0')}`} />
            </div>
          </div>

          <div className="glass bracket rounded-lg p-3">
            <div className="mb-2 flex items-center gap-1.5 border-b border-cyan-400/15 pb-1.5">
              <Boxes size={11} className="text-cyan-300" />
              <span className="hud-label">Rig Status</span>
            </div>
            <div className="space-y-1">
              <Readout label="Diagnostic" value={riggingReport?.grade || 'HOLO'} tone={rigTone} />
              <Readout label="Bones" value={riggingReport?.boneCount ?? '—'} />
              <Readout
                label="Visemes"
                value={
                  riggingReport
                    ? `${riggingReport.visemeChecks.found.length}/15`
                    : 'PROC'
                }
              />
              <Readout label="Tris" value={riggingReport ? riggingReport.triangleCount.toLocaleString() : '—'} />
            </div>
          </div>
        </div>
      )}

      {/* --- Right telemetry column ------------------------------------------ */}
      {showTelemetry && (
        <div className="absolute right-4 top-16 hidden w-48 flex-col gap-2 lg:flex">
          <div className="glass bracket rounded-lg p-3">
            <div className="mb-2 flex items-center gap-1.5 border-b border-cyan-400/15 pb-1.5">
              <Gauge size={11} className="text-cyan-300" />
              <span className="hud-label">Camera Telemetry</span>
            </div>
            <div className="space-y-1">
              <Readout label="Yaw" value={`${telemetry?.yaw?.toFixed(1) ?? '0.0'}°`} />
              <Readout label="Pitch" value={`${telemetry?.pitch?.toFixed(1) ?? '0.0'}°`} />
              <Readout label="Dist" value={`${telemetry?.distance?.toFixed(2) ?? '0.00'} m`} />
              <Readout label="FOV" value={`${telemetry?.fov?.toFixed(0) ?? '38'}°`} />
              <Readout
                label="FPS"
                value={telemetry?.fps ?? '—'}
                tone={telemetry?.fps >= 50 ? 'ok' : telemetry?.fps >= 28 ? 'warn' : 'danger'}
              />
            </div>
          </div>

          <div className="glass bracket rounded-lg p-3">
            <div className="mb-2 flex items-center gap-1.5 border-b border-cyan-400/15 pb-1.5">
              <Radio size={11} className="text-cyan-300" />
              <span className="hud-label">Subsystems</span>
            </div>
            <div className="space-y-1">
              <Readout label="Audio In" value={listening ? 'ACTIVE' : 'STANDBY'} tone={listening ? 'ok' : 'cyan'} />
              <Readout label="Audio Out" value={speaking ? 'SPEAKING' : 'IDLE'} tone={speaking ? 'ok' : 'cyan'} />
              <Readout label="Optics" value={cameraActive ? 'ONLINE' : 'OFFLINE'} tone={cameraActive ? 'ok' : 'cyan'} />
              <Readout label="Inference" value={streaming ? 'STREAM' : 'READY'} tone={streaming ? 'warn' : 'cyan'} />
            </div>
          </div>
        </div>
      )}

      {/* --- Bottom-left identity -------------------------------------------- */}
      <div className="absolute bottom-4 left-4 hidden items-end gap-3 md:flex">
        <div className="flex items-center gap-2">
          <Zap size={12} className="text-cyan-400/70" />
          <div>
            <div className="text-[13px] font-semibold tracking-[0.42em] text-cyan-100/85">ALOO</div>
            <div className="text-[8px] uppercase tracking-[0.28em] text-cyan-300/40">
              Autonomous Linked Optical Operator
            </div>
          </div>
        </div>
      </div>

      {/* --- Bottom-right build tag ------------------------------------------ */}
      <div className="absolute bottom-4 right-4 hidden items-center gap-1.5 md:flex">
        <Activity size={10} className="text-cyan-400/50" />
        <span className="text-[9px] uppercase tracking-[0.22em] text-cyan-300/35">
          Holo-Interface v1.0 · Y2100
        </span>
      </div>
    </div>
  );
}
