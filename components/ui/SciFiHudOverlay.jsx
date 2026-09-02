/**
 * ALOO — Year 2100 HUD overlay.
 * ===========================================================================
 * The chrome that sits between the user and the WebGL scene: animated grid,
 * scanlines, corner brackets, and live telemetry read-outs.
 *
 * Every layer is `pointer-events-none` so it never intercepts a drag meant for
 * OrbitControls — the single most common way an overlay like this breaks a 3D
 * app. Interactive children opt back in explicitly with `pointer-events-auto`.
 *
 * The four telemetry cards are exported individually. On desktop they float in
 * the left and right gutters; on a phone there are no gutters, so the mobile
 * shell renders the same components inside its DATA tab. Nothing is
 * desktop-only — every read-out stays reachable at 390px.
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

function Card({ icon: Icon, title, children, className = '' }) {
  return (
    <div className={`glass bracket rounded-lg p-3 ${className}`}>
      <div className="mb-2 flex items-center gap-1.5 border-b border-cyan-400/15 pb-1.5">
        <Icon size={11} className="text-cyan-300" />
        <span className="hud-label">{title}</span>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Exported panels — shared by the desktop gutters and the mobile DATA tab      */
/* -------------------------------------------------------------------------- */

export function CoreCard({ provider, model, connected, uptime }) {
  return (
    <Card icon={Cpu} title="Neural Core">
      <Readout label="Provider" value={provider} />
      <Readout label="Model" value={model.length > 20 ? `…${model.slice(-19)}` : model} />
      <Readout label="Link" value={connected ? 'SECURE' : 'NO KEY'} tone={connected ? 'ok' : 'danger'} />
      <Readout
        label="Uptime"
        value={`${String(Math.floor(uptime / 60)).padStart(2, '0')}:${String(uptime % 60).padStart(2, '0')}`}
      />
    </Card>
  );
}

export function RigCard({ riggingReport }) {
  const tone = !riggingReport
    ? 'cyan'
    : riggingReport.grade === 'PASS'
    ? 'ok'
    : riggingReport.grade === 'FAIL'
    ? 'danger'
    : 'warn';
  return (
    <Card icon={Boxes} title="Rig Status">
      <Readout label="Diagnostic" value={riggingReport?.grade || 'HOLO'} tone={tone} />
      <Readout label="Bones" value={riggingReport?.boneCount ?? '—'} />
      <Readout
        label="Visemes"
        value={riggingReport ? `${riggingReport.visemeChecks.found.length}/15` : 'PROC'}
        tone={riggingReport && riggingReport.visemeChecks.found.length === 0 ? 'warn' : 'cyan'}
      />
      <Readout label="Tris" value={riggingReport ? riggingReport.triangleCount.toLocaleString() : '—'} />
    </Card>
  );
}

export function CameraCard({ telemetry }) {
  return (
    <Card icon={Gauge} title="Camera Telemetry">
      <Readout label="Yaw" value={`${telemetry?.yaw?.toFixed(1) ?? '0.0'}°`} />
      <Readout label="Pitch" value={`${telemetry?.pitch?.toFixed(1) ?? '0.0'}°`} />
      <Readout label="Dist" value={`${telemetry?.distance?.toFixed(2) ?? '0.00'} m`} />
      <Readout label="FOV" value={`${telemetry?.fov?.toFixed(0) ?? '38'}°`} />
      <Readout
        label="FPS"
        value={telemetry?.fps ?? '—'}
        tone={telemetry?.fps >= 50 ? 'ok' : telemetry?.fps >= 28 ? 'warn' : 'danger'}
      />
    </Card>
  );
}

export function SubsystemCard({ listening, speaking, streaming, cameraActive }) {
  return (
    <Card icon={Radio} title="Subsystems">
      <Readout label="Audio In" value={listening ? 'ACTIVE' : 'STANDBY'} tone={listening ? 'ok' : 'cyan'} />
      <Readout label="Audio Out" value={speaking ? 'SPEAKING' : 'IDLE'} tone={speaking ? 'ok' : 'cyan'} />
      <Readout label="Optics" value={cameraActive ? 'ONLINE' : 'OFFLINE'} tone={cameraActive ? 'ok' : 'cyan'} />
      <Readout label="Inference" value={streaming ? 'STREAM' : 'READY'} tone={streaming ? 'warn' : 'cyan'} />
    </Card>
  );
}

/** Seconds since mount — shared by the desktop and mobile read-outs. */
export function useUptime() {
  const [uptime, setUptime] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setUptime(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return uptime;
}

/* -------------------------------------------------------------------------- */

export default function SciFiHudOverlay({
  showGrid = true,
  showScanlines = true,
  showTelemetry = true,
  compact = false, // phone: drop the gutters and the corner identity blocks
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
  const uptime = useUptime();

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(
        `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(
          2,
          '0'
        )}:${String(now.getUTCSeconds()).padStart(2, '0')}`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
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
      <div className="absolute left-2 top-2 h-6 w-6 border-l border-t border-cyan-400/35 md:left-3 md:top-3 md:h-8 md:w-8" />
      <div className="absolute right-2 top-2 h-6 w-6 border-r border-t border-cyan-400/35 md:right-3 md:top-3 md:h-8 md:w-8" />
      <div className="absolute bottom-2 left-2 h-6 w-6 border-b border-l border-cyan-400/35 md:bottom-3 md:left-3 md:h-8 md:w-8" />
      <div className="absolute bottom-2 right-2 h-6 w-6 border-b border-r border-cyan-400/35 md:bottom-3 md:right-3 md:h-8 md:w-8" />

      {/* --- Status ribbon --------------------------------------------------- */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 ${compact ? 'top-2.5' : 'top-4'}`}
      >
        <div className="glass flex items-center gap-2 rounded-full px-3 py-1 md:gap-2.5 md:px-4 md:py-1.5">
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
          <span className="text-[9px] uppercase tracking-[0.24em] text-cyan-100/90 md:text-[10px] md:tracking-[0.3em]">
            {status}
          </span>
          {!compact && (
            <>
              <span className="h-3 w-px bg-cyan-400/20" />
              <span className="hud-value text-[10px] text-cyan-300/60">{clock} UTC</span>
            </>
          )}
        </div>
      </div>

      {/* --- Desktop gutters (hidden on phones; the same cards live in the
              mobile DATA tab instead) ------------------------------------- */}
      {showTelemetry && !compact && (
        <>
          <div className="absolute left-4 top-16 hidden w-52 flex-col gap-2 md:flex">
            <CoreCard provider={provider} model={model} connected={connected} uptime={uptime} />
            <RigCard riggingReport={riggingReport} />
          </div>

          <div className="absolute right-4 top-16 hidden w-48 flex-col gap-2 lg:flex">
            <CameraCard telemetry={telemetry} />
            <SubsystemCard
              listening={listening}
              speaking={speaking}
              streaming={streaming}
              cameraActive={cameraActive}
            />
          </div>
        </>
      )}

      {/* --- Identity / build tag (desktop only — a phone needs the space) --- */}
      {!compact && (
        <>
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

          <div className="absolute bottom-4 right-4 hidden items-center gap-1.5 md:flex">
            <Activity size={10} className="text-cyan-400/50" />
            <span className="text-[9px] uppercase tracking-[0.22em] text-cyan-300/35">
              Holo-Interface v1.0 · Y2100
            </span>
          </div>
        </>
      )}
    </div>
  );
}
