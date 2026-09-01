import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  getSettings,
  setSettings,
  resetSettings,
  subscribeSettings,
  hydrateSettings,
  DEFAULT_SETTINGS,
} from '@/lib/settingsStore';

/**
 * React binding for the settings singleton.
 *
 * `useSyncExternalStore` is the right primitive here: the store is mutated from
 * outside React (services read and write it), and this hook guarantees a
 * tear-free read plus a correct SSR snapshot — Next renders this page on the
 * server where localStorage does not exist, so the server snapshot must be the
 * defaults, with hydration filling in the persisted values on the client.
 */
export default function useSettings() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings, () => DEFAULT_SETTINGS);

  useEffect(() => {
    hydrateSettings();
  }, []);

  const update = useCallback((patch) => setSettings(patch), []);
  const set = useCallback((key, value) => setSettings({ [key]: value }), []);
  const reset = useCallback(() => resetSettings(), []);

  return { settings, update, set, reset };
}
