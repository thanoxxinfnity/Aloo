/**
 * ALOO — Server-Sent Events reader.
 * ---------------------------------------------------------------------------
 * Both providers stream SSE through our proxies, so one reader serves both.
 * We cannot use the browser's `EventSource`: it only does GET, and our chat
 * payloads (with base64 vision frames) must be POSTed.
 *
 * The subtle part is chunk boundaries — a network chunk can split an event in
 * half, so we buffer and only emit on a complete `\n\n` delimiter.
 */

export async function readSSE(response, onEvent, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response has no readable body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Accept \r\n\r\n too.
      let idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));

        const dataLines = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          // `event:`, `id:` and `:comment` lines are not used by either provider.
        }
        if (!dataLines.length) continue;

        const data = dataLines.join('\n');
        if (data === '[DONE]') return; // OpenAI-style terminator (NVIDIA NIM)

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // a non-JSON data line is not fatal; keep streaming
        }
        // Deliberately outside the try above: a throw from onEvent (e.g. a
        // provider block reason) must propagate, not be swallowed as a
        // parse failure.
        onEvent(parsed);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Pull a READABLE message out of an error response body.
 *
 * The raw bodies are actively unhelpful and this is the only place that can fix
 * them, because by the time the toast renders the status code is long gone:
 *
 *   • NVIDIA retires a model and its Go router answers `404 page not found` —
 *     plain text, no JSON, no mention of a model. A user reads that as "the app
 *     is broken", which is exactly the wrong conclusion.
 *   • A recently-retired id gets 410 with the reason buried in `detail`.
 *   • Google answers a retired model with 404 and an EMPTY body, which would
 *     otherwise surface as a blank error toast.
 *
 * So we translate: say which model failed and what to do about it. `context`
 * carries the model id the caller was using.
 */
export async function describeHttpError(response, context = {}) {
  const { model } = context;
  const named = model ? `"${model}"` : 'that model';

  let detail = '';
  try {
    const text = await response.text();
    try {
      const obj = JSON.parse(text);
      detail = obj.error?.message || obj.detail || obj.error || text;
    } catch {
      detail = text;
    }
  } catch {
    detail = response.statusText;
  }
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  detail = (detail || '').trim();

  // A model that no longer exists — the single most common failure, and the
  // one whose raw body explains the least.
  if (response.status === 404 || response.status === 410) {
    if (!detail || /404 page not found/i.test(detail)) {
      return `Model ${named} is no longer available. Pick another in Settings → Neural Core.`;
    }
    if (/end of life|no longer available/i.test(detail)) {
      return `${detail} Pick another model in Settings → Neural Core.`;
    }
  }

  if (response.status === 401 || response.status === 403) {
    return detail
      ? `${detail} (check your API key in Settings → API Keys)`
      : 'API key rejected. Check it in Settings → API Keys.';
  }

  if (response.status === 429) {
    return detail ? `Rate limited: ${detail}` : 'Rate limited by the provider — try again shortly.';
  }

  if (!detail) return `Request failed (HTTP ${response.status}).`;
  return detail.slice(0, 600);
}

/**
 * Should we retry this failure on a different model?
 * Only for "this model does not exist" — never for auth, rate limits or a
 * genuine server fault, where a retry just burns another request.
 */
export function isDeadModelStatus(status) {
  return status === 404 || status === 410;
}
