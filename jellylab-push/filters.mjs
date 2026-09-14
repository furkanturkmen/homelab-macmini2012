/**
 * Content filters: who may not see what, and making Jellyfin enforce it.
 *
 * Two generations live here. The older one - named bundles of keywords and
 * genres assigned to people (load/validate/replace/resolveFor, filters.json) -
 * is kept only because its routes still exist; nothing decides from it.
 *
 * The current one is a list of hidden TMDB keyword ids per person
 * (content-filters.json, keyed by Jellyfin user id). It is enforced twice:
 * seerr-guard reads the same file to filter Seerr, and syncContentFilters below
 * makes Jellyfin hide the same titles through per-user BlockedTags, which hold
 * in every client whatever app someone uses.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const STORE = process.env.FILTERS_PATH || '/data/filters.json';
const JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://jellyfin:8096';

const JELLYSEERR_URL = process.env.JELLYSEERR_URL || 'http://jellyseerr:5055';
const JELLYSEERR_API_KEY = process.env.JELLYSEERR_API_KEY || '';
/*
 * The per-person filter the add-on reads (seerr-guard) and this service
 * enforces in Jellyfin. See loadContent() below. Kept apart from the legacy
 * filter document above, which nothing decides from any more.
 */
const CONTENT_STORE = process.env.CONTENT_FILTERS_PATH || '/data/content-filters.json';
/** Each title's TMDB keyword ids, so a sync does not ask Seerr about the whole library every time. */
const KEYWORD_CACHE = process.env.KEYWORD_CACHE_PATH || '/data/keywords.json';

/** Assignments key meaning "everyone who is not an administrator". */
export const EVERYONE = '*';

const EMPTY = { version: 1, filters: [], assignments: {} };

export async function load() {
  try {
    const raw = await readFile(STORE, 'utf8');
    const doc = JSON.parse(raw);
    return {
      version: 1,
      filters: Array.isArray(doc.filters) ? doc.filters : [],
      assignments: doc.assignments && typeof doc.assignments === 'object' ? doc.assignments : {},
    };
  } catch (e) {
    // A missing file is the normal first run, not a fault.
    if (e.code !== 'ENOENT') throw e;
    return { ...EMPTY };
  }
}

async function save(doc) {
  await mkdir(dirname(STORE), { recursive: true });
  // Written beside and renamed: a half-written file here would silently drop
  // everyone's filters on the next read.
  const tmp = `${STORE}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
  await rename(tmp, STORE);
}

/** Reject anything that is not the shape the rest of this file assumes. */
export function validate(doc) {
  if (!doc || typeof doc !== 'object') return 'body must be an object';
  if (!Array.isArray(doc.filters)) return 'filters must be an array';
  const ids = new Set();
  for (const f of doc.filters) {
    if (!f || typeof f !== 'object') return 'each filter must be an object';
    if (typeof f.id !== 'string' || !f.id.trim()) return 'each filter needs a non-empty id';
    if (ids.has(f.id)) return `duplicate filter id: ${f.id}`;
    ids.add(f.id);
    if (typeof f.name !== 'string' || !f.name.trim()) return `filter ${f.id} needs a name`;
    if (f.keywords != null && !Array.isArray(f.keywords)) return `filter ${f.id}: keywords must be an array`;
    for (const k of f.keywords ?? []) {
      if (!k || typeof k !== 'object') return `filter ${f.id}: each keyword must be an object`;
      if (!Number.isInteger(k.id)) return `filter ${f.id}: keyword id must be an integer`;
      if (typeof k.name !== 'string' || !k.name.trim()) return `filter ${f.id}: keyword needs a name`;
    }
    if (f.genres != null && (!Array.isArray(f.genres) || f.genres.some(g => !Number.isInteger(g)))) {
      return `filter ${f.id}: genres must be integers`;
    }
    // An age, not a label. Jellyfin's own rating scale is already ages - PG-13
    // scores 13, TV-14 scores 14, R and TV-MA both score 17 - so one integer
    // covers US TV ratings, US film ratings and Kijkwijzer at once.
    if (f.maxAge != null && (!Number.isInteger(f.maxAge) || f.maxAge < 0 || f.maxAge > 21)) {
      return `filter ${f.id}: maxAge must be an integer between 0 and 21`;
    }
    if (f.blockUnrated != null && typeof f.blockUnrated !== 'boolean') {
      return `filter ${f.id}: blockUnrated must be a boolean`;
    }
  }
  if (!doc.assignments || typeof doc.assignments !== 'object') return 'assignments must be an object';
  for (const [who, list] of Object.entries(doc.assignments)) {
    if (!Array.isArray(list)) return `assignments[${who}] must be an array`;
    for (const id of list) {
      if (!ids.has(id)) return `assignments[${who}] names unknown filter ${id}`;
    }
  }
  return null;
}

export async function replace(doc) {
  const problem = validate(doc);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const clean = { version: 1, filters: doc.filters, assignments: doc.assignments };
  await save(clean);
  return clean;
}

/**
 * What applies to one person: their own filters plus everyone's.
 *
 * Returned flattened, because every consumer wants the union rather than the
 * bundles it came from.
 */
export function resolveFor(doc, jellyfinUserId) {
  const wanted = new Set([
    ...(doc.assignments[EVERYONE] ?? []),
    ...(jellyfinUserId ? doc.assignments[jellyfinUserId] ?? [] : []),
  ]);
  const keywordIds = new Set();
  const keywordNames = new Set();
  const genreIds = new Set();
  const names = [];
  // The most restrictive assigned filter wins. Two filters on one person are
  // two separate rules, and the stricter one is the one that means anything.
  let maxAge = null;
  let blockUnrated = false;
  for (const f of doc.filters) {
    if (!wanted.has(f.id)) continue;
    names.push(f.name);
    for (const k of f.keywords ?? []) {
      keywordIds.add(k.id);
      keywordNames.add(k.name);
    }
    for (const g of f.genres ?? []) genreIds.add(g);
    if (f.maxAge != null) maxAge = maxAge == null ? f.maxAge : Math.min(maxAge, f.maxAge);
    if (f.blockUnrated) blockUnrated = true;
  }
  return {
    filters: names,
    /** the filter ids themselves, which is what a stamped marker is named for */
    filterIds: [...wanted].filter(id => doc.filters.some(f => f.id === id)),
    keywordIds: [...keywordIds],
    keywordNames: [...keywordNames],
    genreIds: [...genreIds],
    maxAge,
    blockUnrated,
  };
}

/* ---------------------------------------------------------------- Jellyseerr */

async function seerr(path, init = {}) {
  const res = await fetch(`${JELLYSEERR_URL}/api/v1${path}`, {
    ...init,
    headers: { 'X-Api-Key': JELLYSEERR_API_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw Object.assign(new Error(`jellyseerr ${path} -> ${res.status}`), { status: res.status });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/* ------------------------------------------------------------------ Jellyfin */

async function jellyfin(path, token, init = {}) {
  const res = await fetch(`${JELLYFIN_URL}${path}`, {
    ...init,
    headers: {
      // Jellyfin 12 stopped reading X-Emby-Token and answers 401 to it, which
      // showed up here as "filter sync failed: jellyfin /Users: 401" while
      // everything else looked healthy. The standard Authorization header
      // carries the same token and older servers accept it too.
      Authorization: `MediaBrowser Client="jellylab-push", Device="homelab", DeviceId="jellylab-push", Version="1", Token="${token}"`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`jellyfin ${path}: ${res.status}`), { status: res.status });
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Whether the caller is a Jellyfin administrator, according to Jellyfin.
 *
 * The token is the caller's own and is never stored. Asking Jellyfin rather
 * than trusting a claim from the app is the whole point: these endpoints
 * change what other people in the house can see.
 */
/**
 * Who this token belongs to, according to Jellyfin.
 *
 * Weaker than requireAdmin on purpose: some things - sending your own logs -
 * are every user's to do, and the question is only whether the token is real.
 * A Jellyfin API key has no user behind it and answers 400 to /Users/Me, so it
 * is named for what it is rather than rejected.
 */
export async function whoAmI(token) {
  if (!token) throw Object.assign(new Error('missing X-Emby-Token'), { status: 401 });
  try {
    const me = await jellyfin('/Users/Me', token);
    if (me?.Name) return me.Name;
  } catch (e) {
    if (e.status !== 400) throw Object.assign(new Error('not a valid token'), { status: 401 });
  }
  await requireAdmin(token);
  return 'api-key';
}

export async function requireAdmin(token) {
  if (!token) throw Object.assign(new Error('missing X-Emby-Token'), { status: 401 });

  // A user token, which is what the app sends.
  try {
    const me = await jellyfin('/Users/Me', token);
    if (!me?.Policy?.IsAdministrator) {
      throw Object.assign(new Error('administrator only'), { status: 403 });
    }
    return me;
  } catch (e) {
    if (e.status === 403) throw e;
  }

  /*
   * A Jellyfin API key, which has no user behind it - /Users/Me answers 400 -
   * so it is checked by reaching an endpoint only an administrator may reach.
   * Not a weaker test: Jellyfin API keys carry administrator rights, and
   * /Auth/Keys refuses everything else. This exists so the server side can be
   * administered without a person's password.
   */
  try {
    await jellyfin('/Auth/Keys', token);
    return { Name: 'api-key', Policy: { IsAdministrator: true } };
  } catch {
    throw Object.assign(new Error('token rejected by Jellyfin'), { status: 401 });
  }
}

/* ------------------------------------------------------ per-person filters */

/**
 * The tag stamped on a library item for one hidden keyword.
 *
 * Per keyword rather than per filter: a person simply has a list of hidden
 * TMDB keyword ids, so the markers on an item say which keywords it carries.
 */
export const markerFor = (keywordId) => `jellylab:kw:${keywordId}`;

/**
 * Everything this service has ever stamped, for recognising its own work.
 *
 * Deliberately the bare prefix rather than `jellylab:kw:`. An earlier shape
 * named markers after a filter - `jellylab:f1788…` - and those have to be
 * recognised to be cleared, or they sit on the library for good.
 */
const MARKER_PREFIX = 'jellylab:';

/**
 * The keywords the adult switch stands for, from the Seerr fork's
 * server/lib/adultTags.ts. Written into the store so the guard and this
 * service read one list rather than two that can drift.
 */
export const DEFAULT_ADULT_TAGS = [256466, 155477, 195669, 198385, 356759, 341367];

/**
 * A list of keyword ids from any shape it arrives in.
 *
 * An empty string yields `Number('') === 0`, which passes Number.isInteger
 * and would be carried around as keyword zero - hence the explicit > 0.
 */
export function parseIds(raw) {
  const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return [...new Set(values.map(v => Number(typeof v === 'string' ? v.trim() : v)))]
    .filter(id => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
}

const emptyContent = () => ({ version: 2, adultTags: [...DEFAULT_ADULT_TAGS], users: {}, canary: null });

/** Reject anything that is not the shape seerr-guard parses (filter.mjs readStore). */
export function validateContent(doc) {
  if (!doc || typeof doc !== 'object') return 'store must be an object';
  if (doc.version !== 2) return 'store version must be 2';
  if (!doc.users || typeof doc.users !== 'object' || Array.isArray(doc.users)) return 'users must be an object';
  for (const [id, entry] of Object.entries(doc.users)) {
    if (!entry || typeof entry !== 'object') return `users.${id} must be an object`;
    if (!Array.isArray(entry.blockedTags) || entry.blockedTags.some(t => !Number.isInteger(t) || t <= 0)) {
      return `users.${id}.blockedTags must be positive integers`;
    }
    if (typeof entry.hideAdult !== 'boolean') return `users.${id}.hideAdult must be a boolean`;
  }
  if (!Array.isArray(doc.adultTags)) return 'adultTags must be an array';
  return null;
}

/**
 * Who may not see what, one entry per person, keyed by Jellyfin user id.
 *
 * This file is the single source of truth. seerr-guard reads it to filter
 * Seerr, and syncContentFilters below reads it to make Jellyfin hide the same
 * titles. Only this service writes it - the guard sends changes here rather
 * than touching the file - so there is exactly one writer.
 *
 * A missing file is an empty store. A file that is there and unreadable
 * throws: treating it as empty would unfilter everybody.
 */
export async function loadContent() {
  let raw;
  try {
    raw = await readFile(CONTENT_STORE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyContent();
    throw e;
  }
  const doc = JSON.parse(raw);
  const problem = validateContent(doc);
  if (problem) throw Object.assign(new Error(`content store invalid: ${problem}`), { status: 500 });
  return doc;
}

/**
 * One person's filter after a change, as a new document.
 *
 * A field left out keeps what is stored. A person left with nothing hidden is
 * removed rather than kept as an empty entry, so the store lists exactly the
 * people who are filtered.
 */
export function withPersonChange(doc, jellyfinUserId, changes) {
  const current = doc.users[jellyfinUserId] ?? { blockedTags: [], hideAdult: false };
  const next = {
    ...current,
    ...(typeof changes.name === 'string' && changes.name.trim() ? { name: changes.name.trim() } : {}),
    ...('blockedTags' in changes ? { blockedTags: parseIds(changes.blockedTags) } : {}),
    ...('hideAdult' in changes ? { hideAdult: changes.hideAdult === true } : {}),
  };
  const users = { ...doc.users };
  if (!next.blockedTags.length && !next.hideAdult) delete users[jellyfinUserId];
  else users[jellyfinUserId] = next;
  return { ...doc, users };
}

let contentWrites = Promise.resolve();

/**
 * Change one person's filter and save.
 *
 * Writes are queued one behind another: two changes arriving together would
 * otherwise both read the old file and the second would silently undo the
 * first. Written beside and renamed, so a reader never sees half a file.
 */
export function setPersonFilters(jellyfinUserId, changes) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(jellyfinUserId))) {
    return Promise.reject(Object.assign(new Error('not a Jellyfin user id'), { status: 400 }));
  }
  const run = contentWrites.then(async () => {
    const doc = withPersonChange(await loadContent(), jellyfinUserId, changes);
    const problem = validateContent(doc);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    await mkdir(dirname(CONTENT_STORE), { recursive: true });
    const tmp = `${CONTENT_STORE}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
    await rename(tmp, CONTENT_STORE);
    return doc.users[jellyfinUserId] ?? { blockedTags: [], hideAdult: false };
  });
  contentWrites = run.catch(() => {});
  return run;
}

/**
 * The keyword ids hidden from one person.
 *
 * blockedTags is what an administrator imposed. hideAdult is the person's own
 * switch and only ever adds, so switching it off returns them to the
 * administrator's list rather than to nothing.
 */
export function hiddenIdsFor(doc, jellyfinUserId) {
  const entry = doc.users[jellyfinUserId];
  if (!entry) return [];
  return parseIds([...entry.blockedTags, ...(entry.hideAdult ? doc.adultTags : [])]);
}

/* ------------------------------------------------- title keywords, cached */

const DAY = 24 * 60 * 60 * 1000;
let keywordCache = null;
let keywordCacheDirty = false;

async function keywordCacheMap() {
  if (keywordCache) return keywordCache;
  keywordCache = new Map();
  try {
    const doc = JSON.parse(await readFile(KEYWORD_CACHE, 'utf8'));
    for (const [key, v] of Object.entries(doc.entries ?? {})) {
      if (Array.isArray(v.k) && Number.isFinite(v.at)) keywordCache.set(key, v);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(new Date().toISOString(), `keyword cache unreadable, starting empty: ${e.message}`);
  }
  return keywordCache;
}

async function saveKeywordCache() {
  if (!keywordCache || !keywordCacheDirty) return;
  keywordCacheDirty = false;
  const tmp = `${KEYWORD_CACHE}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(keywordCache) }), 'utf8');
  await rename(tmp, KEYWORD_CACHE);
}

/**
 * A title's TMDB keyword ids, from Seerr's own detail endpoint.
 *
 * Seerr asks TMDB for keywords on every detail call, so this needs no TMDB key
 * of its own. Trusted for 30 days - keywords on a title almost never change -
 * and a title TMDB no longer has is remembered as keyword-free for a day.
 */
async function titleKeywords(mediaType, tmdbId) {
  const cache = await keywordCacheMap();
  const key = `${mediaType}:${tmdbId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl ?? 30 * DAY)) return hit.k;
  try {
    const body = await seerr(`/${mediaType}/${tmdbId}`);
    if (!Array.isArray(body.keywords)) throw new Error(`jellyseerr /${mediaType}/${tmdbId} has no keywords field`);
    const k = parseIds(body.keywords.map(kw => kw?.id));
    cache.set(key, { k, at: Date.now(), ttl: 30 * DAY });
    keywordCacheDirty = true;
    return k;
  } catch (e) {
    if (e.status === 404) {
      cache.set(key, { k: [], at: Date.now(), ttl: DAY });
      keywordCacheDirty = true;
      return [];
    }
    // A stale answer beats none while Seerr is having a moment.
    if (hit) return hit.k;
    throw e;
  }
}

/** Run `fn` over `items`, `limit` at a time. */
async function eachLimited(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/* ------------------------------------------------------------ the sync */

/**
 * Make Jellyfin hide, per person, what the filter store says they may not see.
 *
 * The store decides; Jellyfin enforces. For every movie and series in the
 * library this asks which TMDB keywords it carries, stamps a `jellylab:kw:<id>`
 * tag for each keyword anybody is hidden from, and puts each person's own
 * markers in their Jellyfin BlockedTags. Jellyfin then hides those items from
 * that person in every client, whatever app they use.
 *
 * This used to be derived from Seerr's global blocklist crawler in a Seerr
 * fork. Stock Seerr refuses a blocklisted title to everyone, so that crawler
 * is no longer used at all: keywords are read per title instead, which is also
 * exact where the crawler only ever indexed its first pages per keyword.
 *
 * A title whose keywords cannot be read keeps whatever markers it already
 * has. Failing to look something up must never unhide it.
 *
 * Jellyfin's own parental controls are left alone. An age cap belongs in
 * Jellyfin's user settings, where it already exists, not mirrored from here.
 */
export async function syncContentFilters(token) {
  if (!JELLYSEERR_API_KEY) {
    throw Object.assign(new Error('jellyseerr api key not configured'), { status: 503 });
  }

  const doc = await loadContent();
  const byJellyfinId = new Map(Object.keys(doc.users).map(id => [id, hiddenIdsFor(doc, id)]));
  const union = new Set([...byJellyfinId.values()].flat());
  const people = Object.entries(doc.users).map(([id, entry]) => ({ user: entry.name || id, keywords: byJellyfinId.get(id) }));

  /* ------------------------------------------ stamp the library to match */
  const jfUsers = await jellyfin('/Users', token);
  const admin = jfUsers.find(u => u?.Policy?.IsAdministrator);
  if (!admin) {
    throw Object.assign(new Error('no administrator to read the library as'), { status: 500 });
  }

  /*
   * The administrator the library is read as must not be filtered while we
   * read it.
   *
   * Stamping has to send the whole item back, and the only call that returns
   * the whole item is user scoped. So the moment that administrator's own
   * policy blocks one of our markers, the read 404s for every item already
   * carrying it and those items can never be restamped or cleared again.
   *
   * Lifted only if this run actually needs to read an item, and restored by
   * the policy pass at the end. Doing it up front cost a policy write on every
   * run, which on a ten minute timer meant that filter blinking off and on all
   * day. The in-memory copy is updated so that pass compares against what
   * Jellyfin now holds.
   */
  let librarianLifted = false;
  const unfilterLibrarian = async () => {
    if (librarianLifted) return;
    librarianLifted = true;
    const blocked = admin.Policy.BlockedTags ?? [];
    if (!blocked.some(t => String(t).startsWith(MARKER_PREFIX))) return;
    const keep = blocked.filter(t => !String(t).startsWith(MARKER_PREFIX));
    await jellyfin(`/Users/${admin.Id}/Policy`, token, {
      method: 'POST',
      body: JSON.stringify({ ...admin.Policy, BlockedTags: keep }),
    });
    admin.Policy.BlockedTags = keep;
  };

  const items = await jellyfin(
    '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Tags,ProviderIds&Limit=10000',
    token,
  );
  const library = (items.Items ?? [])
    .map(item => ({ item, tmdbId: Number(item.ProviderIds?.Tmdb), mediaType: item.Type === 'Series' ? 'tv' : 'movie' }))
    .filter(x => Number.isInteger(x.tmdbId) && x.tmdbId > 0);

  // Keywords only matter while somebody is filtered. With nobody, every
  // marker is simply cleared and Seerr is not asked about anything.
  const keywordsOf = new Map();
  let lookupFailures = 0;
  if (union.size) {
    await eachLimited(library, 4, async ({ item, tmdbId, mediaType }) => {
      try {
        keywordsOf.set(item.Id, await titleKeywords(mediaType, tmdbId));
      } catch {
        lookupFailures += 1;
      }
    });
    await saveKeywordCache().catch(() => {});
  }

  const stamped = [];
  const cleared = [];
  for (const { item } of library) {
    const current = new Set(item.Tags ?? []);
    const ours = [...current].filter(t => String(t).startsWith(MARKER_PREFIX));
    let want;
    if (!union.size) want = new Set();
    else if (keywordsOf.has(item.Id)) want = new Set(keywordsOf.get(item.Id).filter(id => union.has(id)).map(markerFor));
    else continue; // keywords unknown: leave this item exactly as it is
    const toAdd = [...want].filter(t => !current.has(t));
    const toRemove = ours.filter(t => !want.has(t));
    if (!toAdd.length && !toRemove.length) continue;

    // Jellyfin replaces the whole item on POST, so the full record goes back
    // with only Tags changed. The user-scoped read is the one that returns it.
    await unfilterLibrarian();
    const full = await jellyfin(`/Users/${admin.Id}/Items/${item.Id}`, token);
    await jellyfin(`/Items/${item.Id}`, token, {
      method: 'POST',
      body: JSON.stringify({
        ...full,
        Tags: [...current].filter(t => !toRemove.includes(t)).concat(toAdd),
      }),
    });
    if (toAdd.length) stamped.push({ item: item.Name, tags: toAdd });
    if (toRemove.length) cleared.push({ item: item.Name, tags: toRemove });
  }

  /* ------------------------------------------- block the markers per user */
  const applied = [];
  for (const u of jfUsers) {
    /*
     * Administrators are not skipped. The adult switch is opt-in and set by
     * the person it affects, and an administrator who has asked for nothing
     * resolves to an empty list, which leaves their policy exactly as it was.
     */
    const markers = (byJellyfinId.get(u.Id) ?? []).map(markerFor);
    /*
     * Only this service's markers are managed. Anything else an administrator
     * blocked by hand in Jellyfin is left where it is, and the age cap and
     * unrated settings are not touched at all.
     */
    const before = (u.Policy.BlockedTags ?? []);
    const keep = before.filter(t => !String(t).startsWith(MARKER_PREFIX));
    const next = [...new Set([...keep, ...markers])];
    if (next.slice().sort().join('|') === before.slice().sort().join('|')) continue;

    await jellyfin(`/Users/${u.Id}/Policy`, token, {
      method: 'POST',
      body: JSON.stringify({ ...u.Policy, BlockedTags: next }),
    });
    applied.push({ user: u.Name, markers });
  }

  return { people, tags: [...union], stamped, cleared, applied, lookupFailures, library: library.length };
}

/* ------------------------------------------------ for the filter page */

/** TMDB keywords matching a search, through Seerr. */
export async function searchKeywords(query) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const body = await seerr(`/search/keyword?query=${encodeURIComponent(q)}&page=1`);
  return (body.results ?? [])
    .filter(k => Number.isInteger(k?.id) && typeof k.name === 'string')
    .map(k => ({ id: k.id, name: k.name }));
}

const keywordNameCache = new Map();

/** Names for keyword ids, so the page can show "gore" rather than 6152. */
export async function keywordNames(ids) {
  const out = {};
  await eachLimited(parseIds(ids), 4, async (id) => {
    if (!keywordNameCache.has(id)) {
      try {
        const body = await seerr(`/keyword/${id}`);
        keywordNameCache.set(id, typeof body?.name === 'string' ? body.name : String(id));
      } catch {
        return;
      }
    }
    out[id] = keywordNameCache.get(id);
  });
  return out;
}

/**
 * Sign an administrator in with their Jellyfin password, for the filter page.
 *
 * Only an administrator gets a token back. Anyone else's session is ended on
 * the spot, so a correct password for an ordinary account does not leave a
 * device entry behind for nothing.
 */
export async function signInAdmin(username, password) {
  const auth = 'MediaBrowser Client="jellylab-filters", Device="filter page", DeviceId="jellylab-filters-page", Version="1"';
  const res = await fetch(`${JELLYFIN_URL}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: String(username ?? ''), Pw: String(password ?? '') }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw Object.assign(new Error('wrong name or password, or this account may not sign in from here'), { status: 401 });
  const body = await res.json();
  if (!body?.User?.Policy?.IsAdministrator) {
    await fetch(`${JELLYFIN_URL}/Sessions/Logout`, {
      method: 'POST',
      headers: { Authorization: `${auth}, Token="${body.AccessToken}"` },
    }).catch(() => {});
    throw Object.assign(new Error('administrators only'), { status: 403 });
  }
  return { token: body.AccessToken, name: body.User.Name };
}

/** Jellyfin accounts, for choosing who a filter is for. */
export async function jellyfinPeople(token) {
  const users = await jellyfin('/Users', token);
  return users.map(u => ({ id: u.Id, name: u.Name, isAdmin: Boolean(u.Policy?.IsAdministrator) }));
}
