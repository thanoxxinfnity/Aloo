import { useEffect, useState } from 'react';

/**
 * Probe whether an asset URL actually exists before we hand it to a loader.
 *
 * WHY: `useGLTF` suspends and then throws if the file is missing, and a throw
 * inside Suspense unmounts the whole Canvas subtree — a missing avatar.glb
 * would blank the entire app. A cheap HEAD request lets us choose a procedural
 * fallback instead, so ALOO always boots, with or without user-supplied models.
 *
 * @returns {'checking'|'available'|'missing'}
 */
export default function useAssetAvailable(url) {
  const [status, setStatus] = useState('checking');

  useEffect(() => {
    if (!url) {
      setStatus('missing');
      return undefined;
    }
    // Object URLs and data URLs are in-memory by definition — probing them
    // over the network is meaningless (and a HEAD on a blob: URL can throw).
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      setStatus('available');
      return undefined;
    }

    let cancelled = false;
    setStatus('checking');

    (async () => {
      try {
        // Some static hosts reject HEAD; fall back to a ranged GET of 1 byte.
        let res = await fetch(url, { method: 'HEAD' });
        if (!res.ok && res.status !== 405) throw new Error(String(res.status));
        if (res.status === 405) {
          res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        }
        const type = res.headers.get('content-type') || '';
        // Next.js dev server answers 200 + text/html for unknown paths, so a
        // status check alone is not enough — an HTML body means "not a model".
        const ok = res.ok && !type.includes('text/html');
        if (!cancelled) setStatus(ok ? 'available' : 'missing');
      } catch {
        if (!cancelled) setStatus('missing');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return status;
}
