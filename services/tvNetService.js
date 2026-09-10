/**
 * ALOO — the parts of TV control that need UDP.
 *
 * Waking a television and finding one on the network are both UDP, and a
 * WebView has no UDP at all — no API, no polyfill, nothing. That is why "power
 * on" used to be listed as impossible: it was, from inside the page.
 *
 * With the socket work moved into native code (TvSocketPlugin), adding a second
 * small native plugin for datagrams costs almost nothing and turns two "cannot"
 * answers into two buttons. See TvNetPlugin.java for the protocol details.
 */

import { isNative } from '@/lib/runtime';

function plugin() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.TvNet || null;
}

/** True in the installed app, false in a browser tab. */
export function canReachNetwork() {
  return isNative() && typeof plugin()?.wake === 'function';
}

const UNAVAILABLE =
  'Ye sirf installed ALOO app me chalta hai — browser UDP bhej hi nahi sakta.';

/**
 * Send a Wake-on-LAN magic packet.
 *
 * Resolves when the packet has been SENT, which is all that can be known:
 * nothing acknowledges a magic packet, so a caller that wants certainty has to
 * try connecting afterwards. Reporting "TV is on" from here would be a guess.
 *
 * @param {string} mac  the TV's wired or Wi-Fi MAC address
 */
export async function wakeTv(mac) {
  const p = plugin();
  if (!p?.wake) throw new Error(UNAVAILABLE);
  if (!mac) {
    throw new Error(
      'TV ka MAC address nahi hai. Ek baar TV on karke pair karo — ALOO khud yaad kar lega.'
    );
  }
  return p.wake({ mac });
}

/**
 * Search the local network for televisions.
 *
 * @param {number} [timeoutMs] how long to listen for replies
 * @returns {Promise<Array<{address:string,name:string,likelyTv:boolean}>>}
 *   most-likely TVs first, so a caller can offer the best guess without
 *   throwing the rest away.
 */
export async function findTvs(timeoutMs = 4000) {
  const p = plugin();
  if (!p?.discover) throw new Error(UNAVAILABLE);
  const res = await p.discover({ timeoutMs });
  const devices = res?.devices || [];
  return [...devices].sort((a, b) => Number(b.likelyTv) - Number(a.likelyTv));
}
