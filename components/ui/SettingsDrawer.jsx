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

import { useEffect, useRef, useState } from 'react';
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
  Upload,
  Link2,
  Trash2,
  Library,
  Lock,
  ClipboardPaste,
} from 'lucide-react';
import { SKETCHFAB_CATALOG } from '@/lib/modelLibrary';

import {
  PROVIDERS,
  NVIDIA_MODELS,
  GEMINI_MODELS,
  CAMERA_PRESETS,
  VIEWPORT_MODES,
  VISION_CAPABLE,
} from '@/lib/settingsStore';
import { fetchNvidiaModels } from '@/lib/modelCatalog';
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

/**
 * API key field, hardened for Android WebView.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * A plain controlled input silently EATS pastes on Android. The clipboard
 * overlay can set the element's value without firing an `input` event React
 * recognises; React then re-renders, sees its own (still empty) state, and
 * writes that back over the DOM. The user watches their key appear and then
 * vanish about a second later, and concludes the app deleted it.
 *
 * Four independent paths now capture the value, so no single failure loses it:
 *   1. onChange        — the normal path.
 *   2. onPaste         — re-read on the next tick, because the paste event
 *                        fires BEFORE the element's value is updated.
 *   3. a poll          — any divergence between the DOM and React state is
 *                        adopted. This catches value changes that fire no event
 *                        at all, whatever caused them.
 *   4. a Paste button  — reads the clipboard directly, bypassing the IME and
 *                        the paste event entirely. On a phone this is the path
 *                        that always works.
 *
 * THE POLL RUNS UNCONDITIONALLY, and that is the point.
 * It used to be gated on `focused`, which left the exact window the bug lives
 * in wide open: tapping Android's floating "Paste" chip moves focus to the
 * overlay, so the field blurs, the poll stops, and the paste then lands in a
 * DOM node nobody is watching. React re-renders from its stale state, writes
 * `value` back over the element, and the key the user just pasted disappears.
 * A 250ms interval on one text input costs nothing; the gate cost a whole
 * class of silent data loss.
 */
function SecretInput({ value, onChange, placeholder }) {
  const [visible, setVisible] = useState(false);
  const [pasteMsg, setPasteMsg] = useState(null);
  const ref = useRef(null);
  const has = !!value;

  // Path 3: adopt any DOM value React did not hear about — focused or not.
  useEffect(() => {
    const id = setInterval(() => {
      const el = ref.current;
      if (el && el.value !== value) onChange(el.value);
    }, 250);
    return () => clearInterval(id);
  }, [value, onChange]);

  // Path 4: read the clipboard directly.
  //
  // Order matters. Inside the APK, `navigator.clipboard.readText()` usually
  // rejects with NotAllowedError — Android WebView will not hand a page the
  // system clipboard on request, whatever the page's origin. Capacitor's native
  // Clipboard plugin has no such restriction because it reads through Java, so
  // it is tried FIRST on device and the web API is the fallback, not the other
  // way round.
  const pasteFromClipboard = async () => {
    setPasteMsg(null);

    const readNative = async () => {
      const plugin = typeof window !== 'undefined' && window.Capacitor?.Plugins?.Clipboard;
      if (!plugin?.read) return null;
      const { value: text } = await plugin.read();
      return typeof text === 'string' ? text : null;
    };
    const readWeb = async () => {
      if (!navigator.clipboard?.readText) return null;
      return navigator.clipboard.readText();
    };

    let text = null;
    let lastErr = null;
    for (const read of [readNative, readWeb]) {
      try {
        text = await read();
        if (text != null) break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (text && text.trim()) {
      onChange(text.trim());
      setPasteMsg({ ok: true, text: 'Pasted from clipboard' });
    } else if (text != null) {
      setPasteMsg({ ok: false, text: 'Clipboard is empty' });
    } else {
      setPasteMsg({
        ok: false,
        text: lastErr
          ? 'Clipboard blocked — long-press the field and paste'
          : 'Clipboard unavailable — long-press the field and paste',
      });
    }
    setTimeout(() => setPasteMsg(null), 4000);
  };

  return (
    <div>
      <div className="relative">
        <input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={`hud-input pr-16 ${has ? '!border-emerald-400/50' : ''}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onInput={(e) => onChange(e.currentTarget.value)}
          onPaste={(e) => {
            // The value is not updated yet when this fires.
            const el = e.currentTarget;
            setTimeout(() => onChange(el.value), 0);
          }}
          onBlur={(e) => onChange(e.currentTarget.value)}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          // Keeps the normal keyboard (and its paste bar) rather than a
          // password keyboard, which on some Android IMEs hides paste entirely.
          inputMode="text"
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          {has && (
            <button
              type="button"
              onClick={() => onChange('')}
              title="Clear this key"
              className="text-cyan-300/35 transition hover:text-pink-300"
            >
              <X size={11} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="text-cyan-300/40 transition hover:text-cyan-200"
            title={visible ? 'Hide' : 'Reveal'}
          >
            {visible ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
      </div>

      <div className="mt-1 flex items-center justify-between gap-2">
        {/* Explicit confirmation. A masked field looks identical whether it holds
            a key or nothing, which is exactly how a saved key comes to look lost. */}
        {has ? (
          <span className="flex items-center gap-1 text-[9px] text-emerald-300/80">
            <Check size={9} />
            Saved · {value.length} chars, ends &ldquo;{value.slice(-4)}&rdquo;
          </span>
        ) : (
          <span className="text-[9px] text-cyan-300/30">Not set</span>
        )}

        <button
          type="button"
          onClick={pasteFromClipboard}
          className="flex shrink-0 items-center gap-1 rounded border border-cyan-400/25 px-1.5 py-0.5
                     text-[9px] uppercase tracking-wider text-cyan-200/75 transition
                     hover:border-cyan-400/70 hover:bg-cyan-400/10"
        >
          <ClipboardPaste size={9} />
          Paste
        </button>
      </div>

      {pasteMsg && (
        <div
          className={`mt-1 text-[9px] leading-relaxed ${
            pasteMsg.ok ? 'text-emerald-300/80' : 'text-amber-200/80'
          }`}
        >
          {pasteMsg.text}
        </div>
      )}
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
/* Model library                                                               */
/* -------------------------------------------------------------------------- */

function ModelPicker({ label, kind, entries, selectedId, onSelect, onRemove }) {
  const selected = entries.find((e) => e.id === selectedId) || entries[0];
  return (
    <div>
      <Field label={label}>
        <select className="hud-select" value={selected?.id || ''} onChange={(e) => onSelect(e.target.value)}>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
              {e.builtin ? '' : e.source === 'upload' ? '  · on device' : '  · remote'}
            </option>
          ))}
        </select>
      </Field>
      {selected && (
        <div className="mt-1 flex items-start justify-between gap-2">
          <span className="text-[9px] leading-tight text-cyan-300/35">
            {selected.note ||
              (selected.size ? `${(selected.size / 1048576).toFixed(1)} MB stored on this device` : selected.url)}
          </span>
          {!selected.builtin && (
            <button
              type="button"
              onClick={() => onRemove(selected.id)}
              title="Remove from library"
              className="shrink-0 rounded p-1 text-pink-300/50 transition hover:bg-pink-400/10 hover:text-pink-200"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AddModelRow({ kind, onUpload, onAddUrl }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const [localError, setLocalError] = useState(null);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after a failure
    if (!file) return;
    setLocalError(null);
    setBusy(true);
    try {
      await onUpload(file, kind);
    } catch (err) {
      setLocalError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitUrl = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await onAddUrl(url, kind);
      setUrl('');
    } catch {
      /* the hook surfaces the message */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded border border-cyan-400/12 bg-black/25 p-2">
      <label
        className={`hud-btn w-full cursor-pointer ${busy ? 'opacity-50' : ''}`}
        title="Pick a .glb from this device — it is stored locally and works offline"
      >
        <Upload size={11} />
        {busy ? 'Importing…' : `Add ${kind === 'avatar' ? 'avatar' : 'environment'} from device`}
        {/*
          accept="*<!---->/*" ON PURPOSE. Android has no registered MIME type for
          .glb, so an accept list of ".glb,.gltf,model/gltf-binary" makes the
          system document picker match NOTHING — the user sees an empty "Recent"
          screen and cannot select their model at all. Accepting everything and
          validating the extension in JS is the only combination that works on
          both Android and desktop.
        */}
        <input type="file" accept="*/*" className="hidden" onChange={pick} disabled={busy} />
      </label>
      <p className="text-[8.5px] leading-relaxed text-cyan-300/30">
        Pick any <code className="text-cyan-300/60">.glb</code> or{' '}
        <code className="text-cyan-300/60">.gltf</code>. On Android the picker opens on
        &ldquo;Recent&rdquo;, which is often empty — tap the ☰ menu and browse to
        <span className="text-cyan-300/50"> Downloads</span> or your device storage.
      </p>

      <div className="flex gap-1.5">
        <input
          className="hud-input flex-1 !py-1.5 text-[11px]"
          placeholder="…or paste an https URL to a .glb"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitUrl()}
          spellCheck={false}
        />
        <button type="button" onClick={submitUrl} disabled={busy || !url.trim()} className="hud-btn !px-2 !py-1.5">
          <Link2 size={11} />
        </button>
      </div>

      {localError && (
        <div className="flex items-start gap-1.5 rounded border border-pink-400/25 bg-pink-400/5 p-1.5">
          <AlertTriangle size={10} className="mt-0.5 shrink-0 text-pink-400/80" />
          <span className="flex-1 text-[9px] leading-relaxed text-pink-100/75">{localError}</span>
        </div>
      )}
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
  update,
  reset,
  riggingReport,
  modelStatus,
  library,
}) {
  const [voices, setVoices] = useState([]);
  const [storageOk, setStorageOk] = useState(true);
  /* Seed list first so the picker is never empty, then swap in whatever NVIDIA
     actually serves right now. Hard-coded ids rot — see lib/modelCatalog.js. */
  const [nimCatalog, setNimCatalog] = useState({ models: NVIDIA_MODELS, live: false });

  useEffect(() => {
    if (!open) return;
    waitForVoices().then(setVoices);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    fetchNvidiaModels().then((c) => {
      if (alive) setNimCatalog(c);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  // Verify persistence for real rather than assuming it: a blocked localStorage
  // is silent, and the symptom is "my key disappeared after restarting".
  useEffect(() => {
    try {
      const probe = '__aloo_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      setStorageOk(true);
    } catch {
      setStorageOk(false);
    }
  }, []);

  const activeKeyPresent =
    settings.provider === PROVIDERS.NVIDIA ? !!settings.nvidiaApiKey : !!settings.geminiApiKey;
  const anyKeyPresent = !!settings.nvidiaApiKey || !!settings.geminiApiKey;

  /**
   * Save a key and, if the currently active provider has no key of its own,
   * switch to the one just configured. Entering a key is an unambiguous signal
   * that the user wants to use that provider.
   */
  const saveKey = (field, raw, provider) => {
    const value = String(raw || '').trim();
    const other = field === 'nvidiaApiKey' ? settings.geminiApiKey : settings.nvidiaApiKey;
    const activeHasKey =
      settings.provider === PROVIDERS.NVIDIA ? !!settings.nvidiaApiKey : !!settings.geminiApiKey;

    if (value && !activeHasKey && settings.provider !== provider) {
      update({ [field]: value, provider });
    } else if (value && !other && settings.provider !== provider) {
      update({ [field]: value, provider });
    } else {
      set(field, value);
    }
  };

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
        className={`glass-strong fixed right-0 top-0 z-40 flex h-[100dvh] w-full flex-col sm:max-w-[400px]
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
              <Field
                label="NVIDIA NIM Model"
                hint={
                  nimCatalog.live
                    ? `${nimCatalog.models.length} models live from NVIDIA`
                    : 'Built-in list (live catalogue unreachable)'
                }
              >
                <select
                  className="hud-select"
                  value={settings.nvidiaModel}
                  onChange={(e) => set('nvidiaModel', e.target.value)}
                >
                  {/* A saved id that is no longer served must still appear, or
                      the select would silently show a DIFFERENT model than the
                      one requests are actually using. Label it as retired. */}
                  {!nimCatalog.models.includes(settings.nvidiaModel) && (
                    <option value={settings.nvidiaModel}>
                      {settings.nvidiaModel}
                      {nimCatalog.live ? '  · retired' : ''}
                    </option>
                  )}
                  {nimCatalog.models.map((m) => (
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
            // Open by default until at least one key exists: this is the one
            // thing a new operator MUST do, and a collapsed section hides it.
            defaultOpen={!settings.nvidiaApiKey && !settings.geminiApiKey}
            badge={
              activeKeyPresent ? (
                <span className="rounded border border-emerald-400/40 bg-emerald-400/10 px-1 text-[8px] text-emerald-300">
                  ACTIVE
                </span>
              ) : anyKeyPresent ? (
                <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1 text-[8px] text-amber-300">
                  WRONG PROVIDER
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
                onChange={(v) => saveKey('nvidiaApiKey', v, PROVIDERS.NVIDIA)}
                placeholder="nvapi-…"
              />
            </Field>

            <Field label="Google Gemini API Key" hint="aistudio.google.com/app/apikey">
              <SecretInput
                value={settings.geminiApiKey}
                onChange={(v) => saveKey('geminiApiKey', v, PROVIDERS.GEMINI)}
                placeholder="AIza…"
              />
            </Field>

            {/* The most common "my key vanished" report is actually a key saved
                for the provider that is not selected: the badge stays MISSING
                and the HUD keeps saying AWAITING KEY. Say so, and offer the fix. */}
            {!activeKeyPresent && anyKeyPresent && (
              <div className="flex items-start gap-1.5 rounded border border-amber-400/30 bg-amber-400/10 p-2">
                <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-400" />
                <div className="flex-1">
                  <p className="text-[9.5px] leading-relaxed text-amber-100/80">
                    Your key is saved, but the active provider is{' '}
                    <b>{settings.provider === PROVIDERS.NVIDIA ? 'NVIDIA NIM' : 'Gemini'}</b>, which
                    has no key — so ALOO still shows &ldquo;awaiting key&rdquo;.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      set(
                        'provider',
                        settings.nvidiaApiKey ? PROVIDERS.NVIDIA : PROVIDERS.GEMINI
                      )
                    }
                    className="hud-btn hud-btn-active mt-1.5 !py-1"
                  >
                    Switch to {settings.nvidiaApiKey ? 'NVIDIA NIM' : 'Gemini'}
                  </button>
                </div>
              </div>
            )}

            {!storageOk && (
              <div className="flex items-start gap-1.5 rounded border border-pink-400/30 bg-pink-400/10 p-2">
                <AlertTriangle size={11} className="mt-0.5 shrink-0 text-pink-400" />
                <span className="text-[9.5px] leading-relaxed text-pink-100/80">
                  This browser is blocking local storage, so keys cannot be remembered between
                  sessions. Private/incognito mode and &ldquo;block site data&rdquo; both do this.
                </span>
              </div>
            )}

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

          {/* ============ MODEL LIBRARY ============ */}
          <Section icon={Library} title="Model Library" defaultOpen>
            <ModelPicker
              label="Active Avatar"
              kind="avatar"
              entries={library?.avatars || []}
              selectedId={settings.avatarModelId}
              onSelect={(id) => set('avatarModelId', id)}
              onRemove={(id) => library?.remove(id)}
            />
            <AddModelRow kind="avatar" onUpload={library?.upload} onAddUrl={library?.addUrl} />

            <ModelPicker
              label="Active Environment"
              kind="space"
              entries={library?.spaces || []}
              selectedId={settings.spaceModelId}
              onSelect={(id) => set('spaceModelId', id)}
              onRemove={(id) => library?.remove(id)}
            />
            <AddModelRow kind="space" onUpload={library?.upload} onAddUrl={library?.addUrl} />

            {library?.error && (
              <div className="flex items-start gap-1.5 rounded border border-pink-400/25 bg-pink-400/5 p-2">
                <AlertTriangle size={11} className="mt-0.5 shrink-0 text-pink-400/80" />
                <span className="flex-1 text-[9px] leading-relaxed text-pink-100/70">{library.error}</span>
                <button type="button" onClick={() => library.setError(null)} className="text-pink-300/50">
                  <X size={10} />
                </button>
              </div>
            )}

            <p className="text-[9px] leading-relaxed text-cyan-300/35">
              Models added from this device are stored in the browser&apos;s own database, so they
              survive reloads and work offline — including inside the Android app. Switching is
              instant; the rig is re-validated on every change.
            </p>

            {/* ---- Requested Sketchfab models ---- */}
            <div className="rounded border border-amber-400/20 bg-amber-400/5 p-2">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Lock size={10} className="text-amber-400/80" />
                <span className="text-[10px] uppercase tracking-[0.16em] text-amber-200/80">
                  Sketchfab picks — download disabled by the artists
                </span>
              </div>
              <p className="mb-2 text-[9px] leading-relaxed text-amber-100/55">
                All four are marked non-downloadable on Sketchfab, so no account or tool can fetch
                them — they are store items sold by their authors. Get the .glb from the artist,
                then add it above.
              </p>
              <div className="space-y-1">
                {SKETCHFAB_CATALOG.map((m) => (
                  <a
                    key={m.url}
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-1.5 rounded px-1 py-1 transition hover:bg-amber-400/10"
                  >
                    <ExternalLink size={9} className="mt-1 shrink-0 text-amber-300/40" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[10px] text-amber-100/80">{m.label}</span>
                      <span className="block truncate text-[8.5px] text-amber-200/40">
                        {m.author} · {m.stats}
                      </span>
                    </span>
                  </a>
                ))}
              </div>
            </div>
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

            <Toggle
              label="Auto-Fit Model"
              checked={settings.autoFit}
              onChange={(v) => set('autoFit', v)}
              hint="Measures the imported model on load and normalises it to the target height with its feet on the floor. Turn off only to place a model by hand."
            />
            <Slider
              label="Target Height"
              value={settings.avatarTargetHeight}
              min={0.8}
              max={3}
              step={0.02}
              onChange={(v) => set('avatarTargetHeight', v)}
              format={(v) => `${v.toFixed(2)} m`}
            />
            <Toggle
              label="Auto A-Pose"
              checked={settings.autoAPose}
              onChange={(v) => set('autoAPose', v)}
              hint="Rotates the upper-arm bones down out of the T-pose when the model ships no idle animation."
            />
            {/* Minimum 45, not 0. Below that the A-pose correction stops doing
                anything useful and the character stands splayed in her raw
                T-pose — which reads as a broken model, not as a setting. Use the
                Auto A-Pose toggle above to ask for the bind pose deliberately. */}
            <Slider
              label="Arm Rest Angle"
              value={Math.max(45, settings.aPoseAngle)}
              min={45}
              max={90}
              step={1}
              onChange={(v) => set('aPoseAngle', v)}
              format={(v) => `${v}°`}
            />

            <div className="rounded border border-cyan-400/12 bg-black/25 p-2">
              <span className="hud-label mb-1.5 block">Presence</span>
              <Toggle
                label="Idle Look-Around"
                checked={settings.idleLookAround}
                onChange={(v) => set('idleLookAround', v)}
                hint="Glances away and back on an irregular timer. Without this she stares."
              />
              <Toggle
                label="Weight Shift"
                checked={settings.weightShift}
                onChange={(v) => set('weightShift', v)}
                hint="Slow hip roll — nobody stands perfectly still."
              />
              <Toggle
                label="Generated Body Language"
                checked={settings.autoGestures}
                onChange={(v) => set('autoGestures', v)}
                hint="Synthesises gestures from parametric archetypes — randomised amplitude, timing and side, so they never repeat."
              />
              <Toggle
                label="Wake-Up Animation"
                checked={settings.introAnimation !== false}
                onChange={(v) => set('introAnimation', v)}
                hint="She comes online when the app opens — head lifts, shoulders open, a small greeting — instead of appearing already standing still."
              />
              <Toggle
                label="Facial Expression"
                checked={settings.facialExpression}
                onChange={(v) => set('facialExpression', v)}
                hint="Drives smile/brow/eye blendshapes from the same emotion. Needs a model that has them — VRoid, ARKit and ReadyPlayerMe naming are all recognised."
              />
              <Toggle
                label="Match Emotion To Replies"
                checked={settings.emotionFromReply}
                onChange={(v) => set('emotionFromReply', v)}
                hint="Reads the tone of each answer locally and picks a matching posture and gesture palette."
              />
              <Toggle
                label="React To Tap"
                checked={settings.tapReaction}
                onChange={(v) => set('tapReaction', v)}
                hint="Tap or click her: she turns to look at the spot and waves."
              />
              <Toggle
                label="Greet Out Loud On Tap"
                checked={settings.speakOnTap}
                onChange={(v) => set('speakOnTap', v)}
                hint="Speaks a short greeting locally — no API call, no cost."
              />
              <div className="mt-2 space-y-2">
                <Slider
                  label="Expression Intensity"
                  value={settings.expressionIntensity}
                  min={0}
                  max={1.6}
                  step={0.05}
                  onChange={(v) => set('expressionIntensity', v)}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
                <Slider
                  label="Gesture Intensity"
                  value={settings.gestureIntensity}
                  min={0}
                  max={1.8}
                  step={0.05}
                  onChange={(v) => set('gestureIntensity', v)}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
                <Slider
                  label="Elbow Bend"
                  value={settings.elbowBend}
                  min={0}
                  max={35}
                  step={1}
                  onChange={(v) => set('elbowBend', v)}
                  format={(v) => `${v}°`}
                />
                <Slider
                  label="Finger Curl"
                  value={settings.fingerCurl}
                  min={0}
                  // Capped at 20: the curl compounds down each finger, so
                  // anything above this closes the hand into a fist.
                  max={20}
                  step={1}
                  onChange={(v) => set('fingerCurl', v)}
                  format={(v) => `${v}°`}
                />
              </div>
            </div>

            <div className="rounded border border-cyan-400/12 bg-black/25 p-2">
              <span className="hud-label mb-1.5 block">Jaw Lip-Sync</span>
              <Slider
                label="Mouth Open Angle"
                value={settings.jawOpenAngle}
                min={0}
                max={45}
                step={1}
                onChange={(v) => set('jawOpenAngle', v)}
                format={(v) => `${v}°`}
              />
              <div className="mt-2">
                <Toggle
                  label="Invert Jaw Direction"
                  checked={settings.jawInvert}
                  onChange={(v) => set('jawInvert', v)}
                  hint="Flip if the jaw closes upward into the skull instead of dropping."
                />
                <Toggle
                  label="Eye Tracking"
                  checked={settings.eyeTracking}
                  onChange={(v) => set('eyeTracking', v)}
                  hint="Gaze follows the pointer when the rig has eye bones."
                />
              </div>
              <p className="mt-1 text-[9px] leading-relaxed text-cyan-300/30">
                Only used when the model has no viseme blendshapes. The hinge axis is derived from
                the rig automatically — these adjust how far and which way it swings.
              </p>
            </div>

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
            <Field
              label="Backdrop"
              hint="The starfield is what the scene has always shown. Pick the model to use your own environment GLB instead — it renders on its own, with its own lighting."
            >
              <select
                className="hud-select"
                value={settings.backdrop ?? 'stars'}
                onChange={(e) => set('backdrop', e.target.value)}
              >
                <option value="stars">Generated Starfield</option>
                <option value="model">Environment Model</option>
              </select>
            </Field>

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

            <div className="rounded border border-cyan-400/12 bg-black/25 p-2">
              <span className="hud-label mb-1.5 block">Environment Placement</span>
              <div className="space-y-2">
                <Slider
                  label="Size"
                  value={settings.spaceFitRadius}
                  min={20}
                  max={300}
                  step={5}
                  onChange={(v) => set('spaceFitRadius', v)}
                  format={(v) => `${v} m`}
                />
                <Slider
                  label="Environment Sideways"
                  value={settings.spaceOffsetX ?? 0}
                  min={-300}
                  max={300}
                  step={5}
                  onChange={(v) => set('spaceOffsetX', v)}
                  format={(v) => `${v}`}
                />
                <Slider
                  label="Distance"
                  value={-settings.spaceOffsetZ}
                  min={20}
                  max={500}
                  step={5}
                  onChange={(v) => set('spaceOffsetZ', -v)}
                  format={(v) => `${v} m`}
                />
                <Slider
                  label="Height"
                  value={settings.spaceOffsetY}
                  min={-100}
                  max={150}
                  step={2}
                  onChange={(v) => set('spaceOffsetY', v)}
                  format={(v) => `${v} m`}
                />
                <Slider
                  label="Tilt"
                  value={settings.spaceTilt}
                  min={-90}
                  max={90}
                  step={1}
                  onChange={(v) => set('spaceTilt', v)}
                  format={(v) => `${v}°`}
                />
              </div>
              <p className="mt-1.5 text-[9px] leading-relaxed text-cyan-300/30">
                The bundled environment is a galaxy disc, not a skybox — it is placed behind the
                avatar rather than wrapped around the camera.
              </p>
            </div>

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
