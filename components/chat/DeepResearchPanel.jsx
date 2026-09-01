/**
 * ALOO — Deep Research output view.
 * ===========================================================================
 * Shows the research agent *working*, not just its result. The pipeline emits a
 * stage on every transition (plan -> search -> read -> synthesise), and each
 * stage is rendered as a step in a vertical timeline with its own live detail
 * line. The sources it actually consulted are listed underneath, numbered to
 * match the [n] citations in the report.
 *
 * Watching the steps advance is what makes a 30-second research run feel
 * accountable rather than broken.
 */

import { useState } from 'react';
import {
  Search,
  Globe,
  BookOpen,
  Sparkles,
  Check,
  Loader2,
  X,
  ExternalLink,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown';

const STAGES = [
  { key: 'planning', label: 'Decompose', icon: Sparkles, done: ['planned', 'searching', 'searched', 'reading', 'synthesizing', 'done'] },
  { key: 'searching', label: 'Search Web', icon: Search, done: ['searched', 'reading', 'synthesizing', 'done'] },
  { key: 'reading', label: 'Read Sources', icon: BookOpen, done: ['synthesizing', 'done'] },
  { key: 'synthesizing', label: 'Synthesise', icon: Globe, done: ['done'] },
];

/** Map the raw stage onto the four visible steps. */
function stageState(stepKey, stage, doneList) {
  if (!stage) return 'pending';
  if (doneList.includes(stage)) return 'done';
  if (stage === stepKey) return 'active';
  if (stage === 'planned' && stepKey === 'planning') return 'done';
  if (stage === 'searched' && stepKey === 'searching') return 'done';
  if (stage === 'error') return 'pending';
  return 'pending';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export default function DeepResearchPanel({ research, onClose, className = '' }) {
  const [showSources, setShowSources] = useState(true);
  const { active, stage, detail, queries = [], sources = [], report, question } = research || {};

  // Nothing to show until a run has started or finished.
  if (!stage && !report) return null;

  const failed = stage === 'error';

  return (
    <div className={`glass-strong bracket flex flex-col overflow-hidden rounded-xl ${className}`}>
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-violet-400/20 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Search size={12} className="shrink-0 text-violet-300" />
          <span className="hud-label !text-violet-300/70">Deep Research</span>
          {question && (
            <span className="truncate text-[10px] text-violet-100/45">· {question}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-violet-300/50 transition hover:bg-violet-400/10 hover:text-violet-200"
          title="Close"
        >
          <X size={12} />
        </button>
      </div>

      {/* ---- Pipeline timeline ---- */}
      <div className="border-b border-violet-400/15 px-3 py-2.5">
        <div className="flex items-center justify-between gap-1">
          {STAGES.map((step, i) => {
            const state = failed ? 'pending' : stageState(step.key, stage, step.done);
            const Icon = step.icon;
            return (
              <div key={step.key} className="flex flex-1 items-center gap-1">
                <div className="flex flex-col items-center gap-1">
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-full border transition-all ${
                      state === 'done'
                        ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-300'
                        : state === 'active'
                        ? 'border-violet-400/80 bg-violet-400/20 text-violet-200 shadow-glowViolet'
                        : 'border-cyan-400/15 bg-black/30 text-cyan-300/25'
                    }`}
                  >
                    {state === 'done' ? (
                      <Check size={11} />
                    ) : state === 'active' ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Icon size={11} />
                    )}
                  </div>
                  <span
                    className={`whitespace-nowrap text-[8px] uppercase tracking-[0.12em] ${
                      state === 'pending' ? 'text-cyan-300/25' : 'text-violet-200/70'
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
                {i < STAGES.length - 1 && (
                  <div
                    className={`mb-4 h-px flex-1 ${
                      state === 'done' ? 'bg-emerald-400/40' : 'bg-cyan-400/12'
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {detail && (
          <div
            className={`mt-2 flex items-center gap-1.5 text-[10px] ${
              failed ? 'text-pink-300/80' : 'text-violet-200/55'
            }`}
          >
            {failed ? (
              <AlertTriangle size={10} />
            ) : active ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Check size={10} className="text-emerald-400" />
            )}
            <span>{detail}</span>
          </div>
        )}
      </div>

      {/* ---- Sub-queries ---- */}
      {queries.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-violet-400/12 px-3 py-2">
          {queries.map((q) => (
            <span
              key={q}
              className="rounded border border-violet-400/25 bg-violet-400/8 px-1.5 py-0.5 text-[9px] text-violet-200/70"
            >
              {q}
            </span>
          ))}
        </div>
      )}

      {/* ---- Report ---- */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {report ? (
          <div
            className="md break-words text-[12px] leading-relaxed text-cyan-50/90"
            // Safe: renderMarkdown escapes before adding its own tags.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(report) }}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <span className="text-[10px] uppercase tracking-[0.2em] text-violet-300/35">
              Awaiting synthesis…
            </span>
          </div>
        )}
      </div>

      {/* ---- Sources ---- */}
      {sources.length > 0 && (
        <div className="border-t border-violet-400/15">
          <button
            type="button"
            onClick={() => setShowSources((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left transition hover:bg-violet-400/5"
          >
            <span className="hud-label !text-violet-300/70">Sources · {sources.length}</span>
            {showSources ? (
              <ChevronDown size={12} className="text-violet-300/50" />
            ) : (
              <ChevronRight size={12} className="text-violet-300/50" />
            )}
          </button>

          {showSources && (
            <div className="max-h-40 space-y-1 overflow-y-auto px-3 pb-2.5">
              {sources.map((s, i) => (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-2 rounded border border-transparent px-1.5 py-1 transition hover:border-violet-400/25 hover:bg-violet-400/5"
                >
                  <span className="mt-0.5 shrink-0 rounded bg-violet-400/15 px-1 text-[9px] tabular-nums text-violet-300">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10.5px] text-cyan-100/80 group-hover:text-cyan-50">
                      {s.title || hostOf(s.url)}
                    </span>
                    <span className="block truncate text-[9px] text-cyan-300/35">{hostOf(s.url)}</span>
                  </span>
                  <ExternalLink size={9} className="mt-1 shrink-0 text-violet-300/30" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
