/**
 * ALOO — Web retrieval endpoint for the Deep Research engine.
 * ===========================================================================
 * Two modes:
 *   POST { mode: 'search', query, maxResults }  -> ranked result list
 *   POST { mode: 'fetch',  url }                -> readable plain text of a page
 *
 * PROVIDER LADDER (first one that yields results wins):
 *   1. Tavily      — best quality, needs a key (settings drawer or TAVILY_API_KEY).
 *   2. DuckDuckGo  — keyless HTML endpoint, scraped. No API contract, so it is
 *                    best-effort and can break if DDG changes their markup.
 *   3. Wikipedia   — keyless, always available, keeps research grounded in
 *                    *something* rather than falling back to pure model recall.
 *
 * Running this server-side is what makes it possible at all: every one of these
 * origins would fail CORS from the browser.
 */

export const config = { runtime: 'edge' };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36';

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed JSON body' }, 400);
  }

  const mode = body.mode || 'search';

  if (mode === 'fetch') {
    return handleFetch(body.url);
  }

  const query = String(body.query || '').trim();
  if (!query) return json({ error: '`query` is required' }, 400);
  const maxResults = Math.min(10, Math.max(1, body.maxResults || 5));
  const tavilyKey = req.headers.get('x-tavily-api-key') || process.env.TAVILY_API_KEY;

  const attempts = [];

  if (tavilyKey) {
    try {
      const r = await searchTavily(query, maxResults, tavilyKey);
      if (r.results.length) return json({ ...r, provider: 'tavily' });
      attempts.push('tavily: no results');
    } catch (err) {
      attempts.push(`tavily: ${err.message}`);
    }
  }

  try {
    const r = await searchDuckDuckGo(query, maxResults);
    if (r.results.length) return json({ ...r, provider: 'duckduckgo' });
    attempts.push('duckduckgo: no results');
  } catch (err) {
    attempts.push(`duckduckgo: ${err.message}`);
  }

  try {
    const r = await searchWikipedia(query, maxResults);
    if (r.results.length) return json({ ...r, provider: 'wikipedia' });
    attempts.push('wikipedia: no results');
  } catch (err) {
    attempts.push(`wikipedia: ${err.message}`);
  }

  return json({ results: [], answer: '', provider: 'none', attempts }, 200);
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

async function searchTavily(query, maxResults, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'advanced',
      include_answer: true,
      include_raw_content: false,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    query,
    answer: data.answer || '',
    results: (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content || '',
      score: r.score ?? null,
    })),
  };
}

async function searchDuckDuckGo(query, maxResults) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const results = [];
  // DDG's HTML endpoint wraps each hit in a result__a anchor followed by a
  // result__snippet block. Regex is fragile by nature — hence the ladder above.
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));

  let m;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
    const url = decodeDdgUrl(m[1]);
    if (!url) continue;
    results.push({
      title: stripTags(m[2]),
      url,
      snippet: snippets[i] || '',
      score: null,
    });
    i++;
  }

  return { query, answer: '', results };
}

async function searchWikipedia(query, maxResults) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*' +
    `&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const hits = data?.query?.search || [];
  return {
    query,
    answer: '',
    results: hits.map((h) => ({
      title: h.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      snippet: stripTags(h.snippet || ''),
      score: null,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Page reader                                                                 */
/* -------------------------------------------------------------------------- */

async function handleFetch(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return json({ error: 'Invalid url' }, 400);
  }
  // Only public web schemes — never let a crafted "source" pull an internal
  // address through our server (SSRF).
  if (!['http:', 'https:'].includes(url.protocol)) {
    return json({ error: 'Only http(s) URLs may be fetched' }, 400);
  }
  if (isPrivateHost(url.hostname)) {
    return json({ error: 'Refusing to fetch a private/internal address' }, 400);
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) return json({ error: `HTTP ${res.status}`, url: url.toString() }, 200);

    const type = res.headers.get('content-type') || '';
    if (!type.includes('html') && !type.includes('text')) {
      return json({ url: url.toString(), text: '', note: `Skipped ${type}` }, 200);
    }

    const html = await res.text();
    return json({ url: url.toString(), text: htmlToText(html).slice(0, 12000) }, 200);
  } catch (err) {
    return json({ error: err.message, url: url.toString() }, 200);
  }
}

/** Reject loopback / RFC1918 / link-local hosts before we fetch them. */
function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h) || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  return false;
}

function htmlToText(html) {
  return stripTags(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(nav|header|footer|aside|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
  )
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** DDG wraps outbound links in /l/?uddg=<encoded>. Unwrap to the real target. */
function decodeDdgUrl(href) {
  try {
    if (href.startsWith('//')) href = `https:${href}`;
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    const real = target ? decodeURIComponent(target) : u.toString();
    if (!/^https?:\/\//.test(real)) return null;
    if (real.includes('duckduckgo.com/y.js')) return null; // sponsored slot
    return real;
  } catch {
    return null;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
