/**
 * ALOO — Deep Web Research engine.
 * ===========================================================================
 * An autonomous multi-step pipeline, not a single search-and-summarise call:
 *
 *   PLAN     the active LLM decomposes the question into N orthogonal
 *            sub-queries (JSON out, defensively parsed).
 *   SEARCH   each sub-query hits /api/search in parallel.
 *   READ     the highest-ranked unique pages are fetched and reduced to text
 *            (this is the RAG step — real page bodies, not just snippets).
 *   SYNTHESE the corpus is streamed back through the LLM with an instruction
 *            to cite every claim by source index.
 *
 * Every stage reports through `onProgress` so DeepResearchPanel can show the
 * agent thinking rather than a spinner.
 */

import { complete, streamChat } from './aiRouter';
import { getSettings } from '@/lib/settingsStore';

/** Ask the model for sub-queries; fall back to heuristics if it misbehaves. */
export async function planQueries(question, depth = 3) {
  const prompt =
    `Decompose this research question into exactly ${depth} distinct web search queries ` +
    `that together cover it comprehensively. Cover different angles: definitions/background, ` +
    `current state and recent developments, and criticism/limitations/comparisons.\n\n` +
    `Question: ${question}\n\n` +
    `Reply with ONLY a JSON array of ${depth} short query strings. No prose, no code fence.`;

  try {
    const raw = await complete({
      messages: [{ role: 'user', content: prompt }],
      overrides: {
        systemPrompt: 'You output only valid JSON. Never explain.',
        temperature: 0.3,
        maxTokens: 400,
      },
    });
    const queries = extractJsonArray(raw);
    if (queries.length) return queries.slice(0, depth);
  } catch (err) {
    console.warn('[ALOO/research] Planner failed, using heuristic queries:', err.message);
  }

  // Heuristic fallback — still gives the pipeline three useful angles.
  const base = question.replace(/[?.!]+$/, '');
  return [base, `${base} latest developments ${new Date().getFullYear()}`, `${base} criticism limitations`]
    .slice(0, depth);
}

/** Pull the first JSON array out of a model reply, fenced or not. */
function extractJsonArray(text) {
  if (!text) return [];
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

async function runSearch(query, maxResults, tavilyApiKey, signal) {
  const res = await fetch('/api/search', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(tavilyApiKey ? { 'x-tavily-api-key': tavilyApiKey } : {}),
    },
    body: JSON.stringify({ mode: 'search', query, maxResults }),
  });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  return res.json();
}

async function readPage(url, signal) {
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'fetch', url }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.text || '';
  } catch {
    return ''; // one dead link must never sink the whole run
  }
}

/**
 * Execute the full research run.
 *
 * @param {string}   question
 * @param {Object}   handlers
 * @param {Function} handlers.onProgress  ({ stage, detail, queries, sources })
 * @param {Function} handlers.onToken     streaming synthesis deltas
 * @param {AbortSignal} handlers.signal
 * @returns {Promise<{ report: string, sources: Array, queries: Array }>}
 */
export async function runDeepResearch(question, { onProgress, onToken, signal } = {}) {
  const s = getSettings();
  const depth = Math.max(1, Math.min(6, s.researchDepth || 3));
  const perQuery = Math.max(2, Math.min(10, s.researchResultsPerQuery || 5));

  /* -- 1. PLAN ------------------------------------------------------------ */
  onProgress?.({ stage: 'planning', detail: 'Decomposing the question into search vectors…' });
  const queries = await planQueries(question, depth);
  onProgress?.({ stage: 'planned', detail: `${queries.length} sub-queries generated.`, queries });

  /* -- 2. SEARCH (parallel) ----------------------------------------------- */
  onProgress?.({ stage: 'searching', detail: `Querying the open web ×${queries.length}…`, queries });
  const searchResults = await Promise.all(
    queries.map((q) =>
      runSearch(q, perQuery, s.tavilyApiKey, signal).catch((err) => {
        console.warn('[ALOO/research] search error:', err.message);
        return { query: q, results: [], answer: '' };
      })
    )
  );

  // Deduplicate by URL, preserving the order queries were planned in.
  const seen = new Set();
  const sources = [];
  for (const bundle of searchResults) {
    for (const r of bundle.results || []) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      sources.push({ ...r, viaQuery: bundle.query });
    }
  }
  onProgress?.({
    stage: 'searched',
    detail: `${sources.length} unique sources found.`,
    queries,
    sources,
  });

  if (!sources.length) {
    const msg =
      'No web sources could be retrieved. Add a Tavily API key in Settings for reliable ' +
      'search, or check this deployment\'s outbound network access.';
    onProgress?.({ stage: 'error', detail: msg });
    return { report: msg, sources: [], queries };
  }

  /* -- 3. READ ------------------------------------------------------------ */
  // Read only the top slice: page fetches dominate wall-clock time, and beyond
  // ~6 documents the synthesis stops improving while token cost keeps rising.
  const toRead = sources.slice(0, Math.min(6, sources.length));
  onProgress?.({ stage: 'reading', detail: `Reading ${toRead.length} documents…`, sources });
  const bodies = await Promise.all(toRead.map((src) => readPage(src.url, signal)));
  bodies.forEach((text, i) => {
    toRead[i].body = text.slice(0, 4500); // keep the context window sane
  });

  /* -- 4. SYNTHESISE ------------------------------------------------------ */
  onProgress?.({ stage: 'synthesizing', detail: 'Cross-referencing and composing…', sources });

  const corpus = sources
    .map((src, i) => {
      const body = src.body ? `\nEXCERPT: ${src.body}` : '';
      return `[${i + 1}] ${src.title}\nURL: ${src.url}\nSNIPPET: ${src.snippet}${body}`;
    })
    .join('\n\n---\n\n');

  const synthPrompt =
    `RESEARCH QUESTION: ${question}\n\n` +
    `You have been given ${sources.length} web sources below. Write an exhaustive, ` +
    `well-structured report that answers the question.\n\n` +
    `Rules:\n` +
    `- Cite every factual claim with its source number in square brackets, e.g. [2].\n` +
    `- Use markdown headings and short paragraphs.\n` +
    `- Open with a 2-3 sentence executive summary.\n` +
    `- Note explicitly where sources disagree or where evidence is thin.\n` +
    `- If the sources do not answer part of the question, say so instead of guessing.\n` +
    `- Do not append a source list; the interface renders one.\n\n` +
    `SOURCES:\n\n${corpus}`;

  let report = '';
  try {
    report = await streamChat({
      messages: [{ role: 'user', content: synthPrompt }],
      onToken,
      signal,
      overrides: {
        systemPrompt:
          'You are ALOO Deep Research: a meticulous analyst. You never invent facts and ' +
          'you always cite by source number.',
        temperature: 0.35,
        maxTokens: Math.max(2048, s.maxTokens),
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    onProgress?.({ stage: 'error', detail: err.message });
    throw err;
  }

  onProgress?.({ stage: 'done', detail: 'Research complete.', sources, queries });
  return { report, sources, queries };
}
