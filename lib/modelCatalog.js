/**
 * ALOO — live model catalogue.
 * ===========================================================================
 * The seed lists in settingsStore populate the dropdown instantly; this module
 * replaces them with what the provider actually serves right now.
 *
 * WHY IT MATTERS: NVIDIA retires hosted models continuously. A stale id fails
 * as 410 ("has reached its end of life") or, once the route is gone, as a bare
 * `404 page not found`. Neither is diagnosable from the UI, so the only durable
 * fix is to stop guessing and ask.
 *
 * Google has no unauthenticated catalogue endpoint (`/v1beta/models` demands a
 * key), so Gemini stays on the curated list — it is short and stable enough.
 *
 * The fetch is best-effort by design: offline, proxied, or rate-limited, the
 * user still gets the seed list and a working picker.
 */

import { NVIDIA_MODELS, RETIRED_MODELS } from '@/lib/settingsStore';
import { isNative } from '@/lib/runtime';

const NIM_DIRECT_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';

/**
 * Ids that exist in the catalogue but are useless as a chat backend — embedders,
 * rerankers, safety classifiers, OCR/parse and pure-vision encoders. Listing
 * them would hand the user a model that answers every message with an error.
 */
const NON_CHAT = /(embed|rerank|nemoguard|safety-guard|content-safety|topic-control|nvclip|nemotron-parse|deplot|-reward|detector|riva-translate|calibration)/i;

let cache = null; // { at:number, models:string[] }
let inflight = null;
const TTL_MS = 60 * 60 * 1000;

/** Curated ids first (they are the good defaults), then everything else A-Z. */
function rank(ids) {
  const seeded = NVIDIA_MODELS.filter((m) => ids.includes(m));
  const rest = ids.filter((m) => !seeded.includes(m)).sort();
  return [...seeded, ...rest];
}

function usable(ids) {
  return ids.filter((id) => typeof id === 'string' && !NON_CHAT.test(id) && !RETIRED_MODELS.has(id));
}

/**
 * Resolve the NVIDIA chat-model catalogue.
 * Never rejects — on any failure it resolves to the curated seed list.
 * @returns {Promise<{models:string[], live:boolean}>}
 */
export async function fetchNvidiaModels() {
  if (cache && Date.now() - cache.at < TTL_MS) return { models: cache.models, live: true };
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      // Native has no /api routes; its HTTP bridge is not subject to CORS, so
      // it can read the provider's catalogue directly.
      const res = isNative()
        ? await fetch(NIM_DIRECT_MODELS_URL, { headers: { Accept: 'application/json' } })
        : await fetch('/api/nim/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      // The proxy returns {models}; a direct upstream call returns {data:[{id}]}.
      const raw = Array.isArray(data?.models)
        ? data.models
        : (data?.data || []).map((m) => m?.id);

      const models = rank(usable(raw));
      if (!models.length) throw new Error('empty catalogue');

      cache = { at: Date.now(), models };
      return { models, live: true };
    } catch (err) {
      console.warn('[ALOO/catalog] Live model list unavailable, using seed list:', err.message);
      return { models: NVIDIA_MODELS, live: false };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Is this id known-dead? Used to decorate the picker and to decide whether a
 * failed request is worth retrying on a different model.
 */
export function isRetired(id) {
  if (RETIRED_MODELS.has(id)) return true;
  // Once the live catalogue is in hand, absence from it is itself the answer.
  return !!cache && !cache.models.includes(id);
}

/** A model we believe is alive right now — the failover target. */
export function liveFallbackModel() {
  return cache?.models?.[0] || NVIDIA_MODELS[0];
}
