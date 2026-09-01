/**
 * ALOO — Futuristic control drawer.
 * ===========================================================================
 * Every runtime knob in one place, grouped into collapsible sections:
 *
 *   NEURAL CORE   provider routing, API keys, model selection, sampling
 *   VOICE         STT language, VAD window, TTS voice/rate/pitch, hands-free
 *   OPTICS        webcam toggle, capture cadence, JPEG quality
 *   PROJECTION    avatar scale/offset, camera presets, orbit constraints,
 *                 viewport mode, canvas opacity, HUD toggles
 *   DIAGNOSTICS   the live rigging report from RiggingValidator
 *
 * API keys are stored in localStorage (the PRD's bring-your-own-key model) and
 * are masked by default. They are sent only to this app's own origin, where the
 * edge proxies forward them upstream.
 */

import { useEffect, useState } from 'react';
import {
  X,
  KeyRound,
  Cpu,
  Mic,
  Camera,
  Boxes,
  Terminal,
  ChevronDown,
  Eye,
  EyeOff,
  RotateCcw,
  Check,
  AlertTriangle,
  XCircle,
  ExternalLink,
  Volume2,
} from 'lucide-react';

import {
  PROVIDERS,
  NVIDIA_MODELS,
  GEMINI_MODELS,
  CAMERA_PRESETS,
  VIEWPORT_MODES,
  VISION_CAPABLE,
} from '@/lib/settingsStore';
import { STT_LANGUAGES } from '@/services/sttService';
import { waitForVoices, speak, stopSpeaking } from '@/services/ttsLipSyncService';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

function Section({ icon: Icon, title, badge, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-cyan-400/12">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-cyan-400/5"
      >
        <span className="flex items-center gap-2">
          <Icon size={12} className="text-cyan-300" />
          <span className="text-[11px] uppercase tracking-[0.2em] text-cyan-100/80">{title}</span>
          {badge}
        </span>
        <ChevronDown
          size={13}
          className={`text-cyan-300/40 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="space-y-3 px-4 pb-4">{children}</div>}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="hud-label mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[9px] leading-tight text-cyan-300/30">{hint}</span>}
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="min-w-0">
        <span className="block text-[11px] text-cyan-100/75">{label}</span>
        {hint && <span className="block text-[9px] leading-tight text-cyan-300/30">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-4 w-8 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-cyan-400/70 bg-cyan-400/30' : 'border-cyan-400/20 bg-black/40'
        }`}
      >
        <span
          className={`absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all ${
            checked ? 'left-4 bg-cyan-300 shadow-glow' : 'left-0.5 bg-cyan-300/30'
          }`}
        />
      </button>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, format }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="hud-label">{label}</span>
        <span className="hud-value">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        className="hud-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function SecretInput({ value, onChange, placeholder }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        className="hud-input pr-9"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-cyan-300/40 transition hover:text-cyan-200"
        title={visible ? 'Hide' : 'Reveal'}
      >
        {visible ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

function GradePill({ grade }) {
  const map = {
    PASS: ['border-emerald-400/50 bg-emerald-400/12 text-emerald-300', Check],
    DEGRADED: ['border-amber-400/50 bg-amber-400/12 text-amber-300', AlertTriangle],
    PARTIAL: ['border-amber-400/50 bg-amber-400/12 text-amber-300', AlertTriangle],
    FAIL: ['border-pink-400/50 bg-pink-400/12 text-pink-300', XCircle],
  };
  const [cls, Icon] = map[grade] || map.FAIL;
  return (
    <span className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] tracking-wider ${cls}`}>
      <Icon size={9} />
      {grade}
    </span>
  );
}

function DiagnosticsPanel({ report, modelStatus, avatarUrl }) {
  if (!report) {
    return (
      <div className="rounded-md border border-cyan-400/15 bg-black/30 p-3">
        <p className="text-[11px] leading-relaxed text-cyan-100/60">
          {modelStatus === 'missing'
            ? 'No GLB detected — rendering the procedural holo-construct.'
            : 'Awaiting model load…'}
        </p>
        <p className="mt-2 text-[9.5px] leading-relaxed text-cyan-300/40">
          Drop a rigged character at{' '}
          <code className="rounded bg-black/50 px-1 text-cyan-300">public{avatarUrl}</code> and reload.
          ReadyPlayerMe exports work out of the box: they ship the full{' '}
          <code className="rounded bg-black/50 px-1 text-cyan-300">viseme_*</code> set.
        </p>
      </div>
    );
  }

  const levelColor = {
    ok: 'text-emerald-300/80',
    warn: 'text-amber-300/80',
    error: 'text-pink-300/85',
    info: 'text-cyan-300/60',
  };

  return (
    <div className="space-y-3">
      {/* Summary grid */}
      <div className="grid grid-cols-2 gap-2">
        {[
          ['Grade', <GradePill key="g" grade={report.grade} />],
          ['Bones', report.boneCount],
          ['Meshes', report.meshCount],
          ['Triangles', report.triangleCount.toLocaleString()],
          ['Visemes', `${report.visemeChecks.found.length}/15 · ${report.visemeChecks.coverage}%`],
          ['Clips', report.animations.length],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-cyan-400/12 bg-black/30 px-2 py-1.5">
            <div className="hud-label">{label}</div>
            <div className="hud-value mt-0.5">{value}</div>
          </div>
        ))}
      </div>

      {/* Bone checklist */}
      <div>
        <span className="hud-label mb-1 block">Bone Hierarchy</span>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {report.boneChecks.map((b) => (
            <div key={b.key} className="flex items-center gap-1.5 text-[10px]">
              {b.found ? (
                <Check size={9} className="shrink-0 text-emerald-400" />
              ) : (
                <XCircle size={9} className={`shrink-0 ${b.critical ? 'text-pink-400' : 'text-amber-400'}`} />
              )}
              <span className={b.found ? 'text-cyan-100/70' : 'text-cyan-300/35'}>{b.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Missing visemes */}
      {report.visemeChecks.missing.length > 0 && (
        <div>
          <span className="hud-label mb-1 block">Missing Visemes</span>
          <div className="flex flex-wrap gap-1">
            {report.visemeChecks.missing.map((v) => (
              <span
                key={v}
                className="rounded border border-amber-400/25 bg-amber-400/8 px-1 py-0.5 text-[9px] text-amber-200/70"
              >
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Console log mirror */}
      <div>
        <span className="hud-label mb-1 block">Diagnostic Log</span>
        <div className="max-h-44 space-y-0.5 overflow-y-auto rounded border border-cyan-400/12 bg-black/45 p-2 font-mono">
          {report.log.map((entry, i) => (
            <div key={`${entry.level}-${i}`} className={`text-[9.5px] leading-relaxed ${levelColor[entry.level]}`}>
              <span className="opacity-40">
                {entry.level === 'ok' ? '[ OK ]' : entry.level === 'warn' ? '[WARN]' : entry.level === 'error' ? '[FAIL]' : '[INFO]'}
              </span>{' '}
              {entry.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Drawer                                                                      */
/* -------------------------------------------------------------------------- */

export default function SettingsDrawer({
  open,
  onClose,
  settings,
  set,
  reset,
  riggingReport,
  modelStatus,
}) {
  const [voices, setVoices] = useState([]);

  useEffect(() => {
    if (!open) return;
    waitForVoices().then(setVoices);
  }, [open]);

  const visionOk = VISION_CAPABLE.includes(
    settings.provider === PROVIDERS.NVIDIA ? settings.nvidiaModel : settings.geminiModel
  );

  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/55 backdrop-blur-[2px] transition-opacity duration-300 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        className={`glass-strong fixed right-0 top-0 z-40 flex h-full w-full max-w-[390px] flex-col
                    border-l border-cyan-400/25 transition-transform duration-300 ease-out ${
                      open ? 'translate-x-0' : 'translate-x-full'
                    }`}
      >
        {/* ---- Header ---- */}
        <div className="flex items-center justify-between border-b border-cyan-400/20 px-4 py-3">
          <div>
            <div className="text-[12px] uppercase tracking-[0.3em] text-cyan-100/90">Control Drawer</div>
            <div className="text-[9px] uppercase tracking-[0.18em] text-cyan-300/35">
              ALOO System Configuration
            </div>
          </div>
          <button type="button" onClick={onClose} className="hud-btn !px-2 !py-2" title="Close">
            <X size={13} />
          </button>
        </div>

        {/* ---- Scrollable body ---- */}
        <div className="flex-1 overflow-y-auto">
          {/* ============ NEURAL CORE ============ */}
          <Section icon={Cpu} title="Neural Core" defaultOpen>
            <Field label="Active Provider">
              <div className="grid grid-cols-2 gap-2">
                {[
                  [PROVIDERS.GEMINI, 'Gemini'],
                  [PROVIDERS.NVIDIA, 'NVIDIA NIM'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => set('provider', value)}
                    className={`hud-btn ${settings.provider === value ? 'hud-btn-active' : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>

            {settings.provider === PROVIDERS.GEMINI ? (
              <Field label="Gemini Model">
                <select
                  className="hud-select"
                  value={settings.geminiModel}
                  onChange={(e) => set('geminiModel', e.target.value)}
                >
                  {GEMINI_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                      {VISION_CAPABLE.includes(m) ? '  · vision' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="NVIDIA NIM Model">
                <select
                  className="hud-select"
                  value={settings.nvidiaModel}
                  onChange={(e) => set('nvidiaModel', e.target.value)}
                >
                  {NVIDIA_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                      {VISION_CAPABLE.includes(m) ? '  · vision' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Slider
              label="Temperature"
              value={settings.temperature}
              min={0}
              max={1.5}
              step={0.05}
              onChange={(v) => set('temperature', v)}
              format={(v) => v.toFixed(2)}
            />
            <Slider
              label="Max Output Tokens"
              value={settings.maxTokens}
              min={256}
              max={8192}
              step={128}
              onChange={(v) => set('maxTokens', v)}
            />

            <Field label="System Persona" hint="Shapes ALOO's voice and behaviour on every turn.">
              <textarea
                rows={4}
                className="hud-input resize-none leading-relaxed"
                value={settings.systemPrompt}
                onChange={(e) => set('systemPrompt', e.target.value)}
              />
            </Field>
          </Section>

          {/* ============ API KEYS ============ */}
          <Section
            icon={KeyRound}
            title="API Keys"
            badge={
              (settings.provider === PROVIDERS.NVIDIA ? settings.nvidiaApiKey : settings.geminiApiKey) ? (
                <span className="rounded border border-emerald-400/40 bg-emerald-400/10 px-1 text-[8px] text-emerald-300">
                  SET
                </span>
              ) : (
                <span className="rounded border border-pink-400/40 bg-pink-400/10 px-1 text-[8px] text-pink-300">
                  MISSING
                </span>
              )
            }
          >
            <Field
              label="NVIDIA NIM API Key"
              hint="Get one free at build.nvidia.com → any model → Get API Key."
            >
              <SecretInput
                value={settings.nvidiaApiKey}
                onChange={(v) => set('nvidiaApiKey', v.trim())}
                placeholder="nvapi-…"
              />
            </Field>

            <Field label="Google Gemini API Key" hint="aistudio.google.com/app/apikey">
              <SecretInput
                value={settings.geminiApiKey}
                onChange={(v) => set('geminiApiKey', v.trim())}
                placeholder="AIza…"
              />
            </Field>

            <Field
              label="Tavily Search Key (optional)"
              hint="Greatly improves Deep Research. Without it ALOO falls back to a keyless DuckDuckGo/Wikipedia scrape."
            >
              <SecretInput
                value={settings.tavilyApiKey}
                onChange={(v) => set('tavilyApiKey', v.trim())}
                placeholder="tvly-…"
              />
            </Field>

            <div className="flex items-start gap-1.5 rounded border border-amber-400/20 bg-amber-400/5 p-2">
              <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-400/80" />
              <span className="text-[9px] leading-relaxed text-amber-100/60">
                Keys are kept in this browser&apos;s localStorage and sent only to this app&apos;s own
                server routes, which forward them upstream. Do not use a shared machine.
              </span>
            </div>
          </Section>

          {/* ============ VOICE ============ */}
          <Section icon={Mic} title="Voice Interface">
            <Toggle
              label="Speech Output (TTS)"
              checked={settings.ttsEnabled}
              onChange={(v) => {
                if (!v) stopSpeaking();
                set('ttsEnabled', v);
              }}
              hint="ALOO speaks replies aloud and drives the avatar's mouth."
            />
            <Toggle
              label="Hands-Free Mode"
              checked={settings.handsFree}
              onChange={(v) => set('handsFree', v)}
              hint="Re-opens the mic automatically after each reply."
            />

            <Field label="Recognition Language">
              <select
                className="hud-select"
                value={settings.sttLanguage}
                onChange={(e) => set('sttLanguage', e.target.value)}
              >
                {STT_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Field>

            <Slider
              label="VAD Silence Window"
              value={settings.vadSilenceMs}
              min={600}
              max={4000}
              step={100}
              onChange={(v) => set('vadSilenceMs', v)}
              format={(v) => `${(v / 1000).toFixed(1)}s`}
            />

            <Field label="TTS Voice">
              <select
                className="hud-select"
                value={settings.ttsVoiceURI}
                onChange={(e) => set('ttsVoiceURI', e.target.value)}
              >
                <option value="">System default</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </Field>

            <Slider
              label="Speech Rate"
              value={settings.ttsRate}
              min={0.6}
              max={1.8}
              step={0.02}
              onChange={(v) => set('ttsRate', v)}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <Slider
              label="Pitch"
              value={settings.ttsPitch}
              min={0.4}
              max={1.8}
              step={0.05}
              onChange={(v) => set('ttsPitch', v)}
              format={(v) => v.toFixed(2)}
            />
            <Slider
              label="Volume"
              value={settings.ttsVolume}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => set('ttsVolume', v)}
              format={(v) => `${Math.round(v * 100)}%`}
            />

            <button
              type="button"
              onClick={() => {
                stopSpeaking();
                speak(
                  'Voice systems nominal. Lip synchronisation engaged. I am ALOO.',
                  { ttsEnabled: true }
                );
              }}
              className="hud-btn w-full"
            >
              <Volume2 size={11} />
              Test Voice &amp; Lip-Sync
            </button>

            <Field
              label="Neural TTS Endpoint (optional)"
              hint="Any URL accepting POST {text, voice} and returning audio bytes. When set, lip-sync is driven by the real decoded waveform instead of a predicted timeline."
            >
              <input
                className="hud-input"
                value={settings.neuralTtsUrl}
                onChange={(e) => set('neuralTtsUrl', e.target.value.trim())}
                placeholder="https://…/v1/tts"
                spellCheck={false}
              />
            </Field>
          </Section>

          {/* ============ OPTICS ============ */}
          <Section icon={Camera} title="Optical Sensors">
            <Toggle
              label="Live Camera Feed"
              checked={settings.cameraEnabled}
              onChange={(v) => set('cameraEnabled', v)}
              hint="Streams webcam frames into the vision pipeline."
            />
            <Toggle
              label="Attach Frame To Prompts"
              checked={settings.visionAttachLatest}
              onChange={(v) => set('visionAttachLatest', v)}
              hint="Sends the newest frame with each message you transmit."
            />

            <Slider
              label="Capture Interval"
              value={settings.visionCaptureMs}
              min={500}
              max={10000}
              step={250}
              onChange={(v) => set('visionCaptureMs', v)}
              format={(v) => `${(v / 1000).toFixed(2)}s`}
            />
            <Slider
              label="JPEG Quality"
              value={settings.visionQuality}
              min={0.3}
              max={0.95}
              step={0.05}
              onChange={(v) => set('visionQuality', v)}
              format={(v) => `${Math.round(v * 100)}%`}
            />

            {!visionOk && (
              <div className="flex items-start gap-1.5 rounded border border-amber-400/20 bg-amber-400/5 p-2">
                <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-400/80" />
                <span className="text-[9px] leading-relaxed text-amber-100/60">
                  The selected model has no vision capability, so frames are stripped before sending.
                  Switch to a Gemini 1.5 model or a vision NIM.
                </span>
              </div>
            )}
          </Section>

          {/* ============ PROJECTION ============ */}
          <Section icon={Boxes} title="Holographic Projection">
            <Field label="Camera Preset">
              <select
                className="hud-select"
                value={settings.cameraPreset}
                onChange={(e) => set('cameraPreset', e.target.value)}
              >
                {Object.values(CAMERA_PRESETS).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Viewport Mode">
              <select
                className="hud-select"
                value={settings.viewportMode}
                onChange={(e) => set('viewportMode', e.target.value)}
              >
                {Object.values(VIEWPORT_MODES).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>

            <Slider
              label="Avatar Scale"
              value={settings.avatarScale}
              min={0.2}
              max={3}
              step={0.05}
              onChange={(v) => set('avatarScale', v)}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <Slider
              label="Offset X"
              value={settings.avatarOffsetX}
              min={-2}
              max={2}
              step={0.05}
              onChange={(v) => set('avatarOffsetX', v)}
              format={(v) => `${v.toFixed(2)} m`}
            />
            <Slider
              label="Offset Y"
              value={settings.avatarOffsetY}
              min={-2}
              max={2}
              step={0.05}
              onChange={(v) => set('avatarOffsetY', v)}
              format={(v) => `${v.toFixed(2)} m`}
            />
            <Slider
              label="Offset Z"
              value={settings.avatarOffsetZ}
              min={-2}
              max={2}
              step={0.05}
              onChange={(v) => set('avatarOffsetZ', v)}
              format={(v) => `${v.toFixed(2)} m`}
            />
            <Slider
              label="Canvas Opacity"
              value={settings.canvasOpacity}
              min={0.15}
              max={1}
              step={0.05}
              onChange={(v) => set('canvasOpacity', v)}
              format={(v) => `${Math.round(v * 100)}%`}
            />

            <Toggle
              label="Orbit Controls"
              checked={settings.orbitEnabled}
              onChange={(v) => set('orbitEnabled', v)}
              hint="Drag to rotate, scroll to zoom. Disabled during cinematic mode."
            />

            <Slider
              label="Pitch Range (min)"
              value={settings.minPolar}
              min={10}
              max={90}
              step={1}
              onChange={(v) => set('minPolar', Math.min(v, settings.maxPolar - 5))}
              format={(v) => `${v}°`}
            />
            <Slider
              label="Pitch Range (max)"
              value={settings.maxPolar}
              min={90}
              max={170}
              step={1}
              onChange={(v) => set('maxPolar', Math.max(v, settings.minPolar + 5))}
              format={(v) => `${v}°`}
            />
            <Slider
              label="Yaw Range (±)"
              value={settings.maxAzimuth}
              min={15}
              max={180}
              step={5}
              onChange={(v) => {
                set('maxAzimuth', v);
                set('minAzimuth', -v);
              }}
              format={(v) => `±${v}°`}
            />
            <Slider
              label="Zoom Near"
              value={settings.minZoom}
              min={0.3}
              max={2}
              step={0.05}
              onChange={(v) => set('minZoom', v)}
              format={(v) => `${v.toFixed(2)} m`}
            />
            <Slider
              label="Zoom Far"
              value={settings.maxZoom}
              min={2}
              max={12}
              step={0.1}
              onChange={(v) => set('maxZoom', v)}
              format={(v) => `${v.toFixed(1)} m`}
            />
            <Slider
              label="Ambient Rotation"
              value={settings.ambientRotationSpeed}
              min={0}
              max={0.12}
              step={0.002}
              onChange={(v) => set('ambientRotationSpeed', v)}
              format={(v) => `${(v * 100).toFixed(1)}`}
            />
            <Slider
              label="Particle Density"
              value={settings.particleDensity}
              min={200}
              max={5000}
              step={100}
              onChange={(v) => set('particleDensity', v)}
            />

            <Field label="Avatar Model URL" hint="Relative to /public, or an absolute https URL.">
              <input
                className="hud-input"
                value={settings.avatarModelUrl}
                onChange={(e) => set('avatarModelUrl', e.target.value)}
                spellCheck={false}
              />
            </Field>
            <Field label="Space Model URL">
              <input
                className="hud-input"
                value={settings.spaceModelUrl}
                onChange={(e) => set('spaceModelUrl', e.target.value)}
                spellCheck={false}
              />
            </Field>

            <div className="space-y-1 pt-1">
              <Toggle label="HUD Grid" checked={settings.hudGrid} onChange={(v) => set('hudGrid', v)} />
              <Toggle
                label="CRT Scanlines"
                checked={settings.hudScanlines}
                onChange={(v) => set('hudScanlines', v)}
              />
              <Toggle
                label="Telemetry Read-outs"
                checked={settings.showTelemetry}
                onChange={(v) => set('showTelemetry', v)}
              />
              <Toggle
                label="Audio Visualiser"
                checked={settings.showVisualizer}
                onChange={(v) => set('showVisualizer', v)}
              />
            </div>
          </Section>

          {/* ============ DIAGNOSTICS ============ */}
          <Section
            icon={Terminal}
            title="Rig Diagnostics"
            badge={riggingReport ? <GradePill grade={riggingReport.grade} /> : null}
          >
            <DiagnosticsPanel
              report={riggingReport}
              modelStatus={modelStatus}
              avatarUrl={settings.avatarModelUrl}
            />
          </Section>

          {/* ============ RESEARCH ============ */}
          <Section icon={ExternalLink} title="Research Engine">
            <Slider
              label="Search Depth (sub-queries)"
              value={settings.researchDepth}
              min={1}
              max={6}
              step={1}
              onChange={(v) => set('researchDepth', v)}
            />
            <Slider
              label="Results Per Query"
              value={settings.researchResultsPerQuery}
              min={2}
              max={10}
              step={1}
              onChange={(v) => set('researchResultsPerQuery', v)}
            />
            <p className="text-[9.5px] leading-relaxed text-cyan-300/35">
              A run plans sub-queries, searches each in parallel, reads the top documents in full,
              then synthesises a cited report. More depth means slower runs and higher token use.
            </p>
          </Section>
        </div>

        {/* ---- Footer ---- */}
        <div className="border-t border-cyan-400/20 p-3">
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Reset all settings to defaults? Your API keys are kept.')) reset();
            }}
            className="hud-btn hud-btn-danger w-full"
          >
            <RotateCcw size={11} />
            Reset Configuration
          </button>
        </div>
      </aside>
    </>
  );
}
