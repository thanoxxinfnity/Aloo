/**
 * ALOO — Web vs. native runtime detection and endpoint routing.
 * ===========================================================================
 * ALOO ships two ways, and they reach the model providers differently:
 *
 *  WEB (next dev / next start)
 *    The page calls its OWN origin at /api/nim/chat and /api/gemini/chat. Those
 *    edge routes hold the CORS problem and stream Server-Sent Events straight
 *    through, so replies arrive token by token.
 *
 *  NATIVE (Android APK via Capacitor)
 *    There is no server — the app is a static bundle inside a WebView, so
 *    /api/* does not exist. Instead we call the providers DIRECTLY. That would
 *    normally be blocked by CORS, but Capacitor's `CapacitorHttp` plugin
 *    patches `window.fetch` to run requests through native Java HTTP, which is
 *    not subject to browser CORS at all.
 *
 *    The tradeoff is real and worth stating: the native HTTP bridge buffers the
 *    whole response, so there is no token streaming in the APK. We therefore
 *    issue a non-streaming request and deliver the reply in one piece. Every
 *    other feature — voice, lip-sync, vision, deep research — is identical.
 */

export const NIM_DIRECT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
export const GEMINI_DIRECT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const TAVILY_DIRECT_URL = 'https://api.tavily.com/search';

/** True inside the Capacitor Android/iOS shell, false in any browser. */
export function isNative() {
  if (typeof window === 'undefined') return false;
  const cap = window.Capacitor;
  if (!cap) return false;
  // isNativePlatform() is the supported check; the older `platform` string is
  // kept as a fallback for shells built against Capacitor 4.
  if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
  return !!cap.platform && cap.platform !== 'web';
}

/** Platform label for the HUD. */
export function platformName() {
  if (typeof window === 'undefined') return 'server';
  return window.Capacitor?.getPlatform?.() || 'web';
}

/**
 * Streaming is only available where a real SSE body reaches the page.
 * Kept as its own predicate so callers read as intent, not as a platform check.
 */
export function supportsStreaming() {
  return !isNative();
}
