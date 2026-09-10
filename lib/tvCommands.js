/**
 * ALOO — TV command vocabulary and intent parsing.
 * ===========================================================================
 * Two jobs, kept apart from any protocol:
 *
 *   1. A brand-neutral COMMAND set. "Turn the volume up" is the same intent
 *      whether it ends up as an LG SSAP call, a Roku HTTP GET, or an infrared
 *      blink. Keeping the vocabulary here means adding a second TV brand later
 *      is a new transport, not a new language.
 *
 *   2. Turning what the user actually SAID into one of those commands.
 *
 * WHY A MATCHER AND NOT THE LLM
 * The model could classify these, but it should not have to. "TV band karo" is
 * unambiguous, and routing it through a network round-trip makes a light switch
 * feel like a search engine — a second of latency on "volume up" is the
 * difference between a remote and a chore. Anything this file does not
 * recognise falls through to the model untouched, so nothing is lost.
 *
 * HINGLISH IS THE PRIMARY INPUT, not an afterthought: the user speaks it, the
 * recogniser is set to en-IN, and it transcribes Hindi words in Latin script
 * with wildly inconsistent spelling. So the patterns match loosely — "band",
 * "bandh", "bund" all have to work, because all three come out of the mic.
 */

/** Every action ALOO can ask a television to perform. */
export const TV_COMMANDS = {
  POWER_OFF: 'POWER_OFF',
  VOLUME_UP: 'VOLUME_UP',
  VOLUME_DOWN: 'VOLUME_DOWN',
  SET_VOLUME: 'SET_VOLUME',
  MUTE: 'MUTE',
  UNMUTE: 'UNMUTE',
  CHANNEL_UP: 'CHANNEL_UP',
  CHANNEL_DOWN: 'CHANNEL_DOWN',
  PLAY: 'PLAY',
  PAUSE: 'PAUSE',
  STOP: 'STOP',
  REWIND: 'REWIND',
  FORWARD: 'FORWARD',
  LAUNCH_APP: 'LAUNCH_APP',
  SWITCH_INPUT: 'SWITCH_INPUT',
  OPEN_URL: 'OPEN_URL',
  TOAST: 'TOAST',
  // Navigation, for driving a menu by voice.
  UP: 'UP',
  DOWN: 'DOWN',
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  ENTER: 'ENTER',
  BACK: 'BACK',
  HOME: 'HOME',
};

/**
 * App aliases -> webOS launch ids.
 *
 * The ids are LG's, so this table moves to the transport if a second brand
 * arrives; the ALIASES beside them are the part worth keeping either way,
 * because "yt", "you tube" and "यूट्यूब" all mean the same thing to a person.
 */
export const TV_APPS = [
  { id: 'netflix', names: ['netflix', 'net flix'] },
  { id: 'youtube.leanback.v4', names: ['youtube', 'you tube', 'yt', 'यूट्यूब'] },
  { id: 'amazon', names: ['prime', 'prime video', 'amazon', 'amazon prime'] },
  { id: 'com.disney.disneyplus-prod', names: ['disney', 'disney plus', 'hotstar', 'disney+'] },
  { id: 'com.webos.app.livetv', names: ['live tv', 'tv channel', 'channels', 'cable'] },
  { id: 'com.webos.app.hdmi1', names: ['hdmi 1', 'hdmi1', 'hdmi one'] },
  { id: 'com.webos.app.hdmi2', names: ['hdmi 2', 'hdmi2', 'hdmi two'] },
  { id: 'com.webos.app.hdmi3', names: ['hdmi 3', 'hdmi3', 'hdmi three'] },
  { id: 'spotify-beehive', names: ['spotify'] },
  { id: 'com.webos.app.browser', names: ['browser', 'internet', 'web'] },
];

/**
 * Hinglish + English spellings that mean "television".
 * A command only counts as a TV command if one of these is present — otherwise
 * "volume up" while music is playing would blindly hit the TV.
 */
const TV_WORD = /\b(tv|t\.?v\.?|tele\s?vision|टीवी|टी\.?वी)\b/i;

/* Loose spellings, because this text arrives from a speech recogniser.
   Each entry is [pattern, command, optional argument extractor]. Order
   matters: the first match wins, so specific patterns come before general. */
const RULES = [
  // --- power ---
  [/\b(band|bandh|bund|bandh?\s?kar|off|switch\s?off|turn\s?off|shut\s?down|so\s?ja)\b/i, TV_COMMANDS.POWER_OFF],

  // --- volume, with an explicit number ---
  [
    /\b(volume|awaz|awaaz|aawaz|sound|vol)\b.*?\b(\d{1,3})\b/i,
    TV_COMMANDS.SET_VOLUME,
    (m) => ({ level: Math.max(0, Math.min(100, Number(m[2]))) }),
  ],
  [/\b(mute|chup|silent|awaz\s?band|sound\s?off)\b/i, TV_COMMANDS.MUTE],
  [/\b(unmute|awaz\s?(on|chalu|wapas)|sound\s?on)\b/i, TV_COMMANDS.UNMUTE],
  [
    /\b(volume|awaz|awaaz|aawaz|sound|vol)\b.*?\b(up|badha|badhao|bada|tez|zyada|increase|raise|high)\b/i,
    TV_COMMANDS.VOLUME_UP,
  ],
  [
    /\b(volume|awaz|awaaz|aawaz|sound|vol)\b.*?\b(down|kam|ghata|ghatao|dhime|halka|decrease|lower|low)\b/i,
    TV_COMMANDS.VOLUME_DOWN,
  ],
  // The reverse word order people also use: "awaz badhao" handled above,
  // "badhao awaz" here.
  [/\b(badha|badhao|tez\s?kar|increase)\b.*?\b(volume|awaz|awaaz|sound)\b/i, TV_COMMANDS.VOLUME_UP],
  [/\b(kam\s?kar|ghata|ghatao|dhima|decrease)\b.*?\b(volume|awaz|awaaz|sound)\b/i, TV_COMMANDS.VOLUME_DOWN],

  // --- channels ---
  [/\b(next|agla|aage)\b.*?\b(channel)\b|\bchannel\b.*?\b(up|next|agla|badha)\b/i, TV_COMMANDS.CHANNEL_UP],
  [/\b(pichla|previous|piche)\b.*?\b(channel)\b|\bchannel\b.*?\b(down|pichla|previous|kam)\b/i, TV_COMMANDS.CHANNEL_DOWN],

  // --- playback ---
  [/\b(pause|rok|ruk|thehr|thahr)\b/i, TV_COMMANDS.PAUSE],
  [/\b(resume|play|chala|chalao|shuru)\b/i, TV_COMMANDS.PLAY],
  [/\b(stop|bandh\s?karo\s?video)\b/i, TV_COMMANDS.STOP],
  [/\b(rewind|peeche|piche|wapas)\b/i, TV_COMMANDS.REWIND],
  [/\b(forward|aage\s?badha|fast\s?forward|skip)\b/i, TV_COMMANDS.FORWARD],

  // --- navigation ---
  [/\b(home|mukhya|main\s?screen)\b/i, TV_COMMANDS.HOME],
  [/\b(back|wapas\s?ja|peeche\s?ja)\b/i, TV_COMMANDS.BACK],
  [/\b(ok|enter|select|chuno|dabao)\b/i, TV_COMMANDS.ENTER],
  [/\b(up|upar|uper)\b/i, TV_COMMANDS.UP],
  [/\b(down|niche|neeche)\b/i, TV_COMMANDS.DOWN],
  [/\b(left|baye|bayen|baaye)\b/i, TV_COMMANDS.LEFT],
  [/\b(right|daye|dayen|daaye)\b/i, TV_COMMANDS.RIGHT],
];

/**
 * Parse a spoken or typed line into a TV command.
 *
 * @param {string} text
 * @returns {{command:string, args:Object, matched:string}|null}
 *   null when this is not a TV instruction at all — the caller should then
 *   treat the text as ordinary conversation.
 */
export function parseTvCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // Launching an app names the app, so it does not need the word "TV" —
  // "Netflix chalao" is unambiguous on its own.
  const app = matchApp(raw);
  if (app) return { command: TV_COMMANDS.LAUNCH_APP, args: { appId: app.id, name: app.names[0] }, matched: app.names[0] };

  // Everything else does. Without this, "volume up" would reach for the TV
  // while the user is talking about the phone's own playback.
  if (!TV_WORD.test(raw)) return null;

  for (const [pattern, command, extract] of RULES) {
    const m = raw.match(pattern);
    if (m) return { command, args: extract ? extract(m) : {}, matched: m[0].trim() };
  }

  return null;
}

/** Find an app named anywhere in the text, longest alias first. */
function matchApp(text) {
  const lower = text.toLowerCase();
  // "chalao / kholo / laga / open / launch / play" — an intent to start something.
  if (!/\b(chala|chalao|kholo|khol|laga|lagao|open|launch|start|play|dikha|dikhao|put\s?on)\b/i.test(lower)) {
    return null;
  }
  let best = null;
  for (const app of TV_APPS) {
    for (const name of app.names) {
      if (lower.includes(name) && (!best || name.length > best.name.length)) {
        best = { ...app, name };
      }
    }
  }
  return best;
}

/** A short, speakable confirmation for a command that succeeded. */
export function describeTvCommand(command, args = {}) {
  switch (command) {
    case TV_COMMANDS.POWER_OFF: return 'TV band kar diya.';
    case TV_COMMANDS.VOLUME_UP: return 'Volume badha diya.';
    case TV_COMMANDS.VOLUME_DOWN: return 'Volume kam kar diya.';
    case TV_COMMANDS.SET_VOLUME: return `Volume ${args.level} kar diya.`;
    case TV_COMMANDS.MUTE: return 'Mute kar diya.';
    case TV_COMMANDS.UNMUTE: return 'Awaz wapas aa gayi.';
    case TV_COMMANDS.CHANNEL_UP: return 'Agla channel.';
    case TV_COMMANDS.CHANNEL_DOWN: return 'Pichla channel.';
    case TV_COMMANDS.PLAY: return 'Chala diya.';
    case TV_COMMANDS.PAUSE: return 'Rok diya.';
    case TV_COMMANDS.STOP: return 'Band kar diya.';
    case TV_COMMANDS.REWIND: return 'Peeche kar raha hoon.';
    case TV_COMMANDS.FORWARD: return 'Aage badha raha hoon.';
    case TV_COMMANDS.LAUNCH_APP: return `${args.name || 'App'} khol diya.`;
    case TV_COMMANDS.HOME: return 'Home par aa gaye.';
    case TV_COMMANDS.BACK: return 'Wapas.';
    default: return 'Ho gaya.';
  }
}
