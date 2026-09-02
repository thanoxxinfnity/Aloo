/**
 * ALOO — Google Gemini client (text + vision).
 * ===========================================================================
 * Gemini's REST shape differs from OpenAI's in three ways that matter here:
 *   1. Roles are 'user' / 'model' (never 'assistant', never 'system').
 *   2. The system prompt is a top-level `systemInstruction`, not a message.
 *   3. Images are `inlineData: { mimeType, data }` parts where `data` is RAW
 *      base64 — the `data:image/jpeg;base64,` prefix MUST be stripped or the
 *      request 400s.
 *
 * SDK NOTE: the PRD lists `@google/genai`. We deliberately call REST through
 * our own edge proxy instead: it removes the CORS problem, keeps the key out
 * of the browser's URL bar, and gives one shared SSE reader for both providers.
 * Swapping in the SDK later means replacing only this file.
 */

import { readSSE, describeHttpError } from '@/lib/sseStream';
import { getSettings } from '@/lib/settingsStore';
import { isNative, supportsStreaming, GEMINI_DIRECT_BASE } from '@/lib/runtime';

/** Safety thresholds, mirrored from the proxy so the native path behaves the same. */
const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

/**
 * Native talks to Google directly (Capacitor's native HTTP bridge is not
 * subject to CORS); web goes through our edge proxy so the key never lands in
 * a browser-visible URL.
 */
function geminiRequest(s, { stream, contents, systemPrompt, temperature, maxOutputTokens }) {
  if (isNative()) {
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    return {
      url:
        `${GEMINI_DIRECT_BASE}/models/${encodeURIComponent(s.geminiModel)}:${method}` +
        `?key=${encodeURIComponent(s.geminiApiKey)}${stream ? '&alt=sse' : ''}`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        contents,
        generationConfig: { temperature, maxOutputTokens, topP: 0.95 },
        safetySettings: SAFETY,
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
      },
    };
  }
  return {
    url: '/api/gemini/chat',
    headers: {
      'Content-Type': 'application/json',
      ...(s.geminiApiKey ? { 'x-gemini-api-key': s.geminiApiKey } : {}),
    },
    body: {
      model: s.geminiModel,
      contents,
      systemInstruction: systemPrompt,
      temperature,
      maxOutputTokens,
      stream,
    },
  };
}

/** Strip a data-URI prefix, returning { mimeType, data } for inlineData. */
export function dataUrlToInlinePart(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

/** Convert ALOO's internal message shape into Gemini `contents`. */
export function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    if (m.images?.length) {
      for (const img of m.images) {
        const part = dataUrlToInlinePart(img);
        if (part) parts.push(part);
      }
    }
    if (!parts.length) continue;

    const role = m.role === 'assistant' ? 'model' : 'user';
    const prev = contents[contents.length - 1];
    // Gemini rejects two consecutive turns with the same role — merge them.
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  }

  // A conversation must start with a user turn.
  while (contents.length && contents[0].role === 'model') contents.shift();
  return contents;
}

/** Stream a completion. Returns the full assembled reply. */
export async function streamGeminiChat({ messages, onToken, signal, overrides = {} }) {
  const s = { ...getSettings(), ...overrides };

  // The native HTTP bridge buffers responses — deliver one whole reply instead
  // of faking a stream.
  if (!supportsStreaming()) {
    const full = await completeGemini({ messages, overrides });
    onToken?.(full, full);
    return full;
  }

  const req = geminiRequest(s, {
    stream: true,
    contents: toGeminiContents(messages),
    systemPrompt: s.systemPrompt,
    temperature: s.temperature,
    maxOutputTokens: s.maxTokens,
  });

  const res = await fetch(req.url, {
    method: 'POST',
    signal,
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  if (!res.ok) throw new Error(await describeHttpError(res));

  let full = '';
  await readSSE(
    res,
    (chunk) => {
      // A blocked prompt returns no candidates — surface the reason instead of
      // silently producing an empty reply.
      const block = chunk?.promptFeedback?.blockReason;
      if (block) throw new Error(`Gemini blocked this prompt (${block}).`);

      const parts = chunk?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.text) {
          full += p.text;
          onToken?.(p.text, full);
        }
      }
    },
    signal
  );

  return full;
}

/** Non-streaming variant — used where we need the whole answer at once. */
export async function completeGemini({ messages, overrides = {} }) {
  const s = { ...getSettings(), ...overrides };

  if (isNative() && !s.geminiApiKey) {
    throw new Error('No Gemini API key. Add one in Settings → API Keys.');
  }

  const req = geminiRequest(s, {
    stream: false,
    contents: toGeminiContents(messages),
    systemPrompt: overrides.systemPrompt ?? s.systemPrompt,
    temperature: overrides.temperature ?? s.temperature,
    maxOutputTokens: overrides.maxTokens ?? s.maxTokens,
  });

  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  if (!res.ok) throw new Error(await describeHttpError(res));
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}
