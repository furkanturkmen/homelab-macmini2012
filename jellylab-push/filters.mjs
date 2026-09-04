/**
 * Content filters: named bundles of TMDB keywords and genres, assigned to
 * people.
 *
 * A filter carries a keyword's id *and* its name because two different systems
 * consume it. Jellyseerr's discover endpoints take TMDB keyword ids
 * (`excludeKeywords`), and Jellyfin's per-user policy takes tag strings
 * (`BlockedTags`). The library's tags come from the same TMDB metadata, so the
 * names line up - "dark fantasy" and "Gore" are already in there.
 *
 * Only the Jellyfin half is enforcement. Blocked tags are applied by the
 * server to every client, so they hold whatever the app does. Filtering
 * discover and search is the app being tidy, and a determined person can still
 * see those titles in Jellyseerr's own web UI. Nothing here should be
 * described as if it were the first kind.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const STORE = process.env.FILTERS_PATH || '/data/filters.json';
const JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://jellyfin:8096';

const JELLYSEERR_URL = process.env.JELLYSEERR_URL || 'http://jellyseerr:5055';
const JELLYSEERR_API_KEY = process.env.JELLYSEERR_API_KEY || '';
/*
 * What was last pushed into Jellyseerr's blocklist, kept apart from the filter
 * document on purpose: `replace()` rewrites that document down to
 * {version, filters, assignments} every time the app saves, so anything
 * recorded inside it would be lost on the next edit.
 */
const SEERR_STATE = process.env.SEERR_TAGS_PATH || '/data/seerr-tags.json';

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
  if (!res.ok) throw new Error(`jellyseerr ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function lastPushed() {
  try {
    const raw = await readFile(SEERR_STATE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.tags) ? parsed.tags.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ Jellyfin */

async function jellyfin(path, token, init = {}) {
  const res = await fetch(`${JELLYFIN_URL}${path}`, {
    ...init,
    headers: {
      'X-Emby-Token': token,
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

/**
 * Push every assignment into Jellyfin's per-user BlockedTags.
 *
 * This is the half that is actually enforced, so it is deliberately the whole
 * list rather than an addition: a filter removed here has to stop applying,
 * and merging would leave tags behind that nothing in the app can see or
 * remove. Administrators are skipped - the person setting the rules is not the
 * one they are for.
 */
/**
 * The tag stamped on a library item for one hidden keyword.
 *
 * Per keyword rather than per filter, because there are no filters any more:
 * a person simply has a list of hidden TMDB keyword ids, and that list lives
 * in Jellyseerr.
 */
const markerFor = (keywordId) => `jellylab:kw:${keywordId}`;

/**
 * Everything this service has ever stamped, for recognising its own work.
 *
 * Deliberately the bare prefix rather than `jellylab:kw:`. An earlier shape
 * named markers after a filter - `jellylab:f1788…` - and those have to be
 * recognised to be cleared, or they sit on the library for good.
 */
const MARKER_PREFIX = 'jellylab:';

/**
 * Make Jellyfin hide what Jellyseerr says each person may not see.
 *
 * Jellyseerr's per-user `blockedTags` is the only place any of this is
 * decided. Nothing here is stored: the global crawl list, the tags on library
 * items and every Jellyfin policy are worked out from that one field each
 * time, so removing a keyword from somebody in Jellyseerr removes it
 * everywhere and there is no second copy to put it back.
 *
 * The crawler still has to be told which keywords to index, because a title
 * can only be hidden once it is known to carry the tag - so the global list is
 * set to the union of what everybody is hidden from. That is derived, not
 * configured.
 *
 * Jellyfin's own parental controls are left alone. An age cap belongs in
 * Jellyfin's user settings, where it already exists, not mirrored from here.
 */
/**
 * A comma delimited list of keyword ids, as every side of this speaks it.
 *
 * Jellyseerr stores blocked tags as `12,34`, its settings endpoint answers
 * with the same, and both need the same defensive parse - an empty string
 * yields `Number('') === 0`, which passes Number.isInteger and would be
 * carried around as keyword zero.
 */
function parseIds(raw) {
  return String(raw ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(id => Number.isInteger(id) && id > 0);
}

export async function syncFromJellyseerr(token) {
  if (!JELLYSEERR_API_KEY) {
    throw Object.assign(new Error('jellyseerr api key not configured'), { status: 503 });
  }

  /* ---------------------------------------------- what Jellyseerr decides */
  const seerrUsers = (await seerr('/user?take=100')).results ?? [];
  const byJellyfinId = new Map();
  const union = new Set();
  const people = [];

  for (const u of seerrUsers) {
    const settings = await seerr(`/user/${u.id}/settings/main`);
    /*
     * Two sources, one list.
     *
     * blockedTags is what an administrator imposed on this person. hideAdult
     * is the person's own switch, and the fork answers with the keyword ids it
     * stands for as adultTags - so this service does not keep a second copy of
     * that list for the two to drift apart.
     *
     * Both go into the union below, and that matters more than it looks:
     * the union is what the crawler is told to index, so a switch nobody is
     * administratively filtered on still keeps its own keywords indexed. Left
     * out, the switch would hide nothing the moment it was the only thing
     * asking for those tags.
     */
    const imposed = parseIds(settings.blockedTags);
    const chosen = settings.hideAdult ? parseIds(settings.adultTags) : [];
    const ids = [...new Set([...imposed, ...chosen])];
    for (const id of ids) union.add(id);
    if (u.jellyfinUserId) byJellyfinId.set(u.jellyfinUserId, ids);
    people.push({ user: u.displayName ?? String(u.id), keywords: ids });
  }

  /* ------------------------------------- tell the crawler what to look for */
  const main = await seerr('/settings/main');
  const existing = String(main.blocklistedTags ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(id => Number.isInteger(id) && id > 0);
  const wanted = [...union];

  /* --------------------------------- which titles carry which keyword */
  const carries = new Map();
  const PAGE = 500;
  for (let skip = 0; ; skip += PAGE) {
    const res = await seerr(`/blocklist?take=${PAGE}&skip=${skip}&filter=blocklistedTags`);
    const rows = res.results ?? [];
    for (const row of rows) {
      const tags = String(row.blocklistedTags ?? '')
        .split(',')
        .map(s => Number(s.trim()))
        .filter(id => Number.isInteger(id) && id > 0);
      if (tags.length) carries.set(Number(row.tmdbId), tags);
    }
    if (rows.length < PAGE) break;
  }

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
   * carrying it and those items can never be restamped or cleared again -
   * which only shows up once an administrator uses the adult switch on
   * themselves, and then looks like the sync has stopped working.
   *
   * The markers come off here and the policy pass at the end, which runs after
   * the stamping, puts back whatever they should have. Its in-memory copy is
   * updated too: that pass compares against the policy it read at the start,
   * and left stale it would see no difference and leave them unfiltered.
   *
   * A run that dies in between leaves the administrator seeing everything
   * until the next one. That is the wrong way round to fail and the safe one.
   */
  const adminBlocked = admin.Policy.BlockedTags ?? [];
  if (adminBlocked.some(t => String(t).startsWith(MARKER_PREFIX))) {
    const keep = adminBlocked.filter(t => !String(t).startsWith(MARKER_PREFIX));
    await jellyfin(`/Users/${admin.Id}/Policy`, token, {
      method: 'POST',
      body: JSON.stringify({ ...admin.Policy, BlockedTags: keep }),
    });
    admin.Policy.BlockedTags = keep;
  }

  const items = await jellyfin(
    '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Tags,ProviderIds&Limit=5000',
    token,
  );

  const stamped = [];
  const cleared = [];
  for (const item of items.Items ?? []) {
    const tmdbId = Number(item.ProviderIds?.Tmdb);
    const tags = Number.isInteger(tmdbId) ? carries.get(tmdbId) ?? [] : [];
    const current = new Set(item.Tags ?? []);

    const want = new Set(tags.filter(id => union.has(id)).map(markerFor));
    const ours = [...current].filter(t => String(t).startsWith(MARKER_PREFIX));
    const toAdd = [...want].filter(t => !current.has(t));
    const toRemove = ours.filter(t => !want.has(t));
    if (!toAdd.length && !toRemove.length) continue;

    // Jellyfin replaces the whole item on POST, so the full record goes back
    // with only Tags changed. The user-scoped read is the one that returns it.
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
     * Administrators are no longer skipped.
     *
     * They were, so that a filter configured by mistake could not take the
     * library away from the only person able to undo it. The adult switch
     * changed that calculation: it is opt-in and set by the person it affects,
     * and skipping them meant it did nothing at all for the account most
     * likely to want it. An administrator who has asked for nothing resolves
     * to an empty marker list, which leaves their policy exactly as it was.
     */
    const ids = byJellyfinId.get(u.Id) ?? [];
    const markers = ids.map(markerFor);
    /*
     * Only this service's markers are managed. Anything else an administrator
     * blocked by hand in Jellyfin is left exactly where it is - and the age
     * cap and unrated settings are not touched at all.
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

  /*
   * The crawl goes last, on purpose.
   *
   * Its first act is to clear every tag-driven blocklist row and rebuild
   * them, so triggering it before reading that list means stamping against
   * an index that has just been emptied - which stamped nothing at all the
   * first time this ran. Stamping uses the index as it stands; the crawl then
   * refreshes it for next time.
   */
  let crawlStarted = false;
  let crawlBusy = false;
  if (wanted.slice().sort().join(',') !== existing.slice().sort().join(',')) {
    const limit = Number(main.blocklistedTagsLimit) || 50;
    if (wanted.length > limit) {
      throw Object.assign(
        new Error(`jellyseerr allows ${limit} blocklisted tags, this needs ${wanted.length}`),
        { status: 400 },
      );
    }
    await seerr('/settings/main', {
      method: 'POST',
      body: JSON.stringify({ blocklistedTags: wanted.join(',') }),
    });
    /*
     * Never while one is already running. The job reads the tag list when it
     * starts and writes it back when it finishes, so two overlapping runs end
     * with the older one's copy winning - which silently dropped two tags
     * whose titles were already indexed.
     */
    const jobs = await seerr('/settings/jobs');
    if (jobs.find(j => j.id === 'process-blocklisted-tags')?.running) {
      crawlBusy = true;
    } else {
      try {
        await seerr('/settings/jobs/process-blocklisted-tags/run', { method: 'POST' });
        crawlStarted = true;
      } catch {
        crawlStarted = false;
      }
    }
  }


  return { people, tags: wanted, crawlStarted, crawlBusy, stamped, cleared, applied };
}

