/**
 * ALOO — NVIDIA NIM client (build.nvidia.com / integrate.api.nvidia.com).
 * ===========================================================================
 * NIM speaks the OpenAI chat-completions dialect, so the wire format is
 * `{ model, messages:[{role, content}], stream:true }` and deltas arrive as
 * `choices[0].delta.content`.
 *
 * VISION ON NIM: the vision NIMs (phi-3.5-vision, llama-3.2-90b-vision) do not
 * use OpenAI's `image_url` parts. They accept an inline HTML image tag with a
 * data URI embedded in the message text — that is NVIDIA's documented
 * convention, and it is what `toNimMessages` emits.
 *
 * All calls go through /api/nim/chat (see that file for why).
 */

import { readSSE, describeHttpError } from '@/lib/sseStream';
import { getSettings } from '@/lib/settingsStore';
import { isNative, supportsStreaming, NIM_DIRECT_URL } from '@/lib/runtime';

/**
 * Where to POST, and with which headers.
 *  web    -> our own edge proxy (CORS + key hygiene + SSE passthrough)
 *  native -> the provider directly, through Capacitor's native HTTP bridge
 */
function nimEndpoint(s) {
  if (isNative()) {
    return {
      url: NIM_DIRECT_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.nvidiaApiKey}`,
      },
    };
  }
  return {
    url: '/api/nim/chat',
    headers: {
      'Content-Type': 'application/json',
      // Bring-your-own-key: only sent to our own origin, never cross-origin.
      ...(s.nvidiaApiKey ? { 'x-nvidia-api-key': s.nvidiaApiKey } : {}),
    },
  };
}

/** Convert ALOO's internal message shape into NIM/OpenAI messages. */
export function toNimMessages(messages, systemPrompt) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });

  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    let content = m.content || '';
    if (m.images?.length) {
      // NIM VLM convention: <img src="data:image/jpeg;base64,..." />
      const tags = m.images
        .map((dataUrl) => `<img src="${dataUrl}" />`)
        .join('');
      content = `${content}${tags}`;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return out;
}

/**
 * Stream a completion.
 * @param {Object}   opts
 * @param {Array}    opts.messages     internal message list
 * @param {Function} opts.onToken      called with each text delta
 * @param {AbortSignal} opts.signal
 * @returns {Promise<string>} the full assembled reply
 */
export async function streamNimChat({ messages, onToken, signal, overrides = {} }) {
  const s = { ...getSettings(), ...overrides };

  // The native bridge buffers responses, so ask for a whole reply there and
  // hand it to the caller in one delivery rather than pretending to stream.
  if (!supportsStreaming()) {
    const full = await completeNim({ messages, overrides });
    onToken?.(full, full);
    return full;
  }

  const { url, headers } = nimEndpoint(s);
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model: s.nvidiaModel,
      messages: toNimMessages(messages, s.systemPrompt),
      temperature: s.temperature,
      max_tokens: s.maxTokens,
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(await describeHttpError(res));

  let full = '';
  await readSSE(
    res,
    (chunk) => {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onToken?.(delta, full);
      }
    },
    signal
  );

  return full;
}

/** Non-streaming variant — used by the research planner, which wants JSON. */
export async function completeNim({ messages, overrides = {} }) {
  const s = { ...getSettings(), ...overrides };

  if (isNative() && !s.nvidiaApiKey) {
    throw new Error('No NVIDIA NIM API key. Add one in Settings → API Keys.');
  }

  const { url, headers } = nimEndpoint(s);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: s.nvidiaModel,
      messages: toNimMessages(messages, overrides.systemPrompt ?? s.systemPrompt),
      temperature: overrides.temperature ?? s.temperature,
      max_tokens: overrides.maxTokens ?? s.maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(await describeHttpError(res));
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}
