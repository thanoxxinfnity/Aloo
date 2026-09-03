/**
 * ALOO — NVIDIA NIM model catalogue proxy.
 * ===========================================================================
 * WHY THIS EXISTS
 * A hard-coded model list rots. NVIDIA retires hosted models on a rolling
 * schedule, and the failure mode is hostile: `/v1/chat/completions` answers
 * 410 for a recently-retired id, then a bare `404 page not found` — the Go
 * router's default body, with no JSON and no hint — once the route is dropped.
 * A user sees "404 page not found" and has no way to connect it to a model
 * picker they never touched.
 *
 * So the picker asks the provider what actually exists. `/v1/models` needs no
 * authorization, which means we can populate the dropdown before the user has
 * even pasted a key.
 *
 * The proxy is here for the same reason as the chat one: integrate.api.nvidia.com
 * sends no Access-Control-Allow-Origin, so a browser cannot read it directly.
 * (Native skips this and calls upstream through Capacitor's HTTP bridge.)
 */

export const config = { runtime: 'edge' };

const NIM_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';

export default async function handler() {
  let upstream;
  try {
    upstream = await fetch(NIM_MODELS_URL, { headers: { Accept: 'application/json' } });
  } catch (err) {
    return json({ error: `Could not reach NVIDIA NIM: ${err.message}` }, 502);
  }

  if (!upstream.ok) {
    return json({ error: `NVIDIA NIM ${upstream.status}` }, upstream.status);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return json({ error: 'NVIDIA NIM returned a non-JSON catalogue' }, 502);
  }

  return json(
    { models: Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [] },
    200,
    // The catalogue changes on the order of weeks. Cache hard so opening the
    // drawer repeatedly costs nothing.
    { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' }
  );
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}
