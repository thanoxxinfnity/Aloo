/**
 * ALOO — Web retrieval endpoint for the Deep Research engine.
 * ===========================================================================
 * Two modes:
 *   POST { mode: 'search', query, maxResults }  -> ranked result list
 *   POST { mode: 'fetch',  url }                -> readable plain text of a page
 *
 * The provider ladder and the page reader live in lib/searchProviders.js so the
 * Android build can run the identical code in-process (see lib/runtime.js).
 * Running them server-side is what makes them possible on the web at all: every
 * one of these origins would fail CORS from a browser.
 */

import { searchWeb, readPageText } from '@/lib/searchProviders';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed JSON body' }, 400);
  }

  if ((body.mode || 'search') === 'fetch') {
    // A failed read is reported as 200 with an `error` field: one dead link
    // must not fail the whole research run.
    return json(await readPageText(body.url), 200);
  }

  const query = String(body.query || '').trim();
  if (!query) return json({ error: '`query` is required' }, 400);

  const maxResults = Math.min(10, Math.max(1, body.maxResults || 5));
  const tavilyKey = req.headers.get('x-tavily-api-key') || process.env.TAVILY_API_KEY;

  return json(await searchWeb(query, maxResults, tavilyKey), 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
