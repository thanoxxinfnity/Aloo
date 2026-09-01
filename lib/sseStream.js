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

/** Pull a readable message out of an error response body. */
export async function describeHttpError(response) {
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
  return typeof detail === 'string' ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600);
}
