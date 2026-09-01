/**
 * ALOO — Google Gemini streaming proxy (text + vision).
 * ===========================================================================
 * Uses the REST `streamGenerateContent` endpoint with `alt=sse`, which emits
 * ordinary Server-Sent Events — the same shape our NIM path produces, so the
 * client can share one stream reader.
 *
 * The API key travels as a query parameter to Google (that is how the API is
 * designed). Keeping that call server-side means the key is never written into
 * a URL the browser's history, referrer headers or devtools network log can
 * leak it from.
 *
 * Vision: `contents[].parts[]` may contain `inlineData` with a base64 JPEG —
 * that is how webcam frames reach Gemini 1.5's multimodal input.
 */

export const config = { runtime: 'edge' };

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey = req.headers.get('x-gemini-api-key') || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(
      { error: 'No Gemini API key. Add one in Settings → API Keys, or set GEMINI_API_KEY.' },
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
    model = 'gemini-1.5-flash',
    contents = [],
    systemInstruction,
    temperature = 0.7,
    maxOutputTokens = 1024,
    stream = true,
    tools,
  } = body;

  if (!Array.isArray(contents) || contents.length === 0) {
    return json({ error: '`contents` must be a non-empty array' }, 400);
  }

  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const url =
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:${method}` +
    `?key=${encodeURIComponent(apiKey)}${stream ? '&alt=sse' : ''}`;

  const payload = {
    contents,
    generationConfig: { temperature, maxOutputTokens, topP: 0.95 },
    // Loosened so an assistant discussing news/medicine isn't silently truncated.
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  };
  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  if (tools) payload.tools = tools;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json({ error: `Could not reach Gemini: ${err.message}` }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    return json(
      { error: `Gemini ${upstream.status}`, detail: detail.slice(0, 2000) },
      upstream.status
    );
  }

  if (!stream) {
    return new Response(upstream.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
