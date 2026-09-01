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

  const res = await fetch('/api/gemini/chat', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(s.geminiApiKey ? { 'x-gemini-api-key': s.geminiApiKey } : {}),
    },
    body: JSON.stringify({
      model: s.geminiModel,
      contents: toGeminiContents(messages),
      systemInstruction: s.systemPrompt,
      temperature: s.temperature,
      maxOutputTokens: s.maxTokens,
      stream: true,
    }),
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

  const res = await fetch('/api/gemini/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(s.geminiApiKey ? { 'x-gemini-api-key': s.geminiApiKey } : {}),
    },
    body: JSON.stringify({
      model: s.geminiModel,
      contents: toGeminiContents(messages),
      systemInstruction: overrides.systemPrompt ?? s.systemPrompt,
      temperature: overrides.temperature ?? s.temperature,
      maxOutputTokens: overrides.maxTokens ?? s.maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(await describeHttpError(res));
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}
