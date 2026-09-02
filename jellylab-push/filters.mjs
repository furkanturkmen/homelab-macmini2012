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

/**
 * Push each person's filters into Jellyseerr, per user.
 *
 * Jellyseerr upstream has no per-user content filtering at all - its blocklist
 * is global and not one of its thirty permissions describes content - so this
 * used to be able to mirror only the everyone-filter, and even that took the
 * library away from the administrator. The instance this talks to is a fork
 * that adds `blockedTags` to a user's settings, which is why this can now say
 * "hidden from these people" rather than "hidden from everybody".
 *
 * Two writes per person, because Jellyseerr's settings route assigns username
 * and email straight out of the request body: posting only the tags would
 * blank both. So the current settings are read and posted back with the tags
 * changed, exactly as its own UI does.
 *
 * The global tag list is still maintained, but it means something different -
 * it is the crawler's shopping list. A title can only be hidden from anyone
 * once the crawler has indexed it under that tag, so the global list has to be
 * the union of everything anyone is filtered on.
 */
export async function applyToJellyseerr(doc) {
  if (!JELLYSEERR_API_KEY) {
    throw Object.assign(new Error('jellyseerr api key not configured'), { status: 503 });
  }

  const users = (await seerr('/user?take=100')).results ?? [];
  const applied = [];
  const union = new Set();

  for (const user of users) {
    const tags = resolveFor(doc, user.jellyfinUserId ?? null)
      .keywordIds.filter(Number.isInteger);
    for (const id of tags) union.add(id);

    const wanted = tags.join(',');
    const current = await seerr(`/user/${user.id}/settings/main`);
    if ((current.blockedTags ?? '') === wanted) continue;

    await seerr(`/user/${user.id}/settings/main`, {
      method: 'POST',
      body: JSON.stringify({ ...current, blockedTags: wanted }),
    });
    applied.push({
      user: user.displayName ?? user.jellyfinUsername ?? String(user.id),
      tags,
    });
  }

  // The crawler indexes what this names, and nothing else can ever be hidden.
  const main = await seerr('/settings/main');
  const existing = String(main.blocklistedTags ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(Number.isInteger);
  const previous = await lastPushed();
  const keep = existing.filter(id => !previous.includes(id));
  const wanted = [...union];
  const final = [...new Set([...keep, ...wanted])];

  const limit = Number(main.blocklistedTagsLimit) || 50;
  if (final.length > limit) {
    throw Object.assign(
      new Error(`jellyseerr allows ${limit} blocklisted tags, this would need ${final.length}`),
      { status: 400 },
    );
  }

  let crawled = false;
  if (final.join(',') !== existing.join(',')) {
    await seerr('/settings/main', {
      method: 'POST',
      body: JSON.stringify({ blocklistedTags: final.join(',') }),
    });
    // Only worth the crawl when the list actually changed - it walks TMDB
    // discover for every tag across several sort orders.
    try {
      await seerr('/settings/jobs/process-blocklisted-tags/run', { method: 'POST' });
      crawled = true;
    } catch {
      crawled = false;
    }
  }

  await mkdir(dirname(SEERR_STATE), { recursive: true }).catch(() => {});
  await writeFile(SEERR_STATE, JSON.stringify({ tags: wanted }), 'utf8');

  return { applied, tags: final, crawlStarted: crawled };
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
/** The tag this service stamps on a library item for one filter. */
const markerFor = (filterId) => `jellylab:${filterId}`;

/**
 * Stamp a marker tag onto every library item a filter covers.
 *
 * Jellyfin blocks by tag *name* on the items you own, and those names arrive
 * from whatever the metadata scraper happened to import. Jellyseerr matches
 * TMDB keyword *ids* against everything TMDB knows. The two agree until a
 * file is scraped thinly - and then a title is blocked in one place and not
 * the other, which is the worst possible answer.
 *
 * So Jellyfin stops depending on the scraper. Jellyseerr's blocklist already
 * says, by TMDB id, which titles carry which keywords; this finds the library
 * items with those ids and puts one marker tag on them. A user is then
 * blocked on that single marker rather than on six scraped keyword names.
 *
 * Jellyfin has no per-user, per-item blocklist, so a tag is the only lever
 * available - but it is an exact one, because membership is decided from
 * TMDB rather than from whatever the scraper wrote.
 *
 * The marker is re-stamped on every apply and is not locked, so a metadata
 * refresh that clears it is repaired by the next apply rather than needing
 * the Tags field frozen - which would stop real keywords arriving at all.
 */
export async function stampLibrary(doc, token) {
  /*
   * Reading one item needs the user-scoped route. `GET /Items/{id}` answers
   * 400 on this server - it is the *update* endpoint - and the flat
   * `/Items?ids=` form returns a trimmed record that the update then rejects.
   * `GET /Users/{admin}/Items/{id}` returns the full 51-field DTO that
   * `POST /Items/{id}` accepts, which is the pair the web UI itself uses.
   */
  const users = await jellyfin('/Users', token);
  const admin = users.find(u => u?.Policy?.IsAdministrator);
  if (!admin) {
    throw Object.assign(new Error('no administrator to read the library as'), { status: 500 });
  }

  const items = await jellyfin(
    '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Tags,ProviderIds&Limit=5000',
    token,
  );

  // What Jellyseerr's crawler found, as tmdbId -> the keyword ids that matched.
  const blocked = new Map();
  if (JELLYSEERR_API_KEY) {
    /*
     * `filter` and `skip`, not `page`. That endpoint rejects `page` outright
     * with a 400, and - the part that cost an hour - answers an unfiltered
     * request with zero results while `filter=blocklistedTags` returns
     * thousands. Reading the bare call and believing it is what sent me
     * hunting a bug in the crawler that was working the whole time.
     *
     * blocklistedTags is the right filter here regardless: manual entries
     * block everyone already and are no business of a per-filter marker.
     */
    const PAGE = 500;
    for (let skip = 0; ; skip += PAGE) {
      const res = await seerr(`/blocklist?take=${PAGE}&skip=${skip}&filter=blocklistedTags`);
      const rows = res.results ?? [];
      for (const row of rows) {
        const tags = String(row.blocklistedTags ?? '')
          .split(',')
          .map(s => Number(s.trim()))
          .filter(Number.isInteger);
        if (tags.length) blocked.set(Number(row.tmdbId), tags);
      }
      if (rows.length < PAGE) break;
    }
  }

  const stamped = [];
  const cleared = [];

  for (const item of items.Items ?? []) {
    const tmdbId = Number(item.ProviderIds?.Tmdb);
    const tags = Number.isInteger(tmdbId) ? blocked.get(tmdbId) ?? [] : [];
    const current = new Set(item.Tags ?? []);

    // Every filter whose keywords this item actually carries.
    const wanted = new Set();
    for (const f of doc.filters ?? []) {
      const ids = (f.keywords ?? []).map(k => k.id);
      if (ids.some(id => tags.includes(id))) wanted.add(markerFor(f.id));
    }

    const ours = [...current].filter(t => String(t).startsWith('jellylab:'));
    const toAdd = [...wanted].filter(t => !current.has(t));
    const toRemove = ours.filter(t => !wanted.has(t));
    if (!toAdd.length && !toRemove.length) continue;

    const next = [...current].filter(t => !toRemove.includes(t)).concat(toAdd);
    // Jellyfin replaces the whole item on POST, so the full record goes back
    // with only Tags changed. Anything less blanks the rest of the metadata.
    const full = await jellyfin(`/Users/${admin.Id}/Items/${item.Id}`, token);
    await jellyfin(`/Items/${item.Id}`, token, {
      method: 'POST',
      body: JSON.stringify({ ...full, Tags: next }),
    });

    if (toAdd.length) stamped.push({ item: item.Name, tags: toAdd });
    if (toRemove.length) cleared.push({ item: item.Name, tags: toRemove });
  }

  return { stamped, cleared, indexed: blocked.size };
}

export async function applyToJellyfin(doc, token) {
  const users = await jellyfin('/Users', token);
  const applied = [];
  for (const u of users) {
    if (u?.Policy?.IsAdministrator) continue;
    const { filterIds, keywordNames, maxAge, blockUnrated } = resolveFor(doc, u.Id);
    /*
     * Blocked on the markers this service stamps, plus the scraped keyword
     * names as a belt-and-braces second line.
     *
     * The markers are exact: membership is decided from Jellyseerr's blocklist
     * by TMDB id, so a thinly scraped file is caught anyway. The keyword names
     * are kept because they cost nothing and still catch an item stamping has
     * not reached yet - a title added since the last apply, or one whose
     * marker a metadata refresh cleared.
     */
    const markers = filterIds.map(markerFor);
    /*
     * An unrated item carries no age, so an age cap alone lets it straight
     * through - which is the wrong way round for the one setting whose whole
     * job is caution. Movie and Series are the only kinds this library holds.
     */
    const policy = {
      ...u.Policy,
      BlockedTags: [...new Set([...markers, ...keywordNames])],
      MaxParentalRating: maxAge,
      BlockUnratedItems: blockUnrated ? ['Movie', 'Series'] : [],
    };
    await jellyfin(`/Users/${u.Id}/Policy`, token, {
      method: 'POST',
      body: JSON.stringify(policy),
    });
    applied.push({
      user: u.Name,
      id: u.Id,
      markers,
      blockedTags: keywordNames,
      maxAge,
      blockUnrated,
    });
  }
  return applied;
}
