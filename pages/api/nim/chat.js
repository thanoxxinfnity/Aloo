/**
 * ALOO — NVIDIA NIM streaming proxy.
 * ===========================================================================
 * WHY A PROXY AT ALL?
 *  1. CORS — integrate.api.nvidia.com does not send Access-Control-Allow-Origin
 *     for browser requests, so a direct fetch from the page is blocked.
 *  2. The API key never has to appear in a URL or a preflight-visible header
 *     to a third-party origin.
 *
 * We run on the EDGE runtime so the upstream SSE body can be piped straight
 * through with zero buffering — first token latency stays as low as the
 * upstream allows.
 *
 * KEY RESOLUTION ORDER: caller-supplied header (bring-your-own-key from the
 * settings drawer) -> NVIDIA_NIM_API_KEY env var.
 */

export const config = { runtime: 'edge' };

const NIM_BASE = 'https://integrate.api.nvidia.com/v1';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey = req.headers.get('x-nvidia-api-key') || process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    return json(
      { error: 'No NVIDIA NIM API key. Add one in Settings → API Keys, or set NVIDIA_NIM_API_KEY.' },
      401
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed JSON body' }, 400);
  }

  const {
    model = 'meta/llama-3.3-70b-instruct',
    messages = [],
    temperature = 0.7,
    max_tokens = 1024,
    top_p = 0.95,
    stream = true,
  } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: '`messages` must be a non-empty array' }, 400);
  }

  let upstream;
  try {
    upstream = await fetch(`${NIM_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens, top_p, stream }),
    });
  } catch (err) {
    return json({ error: `Could not reach NVIDIA NIM: ${err.message}` }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    return json(
      { error: `NVIDIA NIM ${upstream.status}`, detail: detail.slice(0, 2000) },
      upstream.status
    );
  }

  if (!stream) {
    return new Response(upstream.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Pipe the SSE body straight through, unbuffered.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // stops nginx-style proxies re-buffering the stream
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
