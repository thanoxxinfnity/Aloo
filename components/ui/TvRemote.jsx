/**
 * ALOO — the television, as a thing you can hold.
 * ===========================================================================
 * Voice is the fast path for anything you can name ("volume 20", "Kesariya
 * chala do"). This is for everything else: the D-pad crawl through a menu, the
 * eighth press of channel-up, the moment the TV asks you to type something. All
 * of that is faster with a thumb than a sentence, and a remote that only listens
 * is a remote you put down.
 *
 * TWO THINGS SHAPE THE LAYOUT
 *
 *   1. It has to work one-handed on a phone. So the D-pad sits in the lower
 *      half, everything is at least 44px, and nothing important hides behind a
 *      scroll.
 *
 *   2. A TV command takes a network round trip. Buttons therefore report their
 *      OWN state — pressed, working, failed — instead of freezing the panel,
 *      because a remote that stops responding while it thinks feels broken even
 *      when it is working perfectly.
 *
 * WHAT IS DELIBERATELY NOT HERE: a "power on" that pretends. Waking the TV is a
 * Wake-on-LAN packet with no acknowledgement, so that button says it is waiting
 * and then reports what actually happened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, CornerDownLeft,
  Home, Info, LayoutGrid, List, Loader2, Menu, MonitorOff, Pause, Play, Power,
  RotateCcw, Search, SkipBack, SkipForward, Square, Volume1, Volume2, VolumeX, X,
} from 'lucide-react';

import {
  runTvCommand, pressTvButton, pressColour, COLOUR_BUTTONS,
  getTvVolume, listTvInputs, subscribeTv, getTvState, typeOnTv,
} from '@/services/lgWebosService';
import { TV_COMMANDS, TV_APPS } from '@/lib/tvCommands';

/* -------------------------------------------------------------------------- */
/* One button                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A remote key that knows whether its own press landed.
 *
 * The flash of green or pink is the entire point: on a real remote the
 * television itself is the feedback, but a phone is often pointed away from the
 * screen, and "did that work?" is the question a soft remote has to answer.
 */
function Key({ onPress, children, label, className = '', wide = false, danger = false }) {
  const [phase, setPhase] = useState('idle'); // idle | busy | ok | fail
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const press = async () => {
    if (phase === 'busy') return;
    setPhase('busy');
    try {
      await onPress();
      if (alive.current) setPhase('ok');
    } catch {
      // The message is surfaced by the panel's shared error line; the key only
      // needs to say "not this one".
      if (alive.current) setPhase('fail');
    }
    setTimeout(() => { if (alive.current) setPhase('idle'); }, 550);
  };

  const tone =
    phase === 'ok' ? 'border-emerald-400/70 bg-emerald-400/15 text-emerald-100'
    : phase === 'fail' ? 'border-pink-400/70 bg-pink-400/15 text-pink-100'
    : danger ? 'hud-btn-danger'
    : '';

  return (
    <button
      type="button"
      onClick={press}
      aria-label={label}
      title={label}
      className={`hud-btn min-h-[44px] px-2 ${wide ? 'col-span-2' : ''} ${tone} ${className}`}
    >
      {phase === 'busy' ? <Loader2 size={14} className="animate-spin" /> : children}
    </button>
  );
}

/** A labelled block of keys. */
function Row({ title, children, cols = 3 }) {
  return (
    <div className="space-y-1.5">
      {title && <p className="hud-label">{title}</p>}
      <div className={`grid gap-1.5`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The remote                                                                  */
/* -------------------------------------------------------------------------- */

export default function TvRemote({ open, onClose }) {
  const [link, setLink] = useState(getTvState());
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(null);
  const [inputs, setInputs] = useState([]);
  const [text, setText] = useState('');
  const [waking, setWaking] = useState(false);

  useEffect(() => subscribeTv(setLink), []);

  /** Every key goes through here so one failure message serves the whole panel. */
  const run = useCallback(async (fn) => {
    setError('');
    try {
      return await fn();
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }, []);

  const send = useCallback(
    (command, args) => run(() => runTvCommand(command, args)),
    [run]
  );

  // Volume is read once on open and after each change, rather than polled: the
  // TV answers in about 80ms and a poll would keep the screen awake for a number
  // nobody is watching.
  const refreshVolume = useCallback(async () => {
    try {
      const v = await getTvVolume();
      setVolume({ level: v?.volume ?? null, muted: !!v?.muted });
    } catch { /* the panel works fine without it */ }
  }, []);

  useEffect(() => {
    if (!open || link.status !== 'ready') return;
    refreshVolume();
    listTvInputs().then(setInputs).catch(() => setInputs([]));
  }, [open, link.status, refreshVolume]);

  if (!open) return null;

  const ready = link.status === 'ready';

  const changeVolume = async (command) => {
    await send(command);
    refreshVolume();
  };

  /** Wake the TV, then say what actually happened rather than assuming. */
  const wake = async () => {
    setWaking(true);
    setError('');
    try {
      await runTvCommand(TV_COMMANDS.POWER_ON);
    } catch (err) {
      setError(err.message);
    } finally {
      setWaking(false);
    }
  };

  /** Send typed text to whatever field the TV has focused. */
  const submitText = async (e) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    try {
      await run(async () => {
        await typeOnTv(value);
        await runTvCommand(TV_COMMANDS.KEYBOARD_ENTER);
      });
      setText('');
    } catch { /* the shared error line already says why */ }
  };

  const apps = TV_APPS.filter((a) => !a.id.startsWith('com.webos.app.hdmi')).slice(0, 6);

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-black/85 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="TV Remote"
    >
      {/* Header: what the link is doing, always visible. */}
      <div className="flex items-center gap-2 border-b border-cyan-400/20 px-3 py-2">
        <span className="hud-label">TV Remote</span>
        <span
          className={`text-[10px] ${
            ready ? 'text-emerald-300'
            : link.status === 'error' ? 'text-pink-300'
            : 'text-cyan-300/60'
          }`}
        >
          {waking ? 'TV ko jaga raha hoon…' : link.message || (ready ? 'Connected' : 'Not connected')}
        </span>
        <button type="button" onClick={onClose} className="hud-btn ml-auto px-2 py-1" aria-label="Close remote">
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {error && (
          <p className="rounded-md border border-pink-400/40 bg-pink-400/10 px-2 py-1.5 text-[10px] leading-snug text-pink-100">
            {error}
          </p>
        )}

        {/* Power. Separated from everything else because these two are the only
            keys that are hard to undo by pressing another key. */}
        <Row title="Power" cols={3}>
          <button
            type="button"
            onClick={wake}
            disabled={waking}
            className="hud-btn min-h-[44px] gap-1.5 disabled:opacity-40"
          >
            {waking ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            <span className="text-[10px]">On</span>
          </button>
          <Key onPress={() => send(TV_COMMANDS.POWER_OFF)} label="Power off" danger>
            <Power size={14} />
            <span className="text-[10px]">Off</span>
          </Key>
          <Key onPress={() => send(TV_COMMANDS.SCREEN_OFF)} label="Screen off, sound on">
            <MonitorOff size={14} />
            <span className="text-[10px]">Screen</span>
          </Key>
        </Row>

        {/* D-pad. The middle column carries the real navigation; the outer
            columns carry the two rockers, so a thumb reaches all three. */}
        <div className="grid grid-cols-3 gap-1.5">
          <div className="grid gap-1.5">
            <Key onPress={() => changeVolume(TV_COMMANDS.VOLUME_UP)} label="Volume up">
              <Volume2 size={15} />
            </Key>
            <Key
              onPress={() => changeVolume(volume?.muted ? TV_COMMANDS.UNMUTE : TV_COMMANDS.MUTE)}
              label={volume?.muted ? 'Unmute' : 'Mute'}
            >
              {volume?.muted ? <VolumeX size={15} /> : <Volume1 size={15} />}
            </Key>
            <Key onPress={() => changeVolume(TV_COMMANDS.VOLUME_DOWN)} label="Volume down">
              <Volume2 size={13} />
            </Key>
          </div>

          <div className="grid gap-1.5">
            <Key onPress={() => send(TV_COMMANDS.UP)} label="Up"><ArrowUp size={16} /></Key>
            <div className="grid grid-cols-3 gap-1.5">
              <Key onPress={() => send(TV_COMMANDS.LEFT)} label="Left"><ArrowLeft size={16} /></Key>
              <Key onPress={() => send(TV_COMMANDS.ENTER)} label="OK" className="font-semibold">OK</Key>
              <Key onPress={() => send(TV_COMMANDS.RIGHT)} label="Right"><ArrowRight size={16} /></Key>
            </div>
            <Key onPress={() => send(TV_COMMANDS.DOWN)} label="Down"><ArrowDown size={16} /></Key>
          </div>

          <div className="grid gap-1.5">
            <Key onPress={() => send(TV_COMMANDS.CHANNEL_UP)} label="Channel up"><ChevronUp size={15} /></Key>
            {/* A readout, not a key — it sits between the two channel arrows
                because that is the only spare cell, so it says what it is. */}
            <div className="hud-btn min-h-[44px] cursor-default text-[10px] tabular-nums">
              {volume?.level == null ? 'CH' : `VOL ${volume.level}`}
            </div>
            <Key onPress={() => send(TV_COMMANDS.CHANNEL_DOWN)} label="Channel down"><ChevronDown size={15} /></Key>
          </div>
        </div>

        <Row title="Navigate" cols={4}>
          <Key onPress={() => send(TV_COMMANDS.BACK)} label="Back"><RotateCcw size={14} /></Key>
          <Key onPress={() => send(TV_COMMANDS.HOME)} label="Home"><Home size={14} /></Key>
          <Key onPress={() => send(TV_COMMANDS.MENU)} label="Menu"><Menu size={14} /></Key>
          <Key onPress={() => send(TV_COMMANDS.EXIT)} label="Exit"><X size={14} /></Key>
        </Row>

        <Row title="Playback" cols={5}>
          <Key onPress={() => send(TV_COMMANDS.REWIND)} label="Rewind"><SkipBack size={14} /></Key>
          <Key onPress={() => send(TV_COMMANDS.PLAY)} label="Play"><Play size={14} /></Key>
          <Key onPress={() => send(TV_COMMANDS.PAUSE)} label="Pause"><Pause size={14} /></Key>
          <Key onPress={() => send(TV_COMMANDS.STOP)} label="Stop"><Square size={12} /></Key>
          <Key onPress={() => send(TV_COMMANDS.FORWARD)} label="Fast forward"><SkipForward size={14} /></Key>
        </Row>

        {/* Numbers, for channels people know by heart. */}
        <Row title="Channels" cols={5}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => (
            <Key key={d} onPress={() => send(TV_COMMANDS.PRESS_DIGIT, { digit: d })} label={`Digit ${d}`}>
              <span className="text-[13px] tabular-nums">{d}</span>
            </Key>
          ))}
          <Key onPress={() => send(TV_COMMANDS.GUIDE)} label="Guide"><List size={13} /></Key>
          <Key onPress={() => send(TV_COMMANDS.INFO)} label="Info"><Info size={13} /></Key>
          <Key onPress={() => send(TV_COMMANDS.DASH)} label="Dash / hyphen">–</Key>
          {COLOUR_BUTTONS.map((c) => (
            <Key key={c} onPress={() => run(() => pressColour(c))} label={`${c} key`}>
              <span
                className="h-3 w-3 rounded-full"
                style={{
                  background: { RED: '#f87171', GREEN: '#4ade80', YELLOW: '#facc15', BLUE: '#60a5fa' }[c],
                }}
              />
            </Key>
          ))}
        </Row>

        {/* Typing on the TV, which is otherwise a D-pad crawl across an
            on-screen keyboard. Only works while the TV has a field focused —
            said plainly rather than failing mysteriously. */}
        <form onSubmit={submitText} className="space-y-1.5">
          <p className="hud-label">Type on TV</p>
          <div className="flex gap-1.5">
            <input
              className="hud-input flex-1"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="TV ke search box me likhne ke liye…"
              autoComplete="off"
            />
            <button type="submit" className="hud-btn px-3" aria-label="Send text to TV">
              <Search size={13} />
            </button>
          </div>
          <p className="text-[9px] leading-tight text-cyan-300/30">
            Tab kaam karta hai jab TV pe koi text box khula ho — jaise YouTube ka search.
          </p>
        </form>

        <Row title="Apps" cols={3}>
          {apps.map((app) => (
            <Key
              key={app.id}
              onPress={() => send(TV_COMMANDS.LAUNCH_APP, { appId: app.id })}
              label={`Open ${app.names[0]}`}
            >
              <span className="truncate text-[10px] capitalize">{app.names[0]}</span>
            </Key>
          ))}
        </Row>

        {/* Only rendered once the TV has told us what is actually plugged in —
            a hard-coded HDMI 1-4 list would offer inputs that do not exist. */}
        {inputs.length > 0 && (
          <Row title="Inputs" cols={3}>
            {inputs.map((input) => (
              <Key
                key={input.id}
                onPress={() => send(TV_COMMANDS.SWITCH_INPUT, { inputId: input.id, label: input.label })}
                label={`Switch to ${input.label}`}
                className={input.connected ? '' : 'opacity-50'}
              >
                <span className="truncate text-[10px]">{input.label}</span>
              </Key>
            ))}
          </Row>
        )}

        <p className="pb-2 text-[9px] leading-tight text-cyan-300/30">
          <LayoutGrid size={9} className="mr-1 inline" />
          Arrow keys, OK aur digits TV ke alag "pointer" socket se jate hain —
          pehli baar dabane par thoda ruk sakta hai, wo socket khul raha hota hai.
          <CornerDownLeft size={9} className="mx-1 inline" />
        </p>
      </div>
    </div>
  );
}
