/**
 * seerr-guard's decisions, and nothing else.
 *
 * Everything here is a pure function of its arguments: no network, no disk,
 * no clock. guard.mjs does the proxying and the lookups and asks this file what
 * to do, which is what lets every rule below be tested without a Seerr to talk
 * to - and a filter that decides what children can see is not something to
 * test by clicking around.
 *
 * The rules mirror the per-user filter that used to live inside a Seerr fork
 * (github.com/furkanturkmen/seerr, feat/per-user-content-filters), rebuilt to
 * sit in front of stock Seerr instead of inside it.
 */

/** Seerr's permission bits (server/lib/permissions.ts). ADMIN implies all. */
export const PERMISSION = Object.freeze({ ADMIN: 2, MANAGE_SETTINGS: 4, MANAGE_USERS: 8, REQUEST: 32 });

export const hasPermission = (permissions, bit) => {
  const p = Number(permissions) | 0;
  return (p & PERMISSION.ADMIN) !== 0 || (p & bit) !== 0;
};

/**
 * Whether an account can change Seerr itself: its settings (which hold every
 * API key), or other people's accounts. Managing requests is not enough to
 * count - that is day-to-day use.
 */
export const isPrivileged = (permissions) => {
  const p = Number(permissions) | 0;
  return (p & (PERMISSION.ADMIN | PERMISSION.MANAGE_SETTINGS | PERMISSION.MANAGE_USERS)) !== 0;
};

const MEDIA_TYPES = new Set(['movie', 'tv']);

/** `movie:603`. The media type is part of the key: a TMDB id is not unique across types. */
export const keyOf = (mediaType, tmdbId) => `${mediaType}:${tmdbId}`;

/**
 * Keyword ids from whatever shape they arrive in.
 *
 * The fork stored a JSON array of strings, spoke a comma list over its API,
 * and the store holds integers. Zero and junk are dropped: `Number('')` is 0,
 * passes Number.isInteger, and would otherwise travel around as keyword zero.
 */
export function parseIds(raw) {
  let values = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('[')) {
      try {
        values = JSON.parse(text);
      } catch {
        values = [];
      }
    } else {
      values = text.split(',');
    }
  }
  if (!Array.isArray(values)) return [];
  const ids = new Set();
  for (const v of values) {
    const n = Number(typeof v === 'string' ? v.trim() : v);
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ the store */

/**
 * Parse and check the filter store (jellylab-push-data/content-filters.json).
 *
 * Throws on anything malformed rather than guessing. The caller treats a store
 * it cannot read as "filters unavailable" and fails closed, which is the
 * point: a half-understood store must never read as "nobody is filtered".
 */
export function readStore(text) {
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object') throw new Error('store is not an object');
  if (doc.version !== 2) throw new Error(`unsupported store version ${doc.version}`);
  if (!doc.users || typeof doc.users !== 'object' || Array.isArray(doc.users)) {
    throw new Error('store.users must be an object');
  }
  const users = new Map();
  for (const [jellyfinUserId, entry] of Object.entries(doc.users)) {
    if (!entry || typeof entry !== 'object') throw new Error(`store.users.${jellyfinUserId} is not an object`);
    users.set(jellyfinUserId, {
      name: typeof entry.name === 'string' ? entry.name : '',
      blockedTags: parseIds(entry.blockedTags),
      hideAdult: entry.hideAdult === true,
    });
  }
  const adultTags = parseIds(doc.adultTags);
  let canary = null;
  if (doc.canary) {
    const c = doc.canary;
    if (!Number.isInteger(c.seerrUserId)) throw new Error('store.canary.seerrUserId must be an integer');
    canary = {
      seerrUserId: c.seerrUserId,
      blockedTags: parseIds(c.blockedTags),
      hiddenTitle: String(c.hiddenTitle ?? ''),
      cleanTitle: String(c.cleanTitle ?? ''),
      keywordId: Number(c.keywordId) || null,
    };
  }
  return { users, adultTags, canary };
}

/**
 * The filter entry that applies to one Seerr user, or null.
 *
 * People are keyed by Jellyfin user id, because Jellyfin is where the filter is
 * finally enforced. The canary is a local Seerr account with no Jellyfin side,
 * so it is matched by its Seerr id instead.
 */
export function entryForUser(store, user) {
  if (!store || !user) return null;
  if (store.canary && user.id === store.canary.seerrUserId) {
    return { name: 'canary', blockedTags: store.canary.blockedTags, hideAdult: false };
  }
  if (!user.jellyfinUserId) return null;
  return store.users.get(user.jellyfinUserId) ?? null;
}

/**
 * The keyword ids hidden from one person.
 *
 * blockedTags is what an administrator imposed. hideAdult is the person's own
 * switch, and it only ever adds: somebody allowed to see adult content can
 * still choose not to, and switching it off returns them to the
 * administrator's list rather than to nothing.
 */
export function hiddenSet(entry, adultTags) {
  const hidden = new Set(entry?.blockedTags ?? []);
  if (entry?.hideAdult) for (const id of adultTags ?? []) hidden.add(id);
  return hidden;
}

/* -------------------------------------------------------------- routing rules */

/*
 * GET routes under /api/v1 that never carry media rows. They are streamed
 * untouched even for a filtered person: buffering and re-serialising them
 * would cost time for nothing, and auth in particular must stay byte for byte.
 */
const NO_MEDIA_API = /^\/api\/v1\/(auth|settings|status|avatarproxy|region|regions|languages|genres|studio|network|keyword|backdrops|service|notification)(\/|$)/;

/**
 * What a request is, as far as the filter is concerned.
 *
 * Only the path and method are used - never the body, which has not been read
 * yet when this is asked.
 */
export function classify(method, pathname) {
  const m = method.toUpperCase();

  let match;
  if ((match = /^\/api\/v1\/user\/(\d+)\/settings\/main\/?$/.exec(pathname)) && (m === 'GET' || m === 'POST')) {
    return { kind: 'settings', seerrUserId: Number(match[1]) };
  }
  if (m === 'POST' && /^\/api\/v1\/request\/?$/.test(pathname)) return { kind: 'create-request' };
  if (m === 'POST' && /^\/api\/v1\/watchlist\/?$/.test(pathname)) return { kind: 'create-watchlist' };

  if (m !== 'GET') return { kind: 'pass' };

  if ((match = /^\/api\/v1\/(movie|tv)\/(\d+)(\/.*)?$/.exec(pathname))) {
    const sub = (match[3] ?? '').replace(/\/+$/, '');
    return { kind: 'api-title', key: keyOf(match[1], Number(match[2])), sub };
  }
  if ((match = /^\/api\/v1\/(request|issue)\/(\d+)\/?$/.exec(pathname))) {
    return { kind: 'api-single', resource: match[1] };
  }
  if (pathname.startsWith('/api/v1/')) {
    return NO_MEDIA_API.test(pathname) ? { kind: 'pass' } : { kind: 'api-list' };
  }

  // Pages. Next.js renders these on the server from an internal API call that
  // never passes through here, so the page request itself is the only point at
  // which a hidden title can be stopped.
  if ((match = /^\/(movie|tv)\/(\d+)(\/[^?]*)?$/.exec(pathname))) {
    return { kind: 'page-title', key: keyOf(match[1], Number(match[2])), data: false };
  }
  if ((match = /^\/_next\/data\/[^/]+\/(movie|tv)\/(\d+)(\/[^?]*)?\.json$/.exec(pathname))) {
    return { kind: 'page-title', key: keyOf(match[1], Number(match[2])), data: true };
  }
  if (/^\/collection\/\d+\/?$/.test(pathname)) return { kind: 'page-collection', data: false };
  if (/^\/_next\/data\/[^/]+\/collection\/\d+\.json$/.test(pathname)) return { kind: 'page-collection', data: true };

  return { kind: 'pass' };
}

/* ---------------------------------------------------------------- media rows */

/**
 * Which title one row is about, or null for a row that is not a title.
 *
 * Three shapes pass through Seerr's lists, and the order they are tried in
 * matters. A Media or watchlist row carries `tmdbId` beside an internal `id` -
 * reading `id` there would name some unrelated title. A request or issue row
 * is *about* a title and carries it as `media.tmdbId`. Only a TMDB-mapped row
 * (discover, search, credits) uses `id` for the TMDB id itself.
 */
export function rowKey(row) {
  if (!row || typeof row !== 'object') return null;
  if (MEDIA_TYPES.has(row.mediaType) && Number.isInteger(row.tmdbId)) {
    return keyOf(row.mediaType, row.tmdbId);
  }
  const media = row.media;
  if (media && typeof media === 'object' && MEDIA_TYPES.has(media.mediaType) && Number.isInteger(media.tmdbId)) {
    return keyOf(media.mediaType, media.tmdbId);
  }
  if (MEDIA_TYPES.has(row.mediaType) && Number.isInteger(row.id)) {
    return keyOf(row.mediaType, row.id);
  }
  return null;
}

/*
 * Arrays that hold title rows. `results` covers every paginated list; `parts`
 * is a collection; `cast` and `crew` are a person's combined credits. A person
 * row in search results nests more titles in `knownFor`, handled per row.
 */
const LIST_FIELDS = ['results', 'parts', 'cast', 'crew'];

/** Every title key a response mentions, for looking up the unknown ones first. */
export function collectKeys(body) {
  const keys = new Set();
  if (!body || typeof body !== 'object') return keys;
  for (const field of LIST_FIELDS) {
    if (!Array.isArray(body[field])) continue;
    for (const row of body[field]) {
      const key = rowKey(row);
      if (key) keys.add(key);
      if (Array.isArray(row?.knownFor)) {
        for (const known of row.knownFor) {
          const k = rowKey(known);
          if (k) keys.add(k);
        }
      }
    }
  }
  return keys;
}

/**
 * Remove the rows `hide(key)` says to, and nothing else.
 *
 * The counts beside a list (totalResults, totalPages) are left alone on
 * purpose: they describe Seerr's query, the pagination is TMDB's, and making
 * them agree with a filtered page would have "page 2 of 500" contradict itself.
 * A short page is the honest result.
 */
export function filterBody(body, hide) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, removed: 0 };
  let removed = 0;
  let out = body;
  for (const field of LIST_FIELDS) {
    if (!Array.isArray(body[field])) continue;
    const kept = [];
    for (const row of body[field]) {
      const key = rowKey(row);
      if (key && hide(key)) {
        removed += 1;
        continue;
      }
      if (Array.isArray(row?.knownFor)) {
        const knownFor = row.knownFor.filter((known) => {
          const k = rowKey(known);
          const drop = Boolean(k && hide(k));
          if (drop) removed += 1;
          return !drop;
        });
        kept.push(knownFor.length === row.knownFor.length ? row : { ...row, knownFor });
      } else {
        kept.push(row);
      }
    }
    if (kept.length !== body[field].length || kept.some((row, i) => row !== body[field][i])) {
      out = { ...out, [field]: kept };
    }
  }
  return { body: out, removed };
}

/** The title a single request or issue is about. */
export const singleTitleKey = (body) => rowKey(body && typeof body === 'object' ? { media: body.media } : null);

/**
 * The keyword ids on a movie or TV detail response, or null when it has none.
 *
 * Seerr asks TMDB for keywords on every detail call and maps them to
 * `keywords: [{id, name}]`. null rather than [] when the field is missing, so
 * a Seerr release that stops sending it reads as "cannot tell" - which the
 * guard fails closed on - instead of "carries no keywords".
 */
export function detailKeywords(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.keywords)) return null;
  return parseIds(body.keywords.map((k) => (k && typeof k === 'object' ? k.id : k)));
}

/**
 * A function answering "hide this title?" for one person.
 *
 * `verdicts` maps a title key to its keyword ids. A title with no verdict yet
 * is hidden when failClosed is set: for a filtered person an unchecked title is
 * treated as unsafe until it has been checked, and shows up on the next load.
 */
export function makeHider(hidden, verdicts, { failClosed = true } = {}) {
  return (key) => {
    const keywords = verdicts.get(key);
    if (!keywords) return failClosed;
    return keywords.some((id) => hidden.has(id));
  };
}

/* ------------------------------------------------------------ Next.js payloads */

/** Filter the parts of a collection page's server-side props. */
export function filterCollectionProps(pageProps, hide) {
  const collection = pageProps?.collection;
  if (!collection || !Array.isArray(collection.parts)) return { pageProps, removed: 0 };
  const { body, removed } = filterBody(collection, hide);
  return { pageProps: removed ? { ...pageProps, collection: body } : pageProps, removed };
}

const NEXT_DATA = /(<script id="__NEXT_DATA__" type="application\/json"[^>]*>)([\s\S]*?)(<\/script>)/;

/**
 * Rewrite the JSON a server-rendered page embeds for hydration.
 *
 * `fn` receives the parsed object and returns a replacement. `<` is escaped on
 * the way back in, the way Next.js does it, so a title containing `</script>`
 * cannot end the tag early. Returns the html unchanged when there is no such
 * block or it does not parse.
 */
export function rewriteNextData(html, fn) {
  const match = NEXT_DATA.exec(html);
  if (!match) return { html, changed: false };
  let data;
  try {
    data = JSON.parse(match[2]);
  } catch {
    return { html, changed: false };
  }
  const next = fn(data);
  if (next === data) return { html, changed: false };
  const json = JSON.stringify(next).replace(/</g, '\\u003c');
  return { html: html.replace(NEXT_DATA, () => `${match[1]}${json}${match[3]}`), changed: true };
}

/** The Next.js build id a rendered page names, for building `_next/data` paths. */
export function buildIdOf(html) {
  const match = NEXT_DATA.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[2]).buildId ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------- fork API compatibility shim */

/*
 * The JellyLab app, and anything else written against the fork, reads and
 * writes these on /api/v1/user/:id/settings/main. Stock Seerr ignores them, so
 * the guard answers them from the store instead.
 */
export const FILTER_FIELDS = Object.freeze(['blockedTags', 'hideAdult', 'adultTags']);

/** Add the fork's fields to a settings response, in the fork's wire format. */
export function mergeSettings(body, entry, adultTags) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...body,
    blockedTags: (entry?.blockedTags ?? []).join(','),
    hideAdult: entry?.hideAdult === true,
    adultTags: (adultTags ?? []).join(','),
  };
}

/**
 * Split a settings POST into what Seerr should see and what the store should.
 *
 * A field left out means "keep what is stored", as it did in the fork. adultTags
 * is read-only and is dropped on the way in.
 */
export function splitSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { forward: body, wants: {} };
  const forward = { ...body };
  const wants = {};
  if ('blockedTags' in forward) wants.blockedTags = parseIds(forward.blockedTags);
  if ('hideAdult' in forward) wants.hideAdult = forward.hideAdult === true;
  for (const field of FILTER_FIELDS) delete forward[field];
  return { forward, wants };
}

/**
 * Which of the wanted changes this caller may make.
 *
 * The fork's rules. blockedTags is imposed on a person, so only someone who may
 * manage users can set it - anyone else's value is ignored rather than
 * refused, which is what the fork did. hideAdult is the person's own switch:
 * theirs to flip, or an administrator's. Seerr has already refused the request
 * outright if the caller may not touch this profile at all.
 */
export function allowedChanges({ actor, subjectId, wants }) {
  const apply = {};
  const ignored = [];
  const manager = hasPermission(actor?.permissions, PERMISSION.MANAGE_USERS);
  if ('blockedTags' in wants) {
    if (manager) apply.blockedTags = wants.blockedTags;
    else ignored.push('blockedTags');
  }
  if ('hideAdult' in wants) {
    if (manager || actor?.id === subjectId) apply.hideAdult = wants.hideAdult;
    else ignored.push('hideAdult');
  }
  return { apply, ignored };
}

/* ------------------------------------------------------------------- network */

/** IPv4 address to an unsigned 32-bit number, or null. */
function ipv4(addr) {
  const parts = String(addr ?? '').replace(/^::ffff:/, '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

/** Parse `172.18.0.0/16,127.0.0.1/32` into matchable ranges. Bad entries are dropped. */
export function parseCidrs(text) {
  const ranges = [];
  for (const raw of String(text ?? '').split(',')) {
    const [base, bitsText = '32'] = raw.trim().split('/');
    const start = ipv4(base);
    const bits = Number(bitsText);
    if (start === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const size = 2 ** (32 - bits);
    const first = start - (start % size);
    ranges.push({ first, last: first + size - 1 });
  }
  return ranges;
}

/**
 * Whether a connection comes straight from an allowed internal network.
 *
 * For the internal endpoints (canary, decide). The ranges are explicit - the
 * default Docker network and loopback - rather than "anything private": the
 * relay network is private too, and tunnel traffic must never qualify. A
 * proxied request always carries X-Forwarded-For, and a LAN client on the
 * published port arrives with its own LAN address, so neither passes.
 */
export function isInternalPeer(remoteAddress, headers, ranges) {
  if (headers?.['x-forwarded-for']) return false;
  return addressIn(remoteAddress, ranges);
}

/** Whether an address falls in any of the ranges. `::1` counts as loopback. */
export function addressIn(address, ranges) {
  if (String(address ?? '') === '::1') return (ranges ?? []).some((r) => r.first <= 2130706433 && r.last >= 2130706433);
  const n = ipv4(address);
  if (n === null) return false;
  return (ranges ?? []).some((r) => n >= r.first && n <= r.last);
}

/**
 * Whether a request reached us through the public relay.
 *
 * Tunnel traffic arrives at npm from the relay network, and npm appends that
 * address to X-Forwarded-For before passing the request on. Only the LAST
 * entry is trusted, and only when the request came from inside the Docker
 * network (npm): everything to the left of it is whatever the visitor sent,
 * and a visitor could claim anything there.
 */
export function viaRelay(remoteAddress, headers, internalRanges, relayRanges) {
  if (!(relayRanges ?? []).length) return false;
  const xff = String(headers?.['x-forwarded-for'] ?? '').trim();
  if (!xff) return false;
  if (!addressIn(remoteAddress, internalRanges)) return false;
  const last = xff.split(',').pop().trim();
  return addressIn(last, relayRanges);
}
