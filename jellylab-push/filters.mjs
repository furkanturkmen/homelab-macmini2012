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
 * Mirror the everyone-filter into Jellyseerr's own blocklist.
 *
 * This is the gap named at the top of this file: blocked tags in Jellyfin hold
 * against every client, but Jellyseerr's web UI answers to none of that, so a
 * title filtered out of the app was still one search away on the website.
 *
 * Only the assignment to EVERYONE is mirrored, and that is a limitation of
 * Jellyseerr rather than a choice. Its blocklist is a **global** setting -
 * `settings.main.blocklistedTags`, a comma-separated list of TMDB keyword ids
 * that a background job expands into blocklisted titles. Per-user settings
 * there carry request quotas and nothing else, so a filter assigned to one
 * person cannot be enforced on that website at all. Say so rather than
 * implying otherwise.
 *
 * What this last wrote is remembered, so unassigning a filter takes its tags
 * back out again while leaving alone any tag added by hand in Jellyseerr's own
 * settings. Replacing the list outright would silently discard those.
 */
export async function applyToJellyseerr(doc) {
  if (!JELLYSEERR_API_KEY) {
    throw Object.assign(new Error('jellyseerr api key not configured'), { status: 503 });
  }

  const wanted = resolveFor(doc, null).keywordIds.filter(Number.isInteger);
  const previous = await lastPushed();

  const main = await seerr('/settings/main');
  const current = String(main.blocklistedTags ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(Number.isInteger);

  // Ours come out, theirs stay, then ours go back in as they are now.
  const keep = current.filter(id => !previous.includes(id));
  const final = [...new Set([...keep, ...wanted])];

  const limit = Number(main.blocklistedTagsLimit) || 50;
  if (final.length > limit) {
    throw Object.assign(
      new Error(`jellyseerr allows ${limit} blocklisted tags, this would need ${final.length}`),
      { status: 400 },
    );
  }

  /*
   * Only the tag list is written. `hideBlocklisted` is deliberately left as
   * the administrator set it, because it does not mean what its name suggests:
   * a blocklisted title already cannot be requested by anyone, and this flag
   * additionally hides those titles from the discover pages of people who
   * *can* manage the blocklist - the administrator included. Turning it on
   * from here would quietly take the library away from the person applying the
   * filter.
   */
  await seerr('/settings/main', {
    method: 'POST',
    body: JSON.stringify({ blocklistedTags: final.join(',') }),
  });

  await mkdir(dirname(SEERR_STATE), { recursive: true }).catch(() => {});
  await writeFile(SEERR_STATE, JSON.stringify({ tags: wanted }), 'utf8');

  // The blocklist itself is built by a scheduled job walking Discover for each
  // tag, so without this the change lands whenever that next runs.
  let jobStarted = true;
  try {
    await seerr('/settings/jobs/process-blocklisted-tags/run', { method: 'POST' });
  } catch {
    jobStarted = false;
  }

  return {
    tags: final,
    added: wanted.filter(id => !previous.includes(id)),
    removed: previous.filter(id => !wanted.includes(id)),
    kept: keep,
    /** left as the administrator set it - see above */
    hideBlocklisted: Boolean(main.hideBlocklisted),
    jobStarted,
  };
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
export async function applyToJellyfin(doc, token) {
  const users = await jellyfin('/Users', token);
  const applied = [];
  for (const u of users) {
    if (u?.Policy?.IsAdministrator) continue;
    const { keywordNames, maxAge, blockUnrated } = resolveFor(doc, u.Id);
    /*
     * An unrated item carries no age, so an age cap alone lets it straight
     * through - which is the wrong way round for the one setting whose whole
     * job is caution. Movie and Series are the only kinds this library holds.
     */
    const policy = {
      ...u.Policy,
      BlockedTags: keywordNames,
      MaxParentalRating: maxAge,
      BlockUnratedItems: blockUnrated ? ['Movie', 'Series'] : [],
    };
    await jellyfin(`/Users/${u.Id}/Policy`, token, {
      method: 'POST',
      body: JSON.stringify(policy),
    });
    applied.push({ user: u.Name, id: u.Id, blockedTags: keywordNames, maxAge, blockUnrated });
  }
  return applied;
}
