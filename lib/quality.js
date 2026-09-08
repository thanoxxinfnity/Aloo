/**
 * ALOO — render quality tiers.
 * ===========================================================================
 * WHY A TIER SYSTEM AND NOT JUST "LOWER THE SETTINGS"
 * The scene has to run on a 4GB Android phone and on a desktop GPU, and the
 * knobs that matter differ by an order of magnitude between them. Rather than
 * scatter `isMobile ? a : b` through the renderer, every cost decision is
 * resolved once, here, into a plain object the components read.
 *
 * WHAT ACTUALLY COSTS FRAMES, measured from most to least expensive on a phone:
 *
 *  1. CONTACT SHADOWS — drei's ContactShadows renders the whole scene AGAIN
 *     into an offscreen target every frame. On a 66-primitive, 471-bone avatar
 *     that is close to a second full skinning pass, for a soft blob on the
 *     floor. It is the single biggest win and the first thing to go.
 *
 *  2. PIXEL COUNT — a modern phone reports devicePixelRatio 2.5-3.5. Rendering
 *     at 2x is 4x the fill of 1x; at 1.25x it is 1.5x. Nothing else on this
 *     list comes close to that leverage, and on a small screen the difference
 *     is barely visible.
 *
 *  3. SHADOW MAPPING — a second render of every caster into a depth map, plus
 *     the per-fragment lookup. Disabling `castShadow` is not enough; the map
 *     itself has to be off.
 *
 *  4. MSAA (`antialias`) — costly bandwidth on tile-based mobile GPUs.
 *
 *  5. PARTICLE COUNT — the starfield's sprites and points are cheap each but
 *     numerous, and they are pure background.
 *
 * DETECTION is deliberately conservative: `deviceMemory` is coarse (it reports
 * 4 for anything from 4 to 7GB) and absent on iOS, so a device that cannot be
 * identified is assumed to be modest rather than powerful. Being wrong toward
 * "too fast and slightly softer" is recoverable; being wrong toward "beautiful
 * and 8fps" is not.
 */

export const QUALITY_TIERS = ['auto', 'high', 'balanced', 'low'];

/** Knobs for each tier. `dpr` is [min, max] for r3f. */
const PROFILES = {
  high: {
    label: 'High',
    dpr: [1, 2],
    antialias: true,
    shadows: true,
    contactShadows: true,
    particleScale: 1,
    sparkles: true,
  },
  balanced: {
    label: 'Balanced',
    dpr: [1, 1.5],
    antialias: true,
    shadows: false,
    contactShadows: true,
    particleScale: 0.6,
    sparkles: true,
  },
  low: {
    label: 'Low (4GB phones)',
    dpr: [1, 1.25],
    antialias: false,
    shadows: false,
    contactShadows: false,
    particleScale: 0.3,
    sparkles: false,
  },
};

/**
 * Guess the device's tier.
 *
 * Runs once at module scope in the browser; on the server it returns
 * 'balanced', which is also what hydration renders with, so the first client
 * frame never has to re-create the WebGL context to change `dpr`.
 */
export function detectTier() {
  if (typeof navigator === 'undefined') return 'balanced';

  const mem = navigator.deviceMemory; // GB, coarse, Chromium-only
  const cores = navigator.hardwareConcurrency || 0;
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

  // A phone that admits to 4GB or less is exactly the case this exists for.
  if (mem && mem <= 4) return 'low';
  if (cores && cores <= 4) return 'low';
  // Anything hand-held without a stronger signal: assume it needs the help.
  if (touch && (!mem || mem <= 8)) return 'balanced';
  if (mem && mem >= 8 && cores >= 8) return 'high';
  return 'balanced';
}

/**
 * Resolve a setting ('auto' | tier name) into a concrete profile.
 * @returns {{key:string, label:string, dpr:number[], antialias:boolean,
 *            shadows:boolean, contactShadows:boolean, particleScale:number,
 *            sparkles:boolean, detected:string}}
 */
export function resolveQuality(setting = 'auto') {
  const detected = detectTier();
  const key = setting && setting !== 'auto' && PROFILES[setting] ? setting : detected;
  return { key, detected, ...PROFILES[key] };
}
