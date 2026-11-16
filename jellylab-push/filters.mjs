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
 * The tag stamped on a library item for one hidden keyword: the keyword's own
 * name, as TMDB writes it ("ecchi", "erotic film"), so a title page and a
 * person's blocked list read as words. A keyword TMDB no longer names is
 * written as "keyword <id>".
 *
 * Earlier versions wrote `jellylab:kw:<id>`, which was exact but unreadable.
 * The name works as well: the sync rewrites the titles and the blocked lists
 * together, from the same names, in the same run.
 */
export const tagFor = (keywordId, names) => {
  const name = names?.[keywordId];
  return name && name !== String(keywordId) ? asTag(name) : `keyword ${keywordId}`;
};

/*
 * A keyword name made safe as a Jellyfin tag. Jellyfin splits a blocked-tag
 * entry at commas and pipes, so a TMDB keyword named like "sex, love" became
 * the blocked words "sex" and "love" - and hid every title tagged "love".
 * Separators become spaces; the title and the blocked list get the same text.
 */
export const asTag = (name) => String(name).replace(/[,|]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Tags from earlier versions, cleared wherever they are found. `jellylab:kw:`
 * markers, and before them `jellylab:f1788…` named after a filter: the bare
 * prefix catches both.
 */
const MARKER_PREFIX = 'jellylab:';

/**
 * What the sync itself added, since a plain word has no prefix to recognise
 * it by: per item the tags it stamped, per person the blocked entries it
 * manages. Only those are ever removed again. A tag the title already had from
 * its metadata, or an entry an administrator typed into Jellyfin, is never
 * touched - unless it is the same word the sync manages for that person, in
 * which case it is managed from then on.
 */
const STAMPS = process.env.FILTER_STAMPS_PATH || '/data/filter-stamps.json';

async function loadStamps() {
  try {
    const doc = JSON.parse(await readFile(STAMPS, 'utf8'));
    return { items: doc.items ?? {}, users: doc.users ?? {} };
  } catch (e) {
    // Missing is the first run. Unreadable is not guessed at: a wrong record
    // could remove tags the sync never added.
    if (e.code !== 'ENOENT') throw e;
    return { items: {}, users: {} };
  }
}

async function saveStamps(stamps) {
  await mkdir(dirname(STAMPS), { recursive: true });
  const tmp = `${STAMPS}.tmp`;
  await writeFile(tmp, JSON.stringify(stamps, null, 1), 'utf8');
  await rename(tmp, STAMPS);
}

const lower = (t) => String(t).toLowerCase();

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
/*
 * "Sexual content", the backup verdict. Not a TMDB keyword: a title gets it
 * when AniList marks it adult or files it under Hentai or Ecchi, when
 * MyAnimeList rates it Rx or R+, or when TMDB marks it adult. It travels
 * through the store like a keyword so a person can be given it the same way;
 * the number is far above any TMDB keyword id, so it can never mean one.
 */
export const SEXUAL_CONTENT = 999999999;
export const SEXUAL_CONTENT_NAME = 'sexual content';

const isIdList = (v) => Array.isArray(v) && v.every(t => Number.isInteger(t) && t > 0);

export function validateContent(doc) {
  if (!doc || typeof doc !== 'object') return 'store must be an object';
  // Keywords whose word also blocks every tag and keyword containing it, and
  // what the sync found each one to contain.
  if ('broadTags' in doc && !isIdList(doc.broadTags)) return 'broadTags must be positive integers';
  if ('expansions' in doc) {
    if (!doc.expansions || typeof doc.expansions !== 'object' || Array.isArray(doc.expansions)) return 'expansions must be an object';
    for (const [id, x] of Object.entries(doc.expansions)) {
      if (!x || !isIdList(x.ids) || !Array.isArray(x.words) || x.words.some(w => typeof w !== 'string')) return `expansions.${id} is malformed`;
    }
  }
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

/** Save a whole new store, in the same queue as a person's change. */
function writeContent(change) {
  const run = contentWrites.then(async () => {
    const doc = change(await loadContent());
    const problem = validateContent(doc);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    await mkdir(dirname(CONTENT_STORE), { recursive: true });
    const tmp = `${CONTENT_STORE}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
    await rename(tmp, CONTENT_STORE);
    return doc;
  });
  contentWrites = run.catch(() => {});
  return run;
}

/** Which keywords are broad: their word also blocks tags and keywords containing it. */
export function setBroadTags(ids) {
  return writeContent(doc => ({ ...doc, broadTags: parseIds(ids) }));
}

/**
 * The keyword ids hidden from one person, with what their broad keywords
 * expand to.
 *
 * blockedTags is what an administrator imposed. hideAdult is the person's own
 * switch and only ever adds, so switching it off returns them to the
 * administrator's list rather than to nothing.
 */
export function hiddenIdsFor(doc, jellyfinUserId) {
  const entry = doc.users[jellyfinUserId];
  if (!entry) return [];
  const own = parseIds([...entry.blockedTags, ...(entry.hideAdult ? doc.adultTags : [])]);
  return parseIds([...own, ...own.flatMap(id => doc.expansions?.[id]?.ids ?? [])]);
}

/** Library tags a person's broad keywords expand to (words that are not TMDB keywords). */
export function expandedWordsFor(doc, jellyfinUserId) {
  const entry = doc.users[jellyfinUserId];
  if (!entry) return [];
  const own = parseIds([...entry.blockedTags, ...(entry.hideAdult ? doc.adultTags : [])]);
  return [...new Set(own.flatMap(id => doc.expansions?.[id]?.words ?? []))];
}

/** Whether `tag` contains `word` as whole words: "Female Harem" contains "harem", "harems" does not. */
export function containsWord(tag, word) {
  const w = String(word).trim().toLowerCase();
  if (!w) return false;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(String(tag));
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
  // `a` marks an entry that also looked at TMDB's adult flag; older ones did not.
  if (hit && hit.a && Date.now() - hit.at < (hit.ttl ?? 30 * DAY)) return hit.k;
  try {
    const body = await seerr(`/${mediaType}/${tmdbId}`);
    if (!Array.isArray(body.keywords)) throw new Error(`jellyseerr /${mediaType}/${tmdbId} has no keywords field`);
    // TMDB's adult flag counts as sexual content, carried like a keyword.
    const k = parseIds([...body.keywords.map(kw => kw?.id), ...(body.adult === true ? [SEXUAL_CONTENT] : [])]);
    cache.set(key, { k, a: 1, at: Date.now(), ttl: 30 * DAY });
    keywordCacheDirty = true;
    return k;
  } catch (e) {
    if (e.status === 404) {
      cache.set(key, { k: [], a: 1, at: Date.now(), ttl: DAY });
      keywordCacheDirty = true;
      return [];
    }
    // A stale answer beats none while Seerr is having a moment.
    if (hit) return hit.k;
    throw e;
  }
}

/* --------------------------------------- sexual content: AniList and MyAnimeList */

/*
 * The backup verdict for anime. AniList is official and free; it is asked for
 * fifty titles at a time. MyAnimeList's rating comes through Jikan, a free
 * volunteer-run mirror that is sometimes down: the first time it does not
 * answer in a run, it is left out for the rest of that run instead of waiting
 * on it title after title. A source that cannot answer adds nothing - the
 * keywords still apply - so this only ever hides more.
 *
 * Kept for 30 days. A MyAnimeList answer that could not be had is not kept, so
 * it is asked again next run.
 */
const SEXUAL_CACHE = process.env.SEXUAL_CACHE_PATH || '/data/sexual-content.json';
const ANILIST_URL = process.env.ANILIST_URL || 'https://graphql.anilist.co';
const JIKAN_URL = process.env.JIKAN_URL || 'https://api.jikan.moe/v4';
// MyAnimeList's own API, with a free Client ID (myanimelist.net/apiconfig).
// Asked first when set; Jikan is the fallback.
const MAL_URL = process.env.MAL_URL || 'https://api.myanimelist.net/v2';
const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID || '';

/** A MyAnimeList rating, from the official API if it can, else from Jikan. */
async function malRating(idMal, down) {
  if (MAL_CLIENT_ID && !down.official) {
    try {
      const res = await fetch(`${MAL_URL}/anime/${idMal}?fields=rating`, {
        headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`myanimelist answered ${res.status}`);
      return (await res.json())?.rating ?? null;
    } catch {
      down.official = true;
    }
  }
  if (down.jikan) throw new Error('no MyAnimeList source answering');
  try {
    const res = await fetch(`${JIKAN_URL}/anime/${idMal}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`jikan answered ${res.status}`);
    return (await res.json())?.data?.rating ?? null;
  } catch (e) {
    down.jikan = true;
    throw e;
  }
}

/*
 * AniList tags that count, from what strength (the share of AniList voters who
 * agree the tag applies). Decided by the household on 2026-11-16: rape, incest
 * and prostitution at any strength, nudity from 50% - below that it is on half
 * the mainstream action anime there are.
 */
export const SEXUAL_TAGS = [
  { name: 'Rape', from: 0 },
  { name: 'Incest', from: 0 },
  { name: 'Prostitution', from: 0 },
  { name: 'Nudity', from: 50 },
];

/** Whether a source's answer means sexual content. */
export function sexualFrom({ anilist, malRating }) {
  const why = [];
  if (anilist?.isAdult) why.push('AniList: adult');
  for (const g of ['Hentai', 'Ecchi']) if ((anilist?.genres ?? []).includes(g)) why.push(`AniList: ${g}`);
  for (const rule of SEXUAL_TAGS) {
    const tag = (anilist?.tags ?? []).find(t => t.name === rule.name);
    if (tag && (tag.rank ?? 0) >= rule.from) why.push(`AniList: ${tag.name} ${tag.rank}%`);
  }
  // "Rx - Hentai" from Jikan, "rx" from the official API; likewise R+.
  const rating = String(malRating ?? '');
  if (/^rx\b/i.test(rating)) why.push('MyAnimeList: Rx (hentai)');
  if (/^r\+/i.test(rating)) why.push('MyAnimeList: R+ (mild nudity)');
  return why;
}

async function loadSexualCache() {
  try {
    const doc = JSON.parse(await readFile(SEXUAL_CACHE, 'utf8'));
    return { anilist: doc.anilist ?? {}, mal: doc.mal ?? {}, links: doc.links ?? {} };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { anilist: {}, mal: {}, links: {} };
  }
}

async function saveSexualCache(cache) {
  await mkdir(dirname(SEXUAL_CACHE), { recursive: true });
  const tmp = `${SEXUAL_CACHE}.tmp`;
  await writeFile(tmp, JSON.stringify(cache), 'utf8');
  await rename(tmp, SEXUAL_CACHE);
}

const fresh = (entry) => entry && Date.now() - entry.at < 30 * DAY;

/*
 * One sexual-content lookup at a time. seerr-guard asks about every anime on a
 * search page at once; each lookup reads, changes and rewrites the same cache
 * file, and side by side they wrote over each other's file and failed.
 */
let sexualQueue = Promise.resolve();
function oneAtATime(fn) {
  const run = sexualQueue.then(fn);
  sexualQueue = run.catch(() => {});
  return run;
}
// An AniList entry saved before tags were kept is asked again.
const freshAniList = (entry) => fresh(entry) && Array.isArray(entry.tags);

const ANIME_KEYWORD = 210024;
const plain = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The AniList entry for an anime Jellyfin never linked - an anime film in the
 * Movies library has no AniList id, only the Anime library gets them. Found by
 * title and year, and only taken when exactly one AniList entry matches both:
 * a wrong link would judge one title by another's tags. Kept for 30 days,
 * a miss included.
 */
export function linkAniList(title, year) {
  return oneAtATime(() => linkAniListNow(title, year));
}

async function linkAniListNow(title, year) {
  const cache = await loadSexualCache();
  cache.links ??= {};
  const key = `${plain(title)}:${year ?? ''}`;
  if (fresh(cache.links[key])) return cache.links[key].id;
  let id = null;
  try {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        query: 'query($q:String){Page(perPage:10){media(search:$q,type:ANIME){id startDate{year} title{romaji english native}}}}',
        variables: { q: String(title) },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`anilist answered ${res.status}`);
    const found = ((await res.json())?.data?.Page?.media ?? []).filter(m =>
      m.startDate?.year === year && Object.values(m.title ?? {}).some(t => t && plain(t) === plain(title)));
    if (found.length === 1) id = found[0].id;
  } catch {
    return null; // not kept: asked again next run
  }
  cache.links[key] = { id, at: Date.now() };
  await saveSexualCache(cache).catch(() => {});
  return id;
}

/**
 * The verdict for one anime by name and year, for seerr-guard: an anime that
 * is not in the library yet has no AniList link, so it is found the same way
 * as an anime film in the Movies library. The original title is tried too,
 * since AniList may only know the Japanese one. { anilist, why } - anilist is
 * null when AniList has no single match, and then there is nothing to judge.
 */
export async function sexualVerdictFor({ title, originalTitle, year }) {
  let id = null;
  for (const t of [title, originalTitle]) {
    if (t && !id) id = await linkAniList(t, year);
  }
  if (!id) return { anilist: null, why: [] };
  const verdicts = await sexualVerdicts([id]);
  return { anilist: id, why: verdicts.get(id) ?? [] };
}

/**
 * AniList ids -> reasons a title is sexual content ([] when it is not, absent
 * when nothing could be learned about it).
 */
function sexualVerdicts(anilistIds) {
  return oneAtATime(() => sexualVerdictsNow(anilistIds));
}

async function sexualVerdictsNow(anilistIds) {
  const cache = await loadSexualCache();
  const ids = [...new Set(anilistIds)];
  const missing = ids.filter(id => !freshAniList(cache.anilist[id]));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    try {
      const res = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: 'query($ids:[Int]){Page(perPage:50){media(id_in:$ids){id isAdult genres idMal tags{name rank}}}}',
          variables: { ids: batch },
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`anilist answered ${res.status}`);
      for (const m of (await res.json())?.data?.Page?.media ?? []) {
        const tags = (m.tags ?? []).filter(t => SEXUAL_TAGS.some(r => r.name === t.name)).map(t => ({ name: t.name, rank: t.rank }));
        cache.anilist[m.id] = { isAdult: m.isAdult === true, genres: m.genres ?? [], idMal: m.idMal ?? null, tags, at: Date.now() };
      }
    } catch {
      break; // keep what is known; the rest is asked next run
    }
  }
  // A source that fails once is left out for the rest of this run.
  const down = { official: false, jikan: false };
  for (const id of ids) {
    const idMal = cache.anilist[id]?.idMal;
    if (!idMal || fresh(cache.mal[idMal])) continue;
    try {
      cache.mal[idMal] = { rating: await malRating(idMal, down), at: Date.now() };
      await new Promise(r => setTimeout(r, 400)); // both allow about three a second
    } catch {
      if (down.jikan && (down.official || !MAL_CLIENT_ID)) break;
    }
  }
  await saveSexualCache(cache).catch(() => {});
  const out = new Map();
  for (const id of ids) {
    const anilist = cache.anilist[id];
    if (!anilist) continue;
    out.set(id, sexualFrom({ anilist, malRating: cache.mal[anilist.idMal]?.rating }));
  }
  return out;
}

/* ------------------------------------------------- broad keywords, expanded */

/**
 * What a broad keyword's word reaches: TMDB keywords whose name contains it
 * (found through Seerr's keyword search) and library tags that contain it.
 */
async function expandWord(word, libraryTags) {
  const ids = [];
  // Seerr passes TMDB's paging on as `total_pages`. Up to 50 pages (1000
  // keywords), far more than any word on the lists reaches.
  for (let page = 1; page <= 50; page++) {
    const body = await seerr(`/search/keyword?query=${encodeURIComponent(word)}&page=${page}`);
    for (const k of body.results ?? []) {
      if (Number.isInteger(k?.id) && typeof k.name === 'string' && containsWord(k.name, word)) {
        ids.push(k.id);
        keywordNameCache.set(k.id, k.name);
      }
    }
    if (!(body.results ?? []).length || page >= (body.total_pages ?? body.totalPages ?? 1)) break;
  }
  const words = libraryTags.filter(t => containsWord(t, word) && t.toLowerCase() !== word.toLowerCase());
  return { ids: parseIds(ids), words: [...new Set(words)].sort() };
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
 * library this asks which TMDB keywords it carries, makes sure the title has a
 * tag with the name of each keyword anybody is hidden from, and puts the names
 * of each person's own keywords in their Jellyfin BlockedTags. Jellyfin then
 * hides those titles - and their seasons and episodes, which it judges by the
 * series - from that person in every client, whatever app they use.
 *
 * A title whose metadata already has the word ("ecchi" from AniDB, say) is
 * left as it is: the word is there, and blocking it hides the title. Blocking
 * by word also hides a title some other source tagged with that word, which
 * only ever hides more, never less.
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

  let doc = await loadContent();
  const stamps = await loadStamps();

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
    const managed = new Set((stamps.users[admin.Id] ?? []).map(lower));
    const ours = (t) => String(t).startsWith(MARKER_PREFIX) || managed.has(lower(t));
    if (!blocked.some(ours)) return;
    const keep = blocked.filter(t => !ours(t));
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
  // Jellyfin returns collections (BoxSet) for this query too, whatever
  // IncludeItemTypes says. Their TMDB id is a collection id, which Seerr's movie
  // endpoint answers with an error, so they are left out rather than counted as
  // a failed lookup on every run.
  const library = (items.Items ?? [])
    .filter(item => item.Type === 'Movie' || item.Type === 'Series')
    .map(item => ({ item, tmdbId: Number(item.ProviderIds?.Tmdb), mediaType: item.Type === 'Series' ? 'tv' : 'movie' }))
    .filter(x => Number.isInteger(x.tmdbId) && x.tmdbId > 0);

  /*
   * Broad keywords in use, expanded: the TMDB keywords and library tags that
   * contain their word. Worked out every run, because the library's tags
   * change, and saved in the store so seerr-guard hides the same keywords. A
   * search that fails stops the run: an expansion half worked out would
   * unblock whatever it dropped.
   */
  const ownIds = new Set(Object.keys(doc.users).flatMap(id => parseIds([
    ...doc.users[id].blockedTags, ...(doc.users[id].hideAdult ? doc.adultTags : []),
  ])));
  const broadInUse = (doc.broadTags ?? []).filter(id => ownIds.has(id) && id !== SEXUAL_CONTENT);
  const libraryTags = [...new Set((items.Items ?? []).flatMap(i => i.Tags ?? []).filter(t => !String(t).startsWith(MARKER_PREFIX)))];
  const broadNames = await keywordNames(broadInUse);
  const expansions = {};
  for (const id of broadInUse) {
    if (!(id in broadNames)) throw Object.assign(new Error(`keyword name unavailable for ${id}`), { status: 503 });
    expansions[id] = await expandWord(broadNames[id], libraryTags);
  }
  if (JSON.stringify(expansions) !== JSON.stringify(doc.expansions ?? {})) {
    doc = await writeContent(d => ({ ...d, expansions }));
  }

  const byJellyfinId = new Map(Object.keys(doc.users).map(id => [id, hiddenIdsFor(doc, id)]));
  const union = new Set([...byJellyfinId.values()].flat());
  const people = Object.entries(doc.users).map(([id, entry]) => ({ user: entry.name || id, keywords: byJellyfinId.get(id) }));

  // Every keyword's name, or no sync at all: a name that failed to load would
  // turn into "keyword <id>" for one run and back, unhiding nothing but
  // rewriting every title and blocked list twice.
  const names = await keywordNames([...union]);
  const unnamed = [...union].filter(id => !(id in names));
  if (unnamed.length) {
    throw Object.assign(new Error(`keyword names unavailable for ${unnamed.join(', ')}`), { status: 503 });
  }
  const tagOf = (id) => tagFor(id, names);

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

  // The backup verdict, only while somebody hides sexual content: an anime
  // AniList or MyAnimeList calls sexual gets it like a keyword.
  const sexual = [];
  if (union.has(SEXUAL_CONTENT)) {
    const anilistOf = new Map(library
      .map(({ item }) => [item.Id, Number(item.ProviderIds?.AniList)])
      .filter(([, a]) => Number.isInteger(a) && a > 0));
    // Anime Jellyfin did not link to AniList (anime films in the Movies
    // library): TMDB calls them anime, so AniList is asked by title and year.
    for (const { item } of library) {
      if (anilistOf.has(item.Id) || !(keywordsOf.get(item.Id) ?? []).includes(ANIME_KEYWORD)) continue;
      const a = await linkAniList(item.Name, item.ProductionYear);
      if (a) anilistOf.set(item.Id, a);
    }
    const verdicts = await sexualVerdicts([...anilistOf.values()]);
    for (const [itemId, a] of anilistOf) {
      const why = verdicts.get(a) ?? [];
      if (!why.length || !keywordsOf.has(itemId)) continue;
      keywordsOf.set(itemId, parseIds([...keywordsOf.get(itemId), SEXUAL_CONTENT]));
      sexual.push({ item: library.find(x => x.item.Id === itemId).item.Name, why });
    }
  }

  const stamped = [];
  const writeFailures = [];
  const cleared = [];
  for (const { item } of library) {
    const current = new Set(item.Tags ?? []);
    const has = new Set([...current].map(lower));
    const mine = new Set(stamps.items[item.Id] ?? []);
    let want;
    if (!union.size) want = new Set();
    else if (keywordsOf.has(item.Id)) want = new Set(keywordsOf.get(item.Id).filter(id => union.has(id)).map(tagOf));
    else continue; // keywords unknown: leave this item exactly as it is
    const wantLower = new Set([...want].map(lower));
    const toAdd = [...want].filter(t => !has.has(lower(t)));
    // Old markers always go; a word only when this sync added it and it is no
    // longer wanted.
    // "sexual content" comes from nowhere but this sync, so it is always its
    // own, on record or not (a run that stopped halfway leaves it unrecorded).
    const own = (t) => mine.has(t) || lower(t) === SEXUAL_CONTENT_NAME;
    const toRemove = [...current].filter(t => String(t).startsWith(MARKER_PREFIX) || (own(t) && !wantLower.has(lower(t))));
    const nowMine = [...current].filter(t => own(t) && !toRemove.includes(t)).concat(toAdd);
    const record = (tags) => {
      if (tags.length) stamps.items[item.Id] = tags;
      else delete stamps.items[item.Id];
    };
    if (!toAdd.length && !toRemove.length) {
      record(nowMine);
      continue;
    }

    // Jellyfin replaces the whole item on POST, so the full record goes back
    // with only Tags changed. The user-scoped read is the one that returns it.
    //
    // Trickplay (the scrubbing previews) is left out: Jellyfin cannot read its
    // own trickplay data back in an update and answers 500 for any title that
    // has it. It is not part of what an update changes.
    //
    // One title failing does not stop the others. The record is only updated
    // for a title whose write went through, so a failed one is tried again.
    try {
      await unfilterLibrarian();
      const { Trickplay, ...full } = await jellyfin(`/Users/${admin.Id}/Items/${item.Id}`, token);
      await jellyfin(`/Items/${item.Id}`, token, {
        method: 'POST',
        body: JSON.stringify({
          ...full,
          Tags: [...current].filter(t => !toRemove.includes(t)).concat(toAdd),
        }),
      });
    } catch (err) {
      writeFailures.push({ item: item.Name, error: err.message });
      continue;
    }
    record(nowMine);
    if (toAdd.length) stamped.push({ item: item.Name, tags: toAdd });
    if (toRemove.length) cleared.push({ item: item.Name, tags: toRemove });
  }
  // Titles no longer in the library leave no record behind.
  const inLibrary = new Set(library.map(({ item }) => item.Id));
  for (const id of Object.keys(stamps.items)) if (!inLibrary.has(id)) delete stamps.items[id];
  await saveStamps(stamps);

  /* ------------------------------------------- block the markers per user */
  const applied = [];
  for (const u of jfUsers) {
    /*
     * Administrators are not skipped. The adult switch is opt-in and set by
     * the person it affects, and an administrator who has asked for nothing
     * resolves to an empty list, which leaves their policy exactly as it was.
     */
    const markers = [...new Set([...(byJellyfinId.get(u.Id) ?? []).map(tagOf), ...expandedWordsFor(doc, u.Id)])];
    /*
     * Only what this service manages is changed: old markers, and the words it
     * put there before. Anything else an administrator blocked by hand in
     * Jellyfin is left where it is, and the age cap and unrated settings are
     * not touched at all. A hand-made entry that is the same word as one of
     * the person's keywords is merged into it, and managed from then on.
     */
    const before = (u.Policy.BlockedTags ?? []);
    // Compared without capitals, as Jellyfin compares them when hiding.
    const managed = new Set((stamps.users[u.Id] ?? []).map(lower));
    const wanted = new Set(markers.map(lower));
    const keep = before.filter(t => !String(t).startsWith(MARKER_PREFIX) && !managed.has(lower(t)) && !wanted.has(lower(t)));
    const next = [...keep, ...markers];
    if (markers.length) stamps.users[u.Id] = markers;
    else delete stamps.users[u.Id];
    if (next.slice().sort().join('|') === before.slice().sort().join('|')) continue;

    await jellyfin(`/Users/${u.Id}/Policy`, token, {
      method: 'POST',
      body: JSON.stringify({ ...u.Policy, BlockedTags: next }),
    });
    applied.push({ user: u.Name, markers });
  }
  await saveStamps(stamps);

  return { people, tags: [...union], stamped, cleared, applied, lookupFailures, library: library.length, expansions, sexual, writeFailures };
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
    if (id === SEXUAL_CONTENT) {
      out[id] = SEXUAL_CONTENT_NAME;
      return;
    }
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
