/**
 * ALOO — LG webOS TV control (SSAP over WebSocket).
 * ===========================================================================
 * HOW AN LG TV IS ACTUALLY CONTROLLED
 * Not over Bluetooth — a TV's Bluetooth is for sending audio OUT to a speaker
 * and for accepting a paired remote IN, neither of which a phone app can use as
 * a control channel. LG's real interface is SSAP: a plain WebSocket on port
 * 3000 that speaks JSON, on the same Wi-Fi.
 *
 * THE HANDSHAKE, which is the part with all the sharp edges:
 *
 *   1. Connect to ws://<tv>:3000
 *   2. Send a `register` message carrying a manifest of permissions, plus a
 *      stored `client-key` if we have one.
 *   3. FIRST TIME ONLY: the TV shows a prompt on screen and waits for the user
 *      to accept with the physical remote. Nothing happens until they do — a
 *      pairing attempt that seems to hang is almost always a prompt nobody
 *      looked at, so this client says so instead of just timing out.
 *   4. The TV replies `registered` with a `client-key`. Stored, it makes every
 *      future connection silent.
 *
 * After that, commands are `{type:'request', id, uri:'ssap://…', payload}` and
 * the TV answers with the same id.
 *
 * WHAT THIS CANNOT DO, and why:
 *
 *   • POWER ON. The TV's WebSocket server is off when the TV is off — there is
 *     nothing to connect to. Waking it needs a Wake-on-LAN magic packet, which
 *     is UDP, and a WebView has no UDP. Power OFF works.
 *
 *   • ARROW KEYS travel on a second socket the TV hands out on request (see
 *     `openPointerInput`), not on the main one.
 *
 * WHY THE SOCKET IS NOT `new WebSocket(...)`
 * The TV only offers cleartext `ws://`, and inside the APK the page is served
 * from `https://localhost`, where Chromium forbids cleartext sockets outright.
 * `createSocket` returns a native-backed socket there and the ordinary browser
 * one on the web; see lib/nativeSocket.js for the full account.
 */

import { getSettings, setSettings } from '@/lib/settingsStore';
import { TV_COMMANDS } from '@/lib/tvCommands';
import { createSocket, cleartextBlockReason } from '@/lib/nativeSocket';

/**
 * The registration manifest.
 *
 * This is the well-known handshake every open-source LG remote uses; the
 * signature is LG's own test-signing certificate, which webOS accepts. It is
 * reproduced verbatim on purpose — the TV validates it, so a "tidier" version
 * with permissions removed is rejected outright.
 */
const REGISTER_MANIFEST = {
  forcePairing: false,
  pairingType: 'PROMPT',
  manifest: {
    manifestVersion: 1,
    appVersion: '1.1',
    signed: {
      created: '20140509',
      appId: 'com.lge.test',
      vendorId: 'com.lge',
      localizedAppNames: {
        '': 'LG Remote App',
        'ko-KR': 'LG 리모컨 앱',
      },
      localizedVendorNames: { '': 'LG Electronics' },
      permissions: [
        'TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD',
        'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS', 'SEARCH',
        'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER',
        'READ_CURRENT_CHANNEL', 'READ_RUNNING_APPS', 'READ_UPDATE_INFO',
        'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME',
      ],
      serial: '2f930e2d2cfe083771f68e4fe7bb07',
    },
    permissions: [
      'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED',
      'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
      'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK',
      'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL',
      'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS',
      'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE',
      'READ_COUNTRY_INFO',
    ],
    signatures: [
      {
        signatureVersion: 1,
        signature:
          'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==',
      },
    ],
  },
};

/** ssap:// endpoint for each brand-neutral command. */
const URIS = {
  [TV_COMMANDS.POWER_OFF]: 'ssap://system/turnOff',
  [TV_COMMANDS.VOLUME_UP]: 'ssap://audio/volumeUp',
  [TV_COMMANDS.VOLUME_DOWN]: 'ssap://audio/volumeDown',
  [TV_COMMANDS.SET_VOLUME]: 'ssap://audio/setVolume',
  [TV_COMMANDS.MUTE]: 'ssap://audio/setMute',
  [TV_COMMANDS.UNMUTE]: 'ssap://audio/setMute',
  [TV_COMMANDS.CHANNEL_UP]: 'ssap://tv/channelUp',
  [TV_COMMANDS.CHANNEL_DOWN]: 'ssap://tv/channelDown',
  [TV_COMMANDS.PLAY]: 'ssap://media.controls/play',
  [TV_COMMANDS.PAUSE]: 'ssap://media.controls/pause',
  [TV_COMMANDS.STOP]: 'ssap://media.controls/stop',
  [TV_COMMANDS.REWIND]: 'ssap://media.controls/rewind',
  [TV_COMMANDS.FORWARD]: 'ssap://media.controls/fastForward',
  [TV_COMMANDS.LAUNCH_APP]: 'ssap://system.launcher/launch',
  [TV_COMMANDS.OPEN_URL]: 'ssap://system.launcher/open',
  [TV_COMMANDS.TOAST]: 'ssap://system.notifications/createToast',
};

/** Commands the main socket cannot send — these ride the pointer socket. */
const BUTTONS = {
  [TV_COMMANDS.UP]: 'UP',
  [TV_COMMANDS.DOWN]: 'DOWN',
  [TV_COMMANDS.LEFT]: 'LEFT',
  [TV_COMMANDS.RIGHT]: 'RIGHT',
  [TV_COMMANDS.ENTER]: 'ENTER',
  [TV_COMMANDS.BACK]: 'BACK',
  [TV_COMMANDS.HOME]: 'HOME',
};

/* -------------------------------------------------------------------------- */
/* Connection state                                                            */
/* -------------------------------------------------------------------------- */

let socket = null;
let pointerSocket = null;
let registered = false;
let nextId = 1;
const pending = new Map(); // request id -> { resolve, reject, timer }
const listeners = new Set();

/** Subscribe to link-state changes: 'idle' | 'connecting' | 'pairing' | 'ready' | 'error'. */
export function subscribeTv(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let state = { status: 'idle', message: '' };
function setState(status, message = '') {
  state = { status, message };
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      console.error('[ALOO/tv] listener threw:', err);
    }
  });
}

export function getTvState() {
  return state;
}

export function isTvConnected() {
  return registered && socket?.readyState === 1;
}

/* -------------------------------------------------------------------------- */
/* Connect + pair                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One connection attempt against one endpoint. Resolves when the TV has
 * accepted our registration.
 *
 * Failures are tagged `transport` when the socket itself never got anywhere —
 * that is the only kind worth retrying on the other port. A TV that answered
 * and then refused the pairing, or one that is waiting on a prompt nobody
 * pressed, will behave identically on every port, so those are final.
 */
function openLink({ url, insecure, host, label, timeoutMs }) {
  const s = getSettings();

  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = createSocket(url, { insecure });
    } catch (err) {
      const fail = new Error(`Could not open a connection to ${host}: ${err.message}`);
      fail.transport = true;
      return reject(fail);
    }
    socket = ws;

    // The prompt has no event of its own — the TV simply goes quiet until the
    // user presses OK. So the timeout is generous and its message says why.
    const timer = setTimeout(() => {
      setState('error', 'Pairing timed out');
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error(
        'The TV did not answer. If a prompt is showing on screen, accept it with the TV remote and try again.'
      ));
    }, timeoutMs);

    const settle = (fn, arg) => {
      clearTimeout(timer);
      fn(arg);
    };

    ws.onopen = () => {
      const payload = { ...REGISTER_MANIFEST };
      if (s.tvClientKey) payload['client-key'] = s.tvClientKey;
      send({ type: 'register', id: `register_${nextId++}`, payload });
      setState(
        s.tvClientKey ? 'connecting' : 'pairing',
        s.tvClientKey ? 'Registering…' : 'Accept the prompt on your TV screen'
      );
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // webOS never sends non-JSON; ignore anything that is not
      }

      // Registration is its own little state machine, separate from requests.
      if (msg.type === 'registered' || msg.payload?.['client-key']) {
        const key = msg.payload?.['client-key'];
        // Persisting the key is what makes every later launch silent — without
        // it the TV re-prompts on every single connection.
        if (key && key !== s.tvClientKey) setSettings({ tvClientKey: key });
        registered = true;
        setState('ready', 'Connected');
        return settle(resolve);
      }
      if (msg.type === 'response' && msg.payload?.pairingType === 'PROMPT') {
        setState('pairing', 'Accept the prompt on your TV screen');
        return;
      }
      if (msg.type === 'error' && !registered) {
        const detail = msg.error || 'registration rejected';
        setState('error', detail);
        try { ws.close(); } catch { /* already closed */ }
        return settle(reject, new Error(`The TV refused the pairing: ${detail}`));
      }

      // Ordinary command replies.
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.type === 'error') waiter.reject(new Error(msg.error || 'TV rejected the command'));
        else waiter.resolve(msg.payload || {});
      }
    };

    // A browser's error event carries no detail by design; the native socket
    // does, and it is far more useful ("refused on port 3000" vs. "no route to
    // host" are different problems), so prefer it whenever it is there.
    const explain = (detail) => detail
      || `Could not reach ${host} on ${label}. Check the TV is on, on the same Wi-Fi, that `
      + 'the address is right, and that Settings → Network → LG Connect Apps is on.';

    const failed = (detail) => {
      const err = new Error(detail);
      err.transport = true;
      return err;
    };

    ws.onerror = (event) => {
      const detail = explain(event?.message);
      setState('error', detail);
      if (!registered) settle(reject, failed(detail));
    };

    ws.onclose = (event) => {
      const wasRegistered = registered;
      registered = false;
      if (socket === ws) socket = null;
      if (state.status === 'ready') setState('idle', 'Disconnected');
      // Closing before registration means the attempt failed. Without this the
      // caller would sit on the 60s pairing timeout for something already known
      // to be over.
      if (!wasRegistered) {
        const detail = explain(event?.reason);
        setState('error', detail);
        settle(reject, failed(detail));
      }
    };
  });
}

/**
 * The two places an LG TV might be listening.
 *
 * Older sets answer plain `ws://` on 3000. webOS 6 and later closed that and
 * moved to `wss://` on 3001, presenting a self-signed certificate — which is
 * why the secure attempt has to opt out of validation (see TvSocketPlugin).
 * Which one a given TV uses is not something the TV advertises, so both are
 * tried and the winner is remembered.
 */
function endpoints(host) {
  const secureFirst = !!getSettings().tvSecurePort;
  const list = [
    { url: `ws://${host}:3000`, insecure: false, label: 'port 3000' },
    { url: `wss://${host}:3001`, insecure: true, label: 'port 3001' },
  ];
  if (secureFirst) list.reverse();
  // Drop whatever this platform cannot even attempt — in a browser tab served
  // over https, the cleartext one is refused before a packet leaves.
  return list.filter((e) => !cleartextBlockReason(e.url)).map((e) => ({ ...e, host }));
}

/**
 * Open the link and register. Resolves once the TV has accepted us.
 *
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs] how long to wait for the on-screen prompt
 */
export async function connectTv({ timeoutMs = 60000 } = {}) {
  const host = (getSettings().tvHost || '').trim();
  if (!host) throw new Error('No TV address set. Add it in Settings → TV Control.');
  if (isTvConnected()) return;
  disconnectTv();

  setState('connecting', `Connecting to ${host}…`);

  const tries = endpoints(host);
  if (!tries.length) {
    // Only reachable in a browser tab on an https origin: every route the TV
    // offers is one the page is not allowed to take.
    const why = cleartextBlockReason(`ws://${host}:3000`);
    setState('error', 'Not available in the browser');
    throw new Error(why);
  }

  let last;
  for (const endpoint of tries) {
    try {
      await openLink({ ...endpoint, timeoutMs });
      // Remember which port answered, so the next launch does not spend six
      // seconds finding out again.
      if (!!getSettings().tvSecurePort !== endpoint.insecure) {
        setSettings({ tvSecurePort: endpoint.insecure });
      }
      return;
    } catch (err) {
      last = err;
      // A TV that talked to us and then said no will say no on the other port
      // too; only a dead socket is worth retrying elsewhere.
      if (!err.transport) throw err;
      disconnectTv();
    }
  }
  throw last;
}

export function disconnectTv() {
  registered = false;
  for (const [, w] of pending) {
    clearTimeout(w.timer);
    w.reject(new Error('Connection closed'));
  }
  pending.clear();
  if (socket) {
    try { socket.close(); } catch { /* already closed */ }
    socket = null;
  }
  if (pointerSocket) {
    try { pointerSocket.close(); } catch { /* already closed */ }
    pointerSocket = null;
  }
}

function send(obj) {
  if (!socket || socket.readyState !== 1) throw new Error('Not connected to the TV');
  socket.send(JSON.stringify(obj));
}

/** One SSAP request/response round trip. */
function request(uri, payload = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id = `req_${nextId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The TV did not answer ${uri}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      send({ type: 'request', id, uri, payload });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* The pointer/remote socket                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Arrow keys, OK, BACK and HOME are not SSAP requests — the TV hands out a
 * SECOND socket for them, and it speaks a small line-based protocol rather than
 * JSON. Opened lazily, because most sessions never press a direction key.
 */
async function openPointerInput() {
  if (pointerSocket?.readyState === 1) return pointerSocket;
  const res = await request('ssap://com.webos.service.networkinput/getPointerInputSocket');
  const path = res?.socketPath;
  if (!path) throw new Error('The TV did not provide a remote-input socket');

  return new Promise((resolve, reject) => {
    let ws;
    try {
      // On a TV reached over 3001 this path comes back as wss://, carrying the
      // same self-signed certificate the control socket already accepted.
      ws = createSocket(path, { insecure: /^wss:/i.test(path) });
    } catch (err) {
      return reject(new Error(`Remote-input socket failed: ${err.message}`));
    }
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error('Remote-input socket did not open'));
    }, 8000);
    ws.onopen = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pointerSocket = ws;
      resolve(ws);
    };
    ws.onerror = (event) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(event?.message || 'Remote-input socket failed'));
    };
    ws.onclose = () => {
      if (pointerSocket === ws) pointerSocket = null;
    };
  });
}

async function pressButton(name) {
  const ws = await openPointerInput();
  // Line-based, terminated by a blank line — not JSON, unlike everything else.
  ws.send(`type:button\nname:${name}\n\n`);
}

/* -------------------------------------------------------------------------- */
/* Public command surface                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Execute one brand-neutral command from lib/tvCommands.
 * Connects (and pairs) first if needed.
 *
 * @param {string} command  a TV_COMMANDS value
 * @param {Object} args     e.g. { level }, { appId }, { url }, { message }
 */
export async function runTvCommand(command, args = {}) {
  if (!isTvConnected()) await connectTv();

  if (BUTTONS[command]) return pressButton(BUTTONS[command]);

  const uri = URIS[command];
  if (!uri) throw new Error(`Unsupported TV command: ${command}`);

  switch (command) {
    case TV_COMMANDS.SET_VOLUME:
      return request(uri, { volume: Number(args.level) || 0 });
    case TV_COMMANDS.MUTE:
      return request(uri, { mute: true });
    case TV_COMMANDS.UNMUTE:
      return request(uri, { mute: false });
    case TV_COMMANDS.LAUNCH_APP:
      return request(uri, { id: args.appId });
    case TV_COMMANDS.OPEN_URL:
      return request(uri, { target: args.url });
    case TV_COMMANDS.TOAST:
      return request(uri, { message: args.message || 'ALOO' });
    default:
      return request(uri);
  }
}

/** Current volume and mute state, for the HUD. */
export async function getTvVolume() {
  if (!isTvConnected()) await connectTv();
  return request('ssap://audio/getVolume');
}

/** Everything installed on the TV — used to offer real app names in settings. */
export async function listTvApps() {
  if (!isTvConnected()) await connectTv();
  const res = await request('ssap://com.webos.applicationManager/listLaunchPoints');
  return (res?.launchPoints || []).map((p) => ({ id: p.id, title: p.title }));
}
