/**
 * ALOO — a WebSocket that works from inside the APK.
 * ===========================================================================
 * THE PROBLEM THIS SOLVES
 *
 * An LG TV's control port speaks plain, unencrypted `ws://` — webOS offers no
 * `wss://` and there is no setting on the TV to add one. Meanwhile Capacitor
 * serves ALOO's page from `https://localhost`, and Chromium flatly refuses to
 * build a cleartext socket from a secure page:
 *
 *     Failed to construct 'WebSocket': An insecure WebSocket connection may
 *     not be initiated from a page loaded over HTTPS.
 *
 * That is a decision made inside the browser engine before any network call
 * happens, so no Android setting reaches it — `usesCleartextTraffic` governs a
 * different layer entirely. The fix is to let native code own the socket
 * (see TvSocketPlugin.java) and hand JavaScript something that behaves like the
 * WebSocket it expected.
 *
 * That is what this module is: `createSocket(url)` returns the real browser
 * WebSocket on the web, and a native-backed stand-in with the same surface
 * (`readyState`, `send`, `close`, `onopen`/`onmessage`/`onerror`/`onclose`)
 * inside the app. Callers stay unaware of which one they got.
 */

import { isNative } from '@/lib/runtime';

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

function plugin() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.TvSocket || null;
}

/** True when the native socket bridge is present — i.e. in the installed app. */
export function hasNativeSocket() {
  return isNative() && typeof plugin()?.open === 'function';
}

/* -------------------------------------------------------------------------- */
/* Event routing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * All sockets share one set of plugin listeners and are told apart by id.
 * Registering per-socket would mean a listener leak on every failed pairing
 * attempt, and Capacitor's listener removal is asynchronous, so a socket closed
 * during a retry could still receive its predecessor's frames.
 */
const live = new Map(); // id -> NativeSocket
let wired = false;
let nextId = 1;

function wire() {
  if (wired) return;
  const p = plugin();
  if (!p) return;
  wired = true;
  p.addListener('tvSocketMessage', (ev) => live.get(ev?.id)?._message(ev.data));
  p.addListener('tvSocketError', (ev) => live.get(ev?.id)?._error(ev.message));
  p.addListener('tvSocketClosed', (ev) => live.get(ev?.id)?._closed(ev.code, ev.reason));
}

/* -------------------------------------------------------------------------- */
/* The stand-in                                                                */
/* -------------------------------------------------------------------------- */

class NativeSocket {
  constructor(url, { insecure = false } = {}) {
    this.url = url;
    this.readyState = CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    this._id = `aloo_sock_${nextId++}`;
    this._sawError = null;

    wire();
    live.set(this._id, this);

    // Queued rather than awaited: a real WebSocket constructor returns
    // immediately and reports everything through events, and callers here are
    // written against exactly that shape.
    plugin()
      .open({ id: this._id, url, insecure })
      .then(() => this._open())
      .catch((err) => {
        // The plugin already emits an error + close pair for a genuine socket
        // failure; this catch also covers the case where the bridge itself is
        // unreachable, so both paths funnel through the same idempotent
        // handlers instead of double-reporting.
        this._error(err?.message || String(err));
        this._closed(1006, 'connect failed');
      });
  }

  /* -- native callbacks -- */

  _open() {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this.onopen?.({ type: 'open', target: this });
  }

  _message(data) {
    // A frame can in principle reach us before the open() promise settles —
    // they travel over the bridge independently. Data is proof the handshake
    // completed, so promote first and never drop the message.
    if (this.readyState === CONNECTING) this._open();
    if (this.readyState === CLOSED) return;
    this.onmessage?.({ type: 'message', data, target: this });
  }

  _error(message) {
    if (this.readyState === CLOSED) return;
    this._sawError = message || 'Connection failed';
    // Mirrors the browser: the error event carries no payload of use, so the
    // detail is kept on the instance for whoever wants to report it.
    this.onerror?.({ type: 'error', message: this._sawError, target: this });
  }

  _closed(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    live.delete(this._id);
    this.onclose?.({
      type: 'close',
      code: code ?? 1006,
      reason: reason || this._sawError || '',
      wasClean: code === 1000,
      target: this,
    });
  }

  /* -- WebSocket surface -- */

  send(data) {
    if (this.readyState !== OPEN) {
      throw new Error('Cannot send: the connection is not open');
    }
    // Failures are surfaced as an error event rather than a rejected promise,
    // because `WebSocket.send` is synchronous and callers do not await it.
    plugin()
      .send({ id: this._id, data: String(data) })
      .catch((err) => this._error(err?.message || 'Send failed'));
  }

  close() {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    plugin()
      .close({ id: this._id })
      .catch(() => { /* already gone natively; the close event still lands */ })
      .finally(() => this._closed(1000, 'closed by app'));
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Open a socket by whichever route this platform allows.
 *
 * @param {string} url         `ws://…` or `wss://…`
 * @param {Object} [opts]
 * @param {boolean} [opts.insecure]  accept a self-signed certificate. Native
 *   only, and honoured for nothing but the TV's own certificate-less port; a
 *   browser has no equivalent and simply ignores it.
 * @returns {WebSocket|NativeSocket}
 */
export function createSocket(url, opts = {}) {
  if (hasNativeSocket()) return new NativeSocket(url, opts);
  if (typeof WebSocket === 'undefined') {
    throw new Error('This device has no WebSocket support.');
  }
  return new WebSocket(url);
}

/**
 * Why a `ws://` connection would be refused here, or null if it would be fine.
 * Used to replace Chromium's opaque mixed-content message with one that names
 * the actual situation — a browser tab genuinely cannot do this, and saying so
 * up front is better than a failed connection attempt.
 */
export function cleartextBlockReason(url) {
  if (hasNativeSocket()) return null;
  if (typeof window === 'undefined') return null;
  if (!/^ws:\/\//i.test(url)) return null;
  if (window.location?.protocol !== 'https:') return null;
  return (
    'A page served over HTTPS is not allowed to open a plain connection to the TV — '
    + 'browsers block it. TV control works in the installed ALOO app, which makes '
    + 'the connection natively.'
  );
}
