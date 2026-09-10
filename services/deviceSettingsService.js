/**
 * ALOO — opening the phone's own settings screens.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not switch the hotspot on. No third-party Android app can:
 * `setWifiApEnabled` was removed in Android 6 and blocked in 7, and its
 * replacement is gated behind a signature|privileged permission. Every npm
 * package that claims otherwise calls the dead API by reflection and fails
 * silently on any current phone.
 *
 * So the honest job is to land the user one tap away instead of five, and to
 * SAY that is what happened rather than reporting a success that did not occur.
 * The native side (SystemSettingsPlugin.java) records the full reasoning.
 */

import { isNative } from '@/lib/runtime';

function plugin() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.SystemSettings || null;
}

/** Is the settings bridge usable here? False in a browser, true in the APK. */
export function canOpenSettings() {
  return isNative() && !!plugin()?.openHotspot;
}

/**
 * Open the tethering/hotspot page.
 * @returns {Promise<{opened:boolean, via:string}>}
 */
export async function openHotspotSettings() {
  const p = plugin();
  if (!p?.openHotspot) {
    throw new Error(
      'Settings can only be opened from the installed app, not the browser version.'
    );
  }
  return p.openHotspot();
}

/** Named screens the plugin knows how to reach. */
export const SETTINGS_SCREENS = [
  'wifi', 'bluetooth', 'data', 'airplane', 'location', 'sound', 'display', 'tts', 'battery',
];

export async function openSettingsScreen(screen) {
  const p = plugin();
  if (!p?.openScreen) {
    throw new Error(
      'Settings can only be opened from the installed app, not the browser version.'
    );
  }
  return p.openScreen({ screen });
}
