import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listStoredModels,
  addUploadedModel,
  addRemoteModel,
  removeModel,
  releaseEntry,
  urlForEntry,
  mergeCatalog,
  BUILT_IN_MODELS,
} from '@/lib/modelLibrary';

/**
 * React binding for the IndexedDB model library.
 *
 * Selection is stored in settings as the entry ID (`avatarModelId`), not as a
 * URL, because an uploaded model's object URL is minted fresh every session —
 * persisting the URL would break the choice on the next reload. This hook
 * resolves ID -> live URL and hands that to the canvas.
 */
export default function useModelLibrary(settings, set) {
  const [stored, setStored] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setStored(await listStoredModels());
      setError(null);
    } catch (err) {
      // A private window or a browser with storage disabled just means no
      // library — the built-ins still work, so this is not fatal.
      setError(err.message);
      setStored([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const avatars = useMemo(() => mergeCatalog(stored, 'avatar'), [stored]);
  const spaces = useMemo(() => mergeCatalog(stored, 'space'), [stored]);

  const entryById = useCallback(
    (id) => [...BUILT_IN_MODELS, ...stored].find((m) => m.id === id) || null,
    [stored]
  );

  /**
   * The URLs the canvas should load right now. Falls back to the built-ins when
   * a selected entry has been deleted, so a stale id can never blank the scene.
   */
  const resolved = useMemo(() => {
    const avatarEntry = entryById(settings.avatarModelId) || avatars[0];
    const spaceEntry = entryById(settings.spaceModelId) || spaces[0];
    return {
      avatarUrl: urlForEntry(avatarEntry),
      spaceUrl: urlForEntry(spaceEntry),
      avatarEntry,
      spaceEntry,
    };
  }, [settings.avatarModelId, settings.spaceModelId, entryById, avatars, spaces]);

  const upload = useCallback(
    async (file, kind, label) => {
      setError(null);
      try {
        const entry = await addUploadedModel(file, kind, label);
        await refresh();
        // Select what was just added — that is invariably why it was added.
        set(kind === 'avatar' ? 'avatarModelId' : 'spaceModelId', entry.id);
        return entry;
      } catch (err) {
        setError(err.message);
        throw err;
      }
    },
    [refresh, set]
  );

  const addUrl = useCallback(
    async (url, kind, label) => {
      setError(null);
      try {
        const entry = await addRemoteModel(url, kind, label);
        await refresh();
        set(kind === 'avatar' ? 'avatarModelId' : 'spaceModelId', entry.id);
        return entry;
      } catch (err) {
        setError(err.message);
        throw err;
      }
    },
    [refresh, set]
  );

  const remove = useCallback(
    async (id) => {
      const entry = entryById(id);
      if (entry?.builtin) return;
      await removeModel(id);
      releaseEntry(id);
      // Fall back to the bundled entry if the deleted one was selected.
      if (settings.avatarModelId === id) set('avatarModelId', 'builtin:avatar');
      if (settings.spaceModelId === id) set('spaceModelId', 'builtin:space');
      await refresh();
    },
    [entryById, refresh, set, settings.avatarModelId, settings.spaceModelId]
  );

  return { avatars, spaces, stored, loading, error, setError, resolved, upload, addUrl, remove, refresh };
}
