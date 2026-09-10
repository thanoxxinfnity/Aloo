/**
 * ALOO — turning "wo gaana chala do" into something a TV can actually play.
 *
 * THE PROBLEM
 * LG's YouTube app can be handed a video to play (`contentTarget`), but it
 * wants a video ID — an eleven-character string no human says out loud. So
 * between "Shape of You chala do" and a TV playing it, something has to search.
 *
 * WHY NOT THE YOUTUBE DATA API
 * It needs an API key, a Google Cloud project, and a quota that runs out. Asking
 * someone to set all that up before their TV will play a song is the kind of
 * requirement that means the feature never gets used.
 *
 * SO: THE SEARCH PAGE ITSELF
 * youtube.com/results embeds its results as JSON inside the HTML. Reading the
 * first video out of it needs no key and no account.
 *
 * The catch, stated plainly: a browser cannot do this — YouTube sends no CORS
 * header, so the fetch is blocked. It works in the APK because Capacitor patches
 * `window.fetch` onto native HTTP, which is not subject to CORS. This is
 * therefore an app-only capability, and it says so rather than failing oddly in
 * a browser tab.
 *
 * It is also scraping, so it is written to fail SOFTLY: if YouTube changes its
 * markup, the caller gets a clear "could not find it" and falls back to just
 * opening the app, rather than throwing something incomprehensible.
 */

import { isNative } from '@/lib/runtime';

/** Pull a video id straight out of anything the user might have pasted. */
export function videoIdFromUrl(text) {
  const raw = String(text || '');
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/(?:embed|shorts|live)\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (m) return m[1];
  }
  return null;
}

/**
 * Find the top video for a query.
 *
 * @param {string} query
 * @returns {Promise<{id:string, title:string}>}
 */
export async function findVideo(query) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Kya chalana hai wo to batao.');

  const pasted = videoIdFromUrl(text);
  if (pasted) return { id: pasted, title: '' };

  if (!isNative()) {
    throw new Error(
      'YouTube search sirf installed app me chalta hai — browser ko YouTube seedha padhne nahi deta.'
    );
  }

  // sp=EgIQAQ%3D%3D is YouTube's own "Videos only" filter. Without it the first
  // result is often a channel or a playlist, neither of which the TV can play.
  const url =
    'https://www.youtube.com/results?search_query='
    + encodeURIComponent(text)
    + '&sp=EgIQAQ%3D%3D';

  let html;
  try {
    const res = await fetch(url, {
      headers: {
        // Without a browser-ish agent YouTube serves a consent wall with no
        // results in it at all.
        'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
        // A DESKTOP agent on purpose, from a phone. Sent a mobile one, YouTube
        // redirects to m.youtube.com and serves its data hex-escaped
        // (\x22videoId\x22 rather than "videoId"), which is harder to read and
        // changes shape more often. The desktop page is the stable one.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
          + 'Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`YouTube ne ${res.status} bheja`);
    html = await res.text();
  } catch (err) {
    throw new Error(`YouTube search nahi ho payi — ${err.message}`);
  }

  const found = firstVideo(html);
  if (!found) {
    throw new Error(`"${text}" ke liye YouTube pe kuch mila nahi.`);
  }
  return found;
}

/**
 * Dig the first real video out of the search page.
 *
 * Two passes on purpose. `videoRenderer` is the block YouTube uses for an
 * ordinary search hit, so it is the trustworthy one; the bare `videoId` sweep
 * is a fallback for when the markup shifts, which it periodically does. Ads and
 * shelves carry other renderer names and are skipped by the first pass.
 */
function firstVideo(raw) {
  const html = unescapeHex(raw);
  const renderer = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"/.exec(html);
  if (renderer) {
    return { id: renderer[1], title: titleNear(html, renderer.index) };
  }
  const bare = /"videoId":"([A-Za-z0-9_-]{11})"/.exec(html);
  if (bare) {
    return { id: bare[1], title: titleNear(html, bare.index) };
  }
  return null;
}

/**
 * The mobile page embeds its JSON inside a JavaScript string literal, so every
 * quote arrives as \x22. Only converted when the plain form is absent, so the
 * desktop page — the normal case — is not touched at all.
 */
function unescapeHex(html) {
  if (html.includes('"videoId"') || !html.includes('\\x22videoId')) return html;
  return html.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)));
}

/** The title sits a little after the id, in a `runs` array. */
function titleNear(html, from) {
  const window = html.slice(from, from + 1200);
  const m = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(window);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}
