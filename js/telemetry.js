// Anonymous usage counts, sent to Umami Cloud (umami.is): how many people open the game, start and finish games,
// which round they leave on, and where they seem to get stuck. No names, room codes, cards or feedback text ever
// go out, and there are no cookies. Each event is one small POST sent after the page has drawn, never awaited, and
// any failure is ignored, so it can't slow the game down or break it. Setup and the event list: TELEMETRY.md.

// The website id from the Umami dashboard (Settings → Websites → Edit). Empty sends nothing.
export const UMAMI_SITE = '';
export const UMAMI_URL = 'https://cloud.umami.is/api/send';
const MAX_EVENTS = 300; // per page load, in case something goes round in a loop

// Card names in an error message ("That isn't a valid run: 5♥ 7♥") would split one problem into many rows
export function plainError(text) {
  return String(text || '')
    .replace(/\S*[♠♥♦♣]\S*|\bJokers?\b/g, '#')
    .replace(/#(\s+#)+/g, '#')
    .slice(0, 120);
}

// site: the Umami website id; post(url, body, closing) sends it; page() gives the page fields Umami wants
export function makeTracker({ site, url = UMAMI_URL, enabled = true, id, version, post, page, defer = (fn) => fn() }) {
  let sent = 0;
  const on = !!(site && enabled);
  function send(name, data, closing = false) {
    if (!on || sent >= MAX_EVENTS) return false;
    sent++;
    const payload = { website: site, ...page() };
    if (id) payload.id = id;
    if (name) payload.name = name;
    if (name) payload.data = { version: version || 'local', ...data };
    const body = JSON.stringify({ type: 'event', payload });
    const go = () => {
      try {
        Promise.resolve(post(url, body, closing)).catch(() => {});
      } catch {}
    };
    if (closing) go();
    else defer(go);
    return true;
  }
  return {
    enabled: on,
    pageView: () => send(null),
    track: (name, data = {}) => send(name, data),
    // for the page closing: goes out at once (keepalive lets it finish after the page is gone)
    trackNow: (name, data = {}) => send(name, data, true),
  };
}

export function browserTracker({ version, off }) {
  let id = null;
  try {
    id = localStorage.getItem('shanghai.statsId');
    if (!id) localStorage.setItem('shanghai.statsId', (id = Math.random().toString(36).slice(2) + Date.now().toString(36)));
  } catch {}
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname) || location.protocol === 'file:';
  return makeTracker({
    site: UMAMI_SITE,
    enabled: !local && !off,
    id,
    version,
    page: () => ({
      hostname: location.hostname,
      url: location.pathname, // never the query, which can hold a room code
      title: document.title,
      language: navigator.language,
      screen: `${screen.width}x${screen.height}`,
      referrer: document.referrer && new URL(document.referrer).origin !== location.origin ? document.referrer : '',
    }),
    post: (url, body) => fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json' } }),
    defer: (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 200)),
  });
}
