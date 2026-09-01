/**
 * ALOO — Provider router.
 * ---------------------------------------------------------------------------
 * One entry point the rest of the app talks to, so nothing above this layer
 * has to know whether NVIDIA or Google is answering. Swapping providers
 * mid-conversation therefore needs no message-history migration: both
 * converters read the same internal shape.
 */

import { PROVIDERS, getSettings, activeModel, activeModelSupportsVision } from '@/lib/settingsStore';
import { streamNimChat, completeNim } from './nvidiaNimService';
import { streamGeminiChat, completeGemini } from './geminiService';

export function hasKeyFor(provider, s = getSettings()) {
  return provider === PROVIDERS.NVIDIA ? !!s.nvidiaApiKey : !!s.geminiApiKey;
}

/** Human-readable label for the status bar. */
export function providerLabel(s = getSettings()) {
  return s.provider === PROVIDERS.NVIDIA ? 'NVIDIA NIM' : 'GOOGLE GEMINI';
}

/**
 * Stream a chat completion through whichever provider is active.
 * Strips images when the selected model has no vision capability, so a webcam
 * frame can never 400 a text-only model.
 */
export async function streamChat({ messages, onToken, signal, overrides = {} }) {
  const s = { ...getSettings(), ...overrides };
  const payload = activeModelSupportsVision(s)
    ? messages
    : messages.map(({ images, ...rest }) => rest);

  if (s.provider === PROVIDERS.NVIDIA) {
    return streamNimChat({ messages: payload, onToken, signal, overrides });
  }
  return streamGeminiChat({ messages: payload, onToken, signal, overrides });
}

/** Blocking completion — used by the research planner and synthesiser. */
export async function complete({ messages, overrides = {} }) {
  const s = { ...getSettings(), ...overrides };
  const payload = activeModelSupportsVision(s)
    ? messages
    : messages.map(({ images, ...rest }) => rest);

  if (s.provider === PROVIDERS.NVIDIA) return completeNim({ messages: payload, overrides });
  return completeGemini({ messages: payload, overrides });
}

export { activeModel, activeModelSupportsVision };
