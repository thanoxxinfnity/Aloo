/**
 * ALOO — Web search + page reading providers.
 * ===========================================================================
 * Shared by two callers that reach the open web very differently:
 *
 *   pages/api/search.js         — the edge route used by the web build. A
 *                                 browser cannot call these origins itself
 *                                 (no CORS), so the server does it.
 *   services/researchService.js — the Android build, where Capacitor's native
 *                                 HTTP bridge sidesteps CORS entirely and these
 *                                 same functions run in-process.
 *
 * One implementation means the DuckDuckGo scrape, the SSRF guard and the
 * HTML-to-text reducer cannot drift between platforms.
 */

export const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36';

export async function searchTavily(query, maxResults, apiKey) {
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

export async function searchDuckDuckGo(query, maxResults) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': SEARCH_UA,
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

export async function searchWikipedia(query, maxResults) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*' +
    `&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults}`;
  const res = await fetch(url, { headers: { 'User-Agent': SEARCH_UA } });
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

/** Reject loopback / RFC1918 / link-local hosts before we fetch them. */
export function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h) || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  return false;
}

export function htmlToText(html) {
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

export function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function decodeEntities(s) {
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
export function decodeDdgUrl(href) {
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

/**
 * Fetch a page and reduce it to readable text.
 * Returns { url, text } or { url, error } — a dead link must never sink a run.
 */
export async function readPageText(rawUrl, maxChars = 12000) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: String(rawUrl), error: 'Invalid url' };
  }
  // Only public web schemes — never let a crafted "source" pull an internal
  // address through our server (SSRF).
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { url: url.toString(), error: 'Only http(s) URLs may be fetched' };
  }
  if (isPrivateHost(url.hostname)) {
    return { url: url.toString(), error: 'Refusing to fetch a private/internal address' };
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': SEARCH_UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) return { url: url.toString(), error: `HTTP ${res.status}` };

    const type = res.headers.get('content-type') || '';
    if (!type.includes('html') && !type.includes('text')) {
      return { url: url.toString(), text: '', note: `Skipped ${type}` };
    }
    const html = await res.text();
    return { url: url.toString(), text: htmlToText(html).slice(0, maxChars) };
  } catch (err) {
    return { url: url.toString(), error: err.message };
  }
}

/**
 * Provider ladder: Tavily (best, needs a key) -> DuckDuckGo (keyless scrape,
 * best-effort) -> Wikipedia (keyless, always up). Returns the first rung that
 * actually produced results, plus the attempts that failed.
 */
export async function searchWeb(query, maxResults = 5, tavilyKey) {
  const attempts = [];

  if (tavilyKey) {
    try {
      const r = await searchTavily(query, maxResults, tavilyKey);
      if (r.results.length) return { ...r, provider: 'tavily' };
      attempts.push('tavily: no results');
    } catch (err) {
      attempts.push(`tavily: ${err.message}`);
    }
  }

  try {
    const r = await searchDuckDuckGo(query, maxResults);
    if (r.results.length) return { ...r, provider: 'duckduckgo' };
    attempts.push('duckduckgo: no results');
  } catch (err) {
    attempts.push(`duckduckgo: ${err.message}`);
  }

  try {
    const r = await searchWikipedia(query, maxResults);
    if (r.results.length) return { ...r, provider: 'wikipedia' };
    attempts.push('wikipedia: no results');
  } catch (err) {
    attempts.push(`wikipedia: ${err.message}`);
  }

  return { query, answer: '', results: [], provider: 'none', attempts };
}
