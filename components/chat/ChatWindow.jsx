/**
 * ALOO — Real-time conversation stream.
 * ===========================================================================
 * A glass console docked to the right of the viewport. Three details matter:
 *
 *  1. AUTO-SCROLL THAT RESPECTS THE USER — we only pin to the bottom while the
 *     user is already near it. Yanking the view down mid-read while tokens
 *     stream in is the fastest way to make a chat UI feel hostile.
 *  2. STREAMING RENDER — the assistant bubble re-renders per token, so the
 *     markdown pass is memoised per message id + length.
 *  3. UNTRUSTED HTML — model output goes through `renderMarkdown`, which
 *     escapes first and re-adds only our own tags.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  User,
  Send,
  Square,
  Trash2,
  Loader2,
  Search,
  Copy,
  Check,
  Volume2,
  Mic,
  MicOff,
  AlertTriangle,
  Camera,
} from 'lucide-react';
import { renderMarkdown, markdownToPlain } from '@/lib/markdown';
import { speak, stopSpeaking } from '@/services/ttsLipSyncService';
import AudioVisualizer from '@/components/ui/AudioVisualizer';

/* -------------------------------------------------------------------------- */

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdownToPlain(text));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — nothing useful to say */
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title="Copy"
      className="rounded p-1 text-cyan-300/40 transition hover:bg-cyan-400/10 hover:text-cyan-200"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function SpeakButton({ text }) {
  return (
    <button
      type="button"
      onClick={() => {
        stopSpeaking();
        speak(text);
      }}
      title="Speak this reply"
      className="rounded p-1 text-cyan-300/40 transition hover:bg-cyan-400/10 hover:text-cyan-200"
    >
      <Volume2 size={11} />
    </button>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user';

  // Re-render markdown only when the content actually grows.
  const html = useMemo(
    () => (isUser ? null : renderMarkdown(message.content)),
    [isUser, message.content]
  );

  // `at` is null for the server-rendered greeting — formatting a live clock
  // during SSR would produce a different string on the client and break hydration.
  const time = message.at
    ? new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar chip */}
      <div
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border ${
          isUser
            ? 'border-indigo-400/35 bg-indigo-400/10 text-indigo-300'
            : message.isError
            ? 'border-pink-400/40 bg-pink-400/10 text-pink-300'
            : 'border-cyan-400/35 bg-cyan-400/10 text-cyan-300'
        }`}
      >
        {isUser ? <User size={12} /> : message.isError ? <AlertTriangle size={12} /> : <Bot size={12} />}
      </div>

      <div className={`min-w-0 max-w-[86%] ${isUser ? 'items-end text-right' : ''}`}>
        {/* Meta line */}
        <div
          className={`mb-1 flex items-center gap-2 text-[9px] uppercase tracking-[0.18em] text-cyan-300/35 ${
            isUser ? 'justify-end' : ''
          }`}
        >
          <span>{isUser ? 'Operator' : 'ALOO'}</span>
          {time && <span>{time}</span>}
          {message.isResearch && (
            <span className="rounded border border-violet-400/30 bg-violet-400/10 px-1 text-violet-300">
              DEEP
            </span>
          )}
          {message.images?.length > 0 && (
            <span className="flex items-center gap-0.5 rounded border border-emerald-400/30 bg-emerald-400/10 px-1 text-emerald-300">
              <Camera size={8} /> VISION
            </span>
          )}
        </div>

        <div
          className={`rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed ${
            isUser
              ? 'border-indigo-400/25 bg-indigo-500/10 text-indigo-50'
              : message.isError
              ? 'border-pink-400/30 bg-pink-500/10 text-pink-100'
              : 'border-cyan-400/18 bg-cyan-500/[0.055] text-cyan-50/95'
          }`}
        >
          {isUser ? (
            <>
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
              {message.images?.map((src) => (
                <img
                  key={src.slice(-24)}
                  src={src}
                  alt="Captured camera frame sent with this message"
                  className="mt-2 max-h-28 rounded border border-emerald-400/25"
                />
              ))}
            </>
          ) : message.pending && !message.content ? (
            <span className="flex items-center gap-2 text-cyan-300/60">
              <Loader2 size={12} className="animate-spin" />
              <span className="text-[11px] uppercase tracking-[0.18em]">Processing…</span>
            </span>
          ) : (
            <div
              className={`md break-words ${message.pending ? 'caret' : ''}`}
              // Safe: renderMarkdown escapes all input before adding its own tags.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>

        {/* Actions */}
        {!isUser && !message.pending && message.content && !message.isError && (
          <div className="mt-1 flex items-center gap-0.5">
            <CopyButton text={message.content} />
            <SpeakButton text={message.content} />
            {message.model && (
              <span className="ml-1 text-[9px] tracking-wider text-cyan-300/25">{message.model}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export default function ChatWindow({
  messages,
  streaming,
  listening,
  speaking,
  interimTranscript,
  sttSupported,
  onSend,
  onResearch,
  onStop,
  onClear,
  onToggleVoice,
  showVisualizer = true,
  className = '',
  // The mobile sheet supplies its own frame and tab bar, so it turns off this
  // component's header/border; `composerOnly` renders just the input row for
  // the collapsed sheet, keeping one send path instead of a second copy.
  chrome = true,
  composerOnly = false,
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);
  const inputRef = useRef(null);

  /* -- Auto-scroll, but only when the user hasn't scrolled up -------------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, interimTranscript]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 80px of slack: "near the bottom" should survive a stray wheel tick.
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = (mode) => {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft('');
    if (mode === 'research') onResearch(text);
    else onSend(text);
  };

  const onKeyDown = (e) => {
    // Enter sends; Shift+Enter is a newline; Ctrl/Cmd+Enter runs deep research.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(e.ctrlKey || e.metaKey ? 'research' : 'chat');
    }
  };

  const visualizerMode = listening
    ? 'listening'
    : speaking
    ? 'speaking'
    : streaming
    ? 'thinking'
    : 'idle';

  const composer = (
    <div className="border-t border-cyan-400/15 p-2.5" style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}>
      <div className="flex items-end gap-2">
        {sttSupported && (
          <button
            type="button"
            onClick={onToggleVoice}
            // 44px minimum: anything smaller is unreliable under a thumb.
            className={`hud-btn min-h-[44px] min-w-[44px] !px-2.5 !py-2.5 ${
              listening ? 'hud-btn-active' : ''
            }`}
            title={listening ? 'Stop listening' : 'Start voice input'}
          >
            {listening ? <Mic size={15} className="animate-pulse" /> : <MicOff size={15} />}
          </button>
        )}

        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={listening ? 'Listening…' : 'Transmit a message…'}
          // 16px on mobile: iOS Safari zooms the whole page for anything smaller.
          className="hud-input max-h-28 min-h-[44px] flex-1 resize-none py-2.5 text-[16px] leading-snug md:text-[12px]"
        />

        <button
          type="button"
          onClick={() => submit('research')}
          disabled={!draft.trim() || streaming}
          className="hud-btn min-h-[44px] min-w-[44px] !px-2.5 !py-2.5"
          title="Deep research (Ctrl+Enter) — plans sub-queries, searches the web, then synthesises with citations"
        >
          <Search size={15} />
        </button>

        <button
          type="button"
          onClick={() => submit('chat')}
          disabled={!draft.trim() || streaming}
          className="hud-btn hud-btn-active min-h-[44px] min-w-[44px] !px-2.5 !py-2.5 disabled:!bg-cyan-400/5 disabled:!shadow-none"
          title="Send (Enter)"
        >
          {streaming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>

        {composerOnly && streaming && (
          <button type="button" onClick={onStop} className="hud-btn hud-btn-danger min-h-[44px] min-w-[44px] !px-2.5 !py-2.5" title="Stop">
            <Square size={14} />
          </button>
        )}
      </div>

      {!composerOnly && (
        <div className="mt-1.5 hidden items-center justify-between px-0.5 md:flex">
          <span className="text-[9px] tracking-wider text-cyan-300/25">
            ENTER send · SHIFT+ENTER newline · CTRL+ENTER deep research
          </span>
          <span className="text-[9px] tracking-wider text-cyan-300/25">{draft.length}</span>
        </div>
      )}
    </div>
  );

  if (composerOnly) return <div className={className}>{composer}</div>;

  return (
    <div
      className={`flex flex-col overflow-hidden ${
        chrome ? 'glass bracket rounded-xl' : ''
      } ${className}`}
    >
      {/* ---- Header ---- */}
      {chrome && (
      <div className="flex items-center justify-between border-b border-cyan-400/15 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={`status-dot ${streaming ? 'bg-amber-400' : 'bg-cyan-400'} animate-pulse`} />
          <span className="hud-label">Comms Channel</span>
        </div>
        <div className="flex items-center gap-1">
          {streaming && (
            <button type="button" onClick={onStop} className="hud-btn hud-btn-danger !px-2 !py-1" title="Stop">
              <Square size={10} />
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            className="hud-btn !px-2 !py-1"
            title="Clear conversation"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
      )}

      {/* ---- Stream ---- */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 space-y-4 overflow-y-auto px-3 py-3"
      >
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {/* Live transcript while the mic is open */}
        {interimTranscript && (
          <div className="flex flex-row-reverse gap-2.5">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-emerald-400/35 bg-emerald-400/10 text-emerald-300">
              <Mic size={12} className="animate-pulse" />
            </div>
            <div className="max-w-[86%] rounded-lg border border-emerald-400/25 border-dashed bg-emerald-500/5 px-3 py-2 text-[12.5px] italic text-emerald-100/70">
              {interimTranscript}
            </div>
          </div>
        )}
      </div>

      {/* ---- Visualiser ---- */}
      {showVisualizer && (
        <div className="border-t border-cyan-400/12 px-3 py-1.5">
          <AudioVisualizer height={34} bars={44} mode={visualizerMode} />
        </div>
      )}

      {/* ---- Composer ---- */}
      {composer}
    </div>
  );
}
