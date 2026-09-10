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
  POWER_ON: 'POWER_ON',
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
  EXIT: 'EXIT',
  MENU: 'MENU',
  INFO: 'INFO',
  GUIDE: 'GUIDE',
  DASH: 'DASH',
  PRESS_DIGIT: 'PRESS_DIGIT',
  // Content, rather than control: "wo gaana chala do" has to become a search
  // and then a deep link, which is a different shape from every command above.
  PLAY_VIDEO: 'PLAY_VIDEO',
  SET_CHANNEL: 'SET_CHANNEL',
  CLOSE_APP: 'CLOSE_APP',
  // Typing into whatever field the TV has focused, so a search box on the TV
  // can be filled from the phone's keyboard instead of a on-screen D-pad crawl.
  TYPE_TEXT: 'TYPE_TEXT',
  BACKSPACE: 'BACKSPACE',
  KEYBOARD_ENTER: 'KEYBOARD_ENTER',
  // Panel off, sound still on — what people actually want for a music video.
  SCREEN_OFF: 'SCREEN_OFF',
  SCREEN_ON: 'SCREEN_ON',
  SOUND_OUTPUT: 'SOUND_OUTPUT',
};

/**
 * Actions on the PHONE rather than the TV.
 *
 * Kept in the same matcher because the user does not think in categories —
 * "hotspot on karo" and "TV band karo" are the same kind of instruction to
 * them, and splitting the parsing would mean two places to keep in sync.
 */
export const DEVICE_COMMANDS = {
  OPEN_HOTSPOT: 'OPEN_HOTSPOT',
  OPEN_WIFI: 'OPEN_WIFI',
  OPEN_BLUETOOTH: 'OPEN_BLUETOOTH',
  OPEN_DATA: 'OPEN_DATA',
  OPEN_TTS: 'OPEN_TTS',
};

/* Phone actions are matched BEFORE the TV rules and do not require the word
   "TV" — nothing about "hotspot" is ambiguous. */
const DEVICE_RULES = [
  [/\b(hotspot|hot\s?spot|tether|tethering|hospot|hotspt)\b/i, DEVICE_COMMANDS.OPEN_HOTSPOT],
  [/\b(wifi|wi-?fi|vaifai)\b.*\b(setting|kholo|khol|on|chalu|band|off)\b/i, DEVICE_COMMANDS.OPEN_WIFI],
  [/\b(bluetooth|blutooth|bluetuth|bt)\b.*\b(setting|kholo|khol|on|chalu|band|off)\b/i, DEVICE_COMMANDS.OPEN_BLUETOOTH],
  [/\b(mobile\s?data|data)\b.*\b(setting|kholo|khol|on|chalu|band|off)\b/i, DEVICE_COMMANDS.OPEN_DATA],
  [/\b(voice|tts|awaz)\b.*\bsetting/i, DEVICE_COMMANDS.OPEN_TTS],
];

/**
 * Parse a phone-side action. Separate from `parseTvCommand` so a caller can
 * enable one without the other.
 */
export function parseDeviceCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  for (const [pattern, command] of DEVICE_RULES) {
    const m = raw.match(pattern);
    if (m) return { command, args: {}, matched: m[0].trim() };
  }
  return null;
}

/** What ALOO says after opening a settings screen. */
export function describeDeviceCommand(command) {
  switch (command) {
    // Deliberately does NOT claim the hotspot is on — the app cannot switch it,
    // only open the page. Saying otherwise would be a lie the user catches in
    // two seconds.
    case DEVICE_COMMANDS.OPEN_HOTSPOT:
      return 'Hotspot ka page khol diya — bas switch daba do. Android app ko khud on karne nahi deta.';
    case DEVICE_COMMANDS.OPEN_WIFI: return 'Wi-Fi settings khol diya.';
    case DEVICE_COMMANDS.OPEN_BLUETOOTH: return 'Bluetooth settings khol diya.';
    case DEVICE_COMMANDS.OPEN_DATA: return 'Mobile data settings khol diya.';
    case DEVICE_COMMANDS.OPEN_TTS: return 'Voice settings khol diya.';
    default: return 'Khol diya.';
  }
}

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
  /* --- sound BEFORE power ---------------------------------------------------
     Deliberate: "TV ki awaz band karo" contains "band", and a power rule placed
     first would switch the whole television off when the user asked for
     silence. Sound words are checked first so they win their own sentence. */
  [
    /\b(volume|awaz|awaaz|aawaz|sound|vol)\b.*?\b(\d{1,3})\b/i,
    TV_COMMANDS.SET_VOLUME,
    (m) => ({ level: Math.max(0, Math.min(100, Number(m[2]))) }),
  ],
  [/\b(mute|chup|silent|awaz\s?band|awaz\s?bandh|sound\s?off)\b/i, TV_COMMANDS.MUTE],
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

  /* --- screen, which is not power -------------------------------------------
     Panel dark, sound still playing. Checked before the power rules because
     "screen band karo" also contains "band". */
  [
    /\b(screen|display|panel|scrin)\b.*?\b(off|band|bandh|bujha|bujhao)\b|\b(band|bandh|off)\b.*?\b(screen|display|panel)\b/i,
    TV_COMMANDS.SCREEN_OFF,
  ],
  [/\b(screen|display|panel|scrin)\b.*?\b(on|chalu|wapas)\b/i, TV_COMMANDS.SCREEN_ON],

  // --- power ---
  [/\b(on|onn|chalu|chaalu|start|jaga|jagao|jagado|wake|uth)\b/i, TV_COMMANDS.POWER_ON],
  [/\b(band|bandh|bund|off|switch\s?off|turn\s?off|shut\s?down|so\s?ja|sula)\b/i, TV_COMMANDS.POWER_OFF],

  // --- channels ---
  [
    /\bchannel\b.*?\b(\d{1,4})\b|\b(\d{1,4})\b.*?\bchannel\b/i,
    TV_COMMANDS.SET_CHANNEL,
    (m) => ({ channel: Number(m[1] ?? m[2]) }),
  ],
  [/\b(next|agla|aage)\b.*?\b(channel)\b|\bchannel\b.*?\b(up|next|agla|badha)\b/i, TV_COMMANDS.CHANNEL_UP],
  [/\b(pichla|previous|piche)\b.*?\b(channel)\b|\bchannel\b.*?\b(down|pichla|previous|kam)\b/i, TV_COMMANDS.CHANNEL_DOWN],

  // --- typing on the TV's own keyboard ---
  [
    /\b(likho|likh\s?do|type\s?karo|type)\b\s*[:-]?\s*(.+)$/i,
    TV_COMMANDS.TYPE_TEXT,
    (m) => ({ text: m[2].trim() }),
  ],

  // --- playback ---
  [/\b(pause|rok|ruk|thehr|thahr)\b/i, TV_COMMANDS.PAUSE],
  [/\b(resume|play|chala|chalao|shuru)\b/i, TV_COMMANDS.PLAY],
  [/\b(stop|bandh\s?karo\s?video)\b/i, TV_COMMANDS.STOP],
  [/\b(rewind|peeche|piche|wapas)\b/i, TV_COMMANDS.REWIND],
  [/\b(forward|aage\s?badha|fast\s?forward|skip)\b/i, TV_COMMANDS.FORWARD],

  // --- navigation ---
  [/\b(home|mukhya|main\s?screen)\b/i, TV_COMMANDS.HOME],
  [/\b(exit|nikal|nikal\s?jao|close)\b/i, TV_COMMANDS.EXIT],
  [/\b(menu|setting|settings)\b/i, TV_COMMANDS.MENU],
  [/\b(guide|epg|programme|program\s?guide)\b/i, TV_COMMANDS.GUIDE],
  [/\b(info|jankari|jaankari|detail)\b/i, TV_COMMANDS.INFO],
  [/\b(back|wapas\s?ja|peeche\s?ja)\b/i, TV_COMMANDS.BACK],
  [/\b(ok|enter|select|chuno|dabao)\b/i, TV_COMMANDS.ENTER],
  [/\b(up|upar|uper)\b/i, TV_COMMANDS.UP],
  [/\b(down|niche|neeche)\b/i, TV_COMMANDS.DOWN],
  [/\b(left|baye|bayen|baaye)\b/i, TV_COMMANDS.LEFT],
  [/\b(right|daye|dayen|daaye)\b/i, TV_COMMANDS.RIGHT],
];

/* -------------------------------------------------------------------------- */
/* "Wo gaana chala do" — playing something by name                             */
/* -------------------------------------------------------------------------- */

/** Verbs that mean "start this", as opposed to controlling something running. */
const PLAY_VERB = /\b(chala|chalao|chlao|play|bajao|baja|laga|lagao|dikha|dikhao|put\s?on)\b/i;

/** Words saying the thing being asked for is a piece of content, not a device. */
const MEDIA_NOUN = /\b(gaana|gana|gane|song|songs|geet|video|videos|movie|film|picture|episode|trailer|series)\b/i;

const YOUTUBE_WORD = /\b(youtube|you\s?tube|yt|यूट्यूब)\b/i;

/**
 * Words that make a sentence about the TV's own controls rather than about
 * content. "TV pe channel 501 lagao" uses the same verb as "gaana laga do", so
 * without this the channel number is treated as a song title and searched for.
 */
const DEVICE_NOUN = /\b(channel|volume|awaz|awaaz|sound|vol|input|source|hdmi|screen|display|panel|mute)\b/i;

/** A pasted link is unambiguous — no search needed, no guessing. */
const VIDEO_URL = /(https?:\/\/)?(www\.)?(youtube\.com\/\S+|youtu\.be\/\S+)/i;

/**
 * Filler that carries no meaning for a search. Stripped so "TV pe zara Shape of
 * You chala do na bro" becomes "Shape of You" rather than a query that finds
 * nothing.
 */
const FILLER = new RegExp(
  '\\b(' + [
    'tv', 'television', 'youtube', 'you tube', 'yt',
    'pe', 'par', 'pr', 'pai', 'me', 'mein', 'main', 'ma', 'ko', 'ka', 'ki', 'ke',
    'do', 'de', 'dijiye', 'dena', 'dedo', 'na', 'naa', 'yaar', 'yar', 'bro', 'bhai',
    'please', 'plz', 'zara', 'zra', 'ek', 'koi', 'kuch', 'wala', 'wali', 'abhi',
    'aloo', 'karo', 'kar', 'to', 'tho', 'wo', 'woh', 'vo', 'jo', 'that', 'the',
  ].join('|') + ')\\b',
  'gi'
);

/**
 * Decide whether this is "play <something>" and, if so, what the something is.
 *
 * Written as a strip-down rather than a capture group because word order in
 * Hinglish is not fixed: "TV pe X chala do", "X chala do TV pe" and "chala do X"
 * are all the same request, and a positional regex only ever catches one of the
 * three.
 */
function matchPlay(raw) {
  const link = raw.match(VIDEO_URL);
  if (link && PLAY_VERB.test(raw)) return { query: link[0], isLink: true };

  if (!PLAY_VERB.test(raw)) return null;
  // A control word means this is an instruction to the set, not a request for
  // something to watch.
  if (DEVICE_NOUN.test(raw)) return null;
  // Something has to say this is about the television or about content —
  // otherwise a bare "chala do" would reach for the TV mid-conversation.
  if (!TV_WORD.test(raw) && !YOUTUBE_WORD.test(raw) && !MEDIA_NOUN.test(raw)) return null;

  // A named app with nothing else is a launch, not a search: "Netflix chalao"
  // means open Netflix, and there is no title in it to look for.
  const named = matchApp(raw);
  if (named && !YOUTUBE_WORD.test(raw)) return null;

  const query = raw
    .replace(PLAY_VERB, ' ')
    .replace(MEDIA_NOUN, ' ')
    .replace(FILLER, ' ')
    .replace(/[?!.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Nothing left to search for — "YouTube chala do" is a launch after all.
  if (query.length < 2 || !/[a-zऀ-ॿ]/i.test(query)) return null;
  return { query, isLink: false };
}


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

  // "TV pe Shape of You chala do" has to be caught BEFORE the app matcher,
  // which would otherwise see the word "YouTube", open it, and drop the title
  // on the floor.
  const play = matchPlay(raw);
  if (play) {
    return { command: TV_COMMANDS.PLAY_VIDEO, args: { query: play.query }, matched: play.query };
  }

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
    case TV_COMMANDS.POWER_ON: return 'TV on ho gaya.';
    case TV_COMMANDS.PLAY_VIDEO:
      return args.title ? `Chala diya — ${args.title}` : 'Chala diya.';
    case TV_COMMANDS.SET_CHANNEL: return `Channel ${args.channel} laga diya.`;
    case TV_COMMANDS.SWITCH_INPUT: return `${args.label || 'Input'} pe aa gaye.`;
    case TV_COMMANDS.TYPE_TEXT: return `TV pe likh diya: ${args.text}`;
    case TV_COMMANDS.SCREEN_OFF: return 'Screen band kar diya — awaz chalti rahegi.';
    case TV_COMMANDS.SCREEN_ON: return 'Screen wapas on.';
    case TV_COMMANDS.EXIT: return 'Bahar aa gaye.';
    case TV_COMMANDS.MENU: return 'Menu khol diya.';
    case TV_COMMANDS.GUIDE: return 'Guide khol diya.';
    case TV_COMMANDS.INFO: return 'Info dikha diya.';
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
