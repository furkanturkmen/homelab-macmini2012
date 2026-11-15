/**
 * End to end: the real guard, between a fake Seerr and a fake jellylab-push.
 *
 * The fake Seerr answers the handful of routes the guard cares about with the
 * same shapes the real one uses. Movie 100 carries keyword 5, which the kid is
 * blocked on; movie 200 is clean; movie 300 answers slowly, to prove an
 * unchecked title is hidden until it has been checked.
 *
 * A fake Jellyfin holds each person's settings. "teen" has no keyword filter,
 * only Jellyfin limits: PG-13, films without a rating blocked, no Anime
 * library. Films 400-402 and series 500-502 are not in the library and are
 * predicted; films 600 and 601 are, and Jellyfin decides them itself.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_KEY = 'test-api-key';
const SECRET = 'test-secret';

const USERS = {
  1: { id: 1, permissions: 2, jellyfinUserId: 'self', displayName: 'furkan' },
  3: { id: 3, permissions: 32, jellyfinUserId: 'kid', displayName: 'robin' },
  9: { id: 9, permissions: 0, jellyfinUserId: null, displayName: 'filter-canary' },
  4: { id: 4, permissions: 32, jellyfinUserId: 'teen', displayName: 'sam' },
  5: { id: 5, permissions: 32, jellyfinUserId: 'broken', displayName: 'alex' },
};
const SESSIONS = { adminsid: 1, kidsid: 3, teensid: 4, brokensid: 5 };
const KEYWORDS = { 100: [5], 200: [7], 300: [], 301: [], 400: [], 401: [], 402: [], 600: [], 601: [] };
const ANIME = 210024;
const TV_KEYWORDS = { 500: [ANIME], 501: [], 502: [] };
// US ratings; a missing entry is a title without one.
const CERTS = { 400: 'R', 401: 'PG', 600: 'R', 601: 'PG', 500: 'TV-PG', 501: 'TV-14', 502: 'TV-PG' };

const JF_POLICIES = {
  self: { IsAdministrator: true, EnableAllFolders: true },
  kid: { EnableAllFolders: true, BlockedTags: [], BlockUnratedItems: [] },
  teen: { EnableAllFolders: false, EnabledFolders: ['lib-movies', 'lib-tv'], MaxParentalRating: 13, BlockUnratedItems: ['Movie'], BlockedTags: [] },
};
// What Jellyfin lists per person. 600 is R but the library shows it to teen
// (say, an exception in Jellyfin); 601 is PG but Jellyfin hides it from teen.
const JF_LIBRARY = [600, 601];
const JF_VISIBLE = { teen: [600] };

let dir;
let storePath;
let seerr;
let push;
let jf;
let guard;
let base;
const seen = { requests: [], settingsPosts: [], pushPuts: [], logouts: [] };

const nextHtml = (pageProps, buildId = 'B1') =>
  `<!doctype html><html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps }, buildId })}</script></body></html>`;

const baseStore = () => ({
  version: 2,
  adultTags: [900, 901],
  users: {
    kid: { name: 'robin', blockedTags: [5], hideAdult: false },
    self: { name: 'furkan', blockedTags: [], hideAdult: false },
  },
  canary: { seerrUserId: 9, blockedTags: [5], hiddenTitle: 'movie:100', cleanTitle: 'movie:200', keywordId: 5 },
});

const etagOf = (text) => `W/"${createHash('sha1').update(text).digest('hex')}"`;

function json(res, status, obj, req = null) {
  const body = JSON.stringify(obj);
  // Like Express: every JSON answer carries an ETag, and a matching
  // If-None-Match gets a bodiless 304.
  const etag = etagOf(body);
  if (req && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), etag });
  res.end(body);
}

const SEARCH_BODY = { page: 1, results: [{ id: 100, mediaType: 'movie' }, { id: 200, mediaType: 'movie' }] };

function html(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const readAll = async (req) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
};

function fakeSeerr() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const apiUser = req.headers['x-api-key'] === API_KEY ? USERS[Number(req.headers['x-api-user']) || 1] : null;
    const sid = /connect\.sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const me = apiUser ?? USERS[SESSIONS[sid]];
    let m;

    if (p === '/api/v1/auth/me') return me ? json(res, 200, me) : json(res, 401, { message: 'unauthorized' });
    if (p === '/api/v1/auth/jellyfin' && req.method === 'POST') {
      const { username } = JSON.parse(await readAll(req));
      const sid = { furkan: 'adminsid', robin: 'kidsid' }[username];
      if (!sid) return json(res, 401, { message: 'bad login' });
      const body = JSON.stringify(USERS[SESSIONS[sid]]);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': `connect.sid=${sid}; Path=/; HttpOnly`, 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (p === '/api/v1/auth/logout' && req.method === 'POST') {
      seen.logouts.push(req.headers.cookie);
      return json(res, 200, {});
    }
    if (p === '/api/v1/settings/main') return me ? json(res, 200, { apiKey: 'very-secret' }) : json(res, 401, {});
    if ((m = /^\/api\/v1\/user\/(\d+)$/.exec(p))) return USERS[m[1]] ? json(res, 200, USERS[m[1]]) : json(res, 404, {});
    if ((m = /^\/api\/v1\/user\/(\d+)\/settings\/main$/.exec(p))) {
      if (req.method === 'POST') {
        const body = JSON.parse(await readAll(req));
        seen.settingsPosts.push(body);
        return json(res, 200, { locale: body.locale ?? 'en' });
      }
      return json(res, 200, { locale: 'en' });
    }
    if ((m = /^\/api\/v1\/movie\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      if (!(id in KEYWORDS)) return json(res, 404, { message: 'not found' });
      if (id === 300 || id === 301) await new Promise((r) => setTimeout(r, 1500));
      const releases = { results: CERTS[id] ? [{ iso_3166_1: 'US', release_dates: [{ certification: CERTS[id] }] }] : [] };
      return json(res, 200, { id, title: `Movie ${id}`, releases, keywords: KEYWORDS[id].map((k) => ({ id: k, name: `kw${k}` })) });
    }
    if ((m = /^\/api\/v1\/tv\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      if (!(id in TV_KEYWORDS)) return json(res, 404, { message: 'not found' });
      const contentRatings = { results: CERTS[id] ? [{ iso_3166_1: 'US', rating: CERTS[id] }] : [] };
      return json(res, 200, { id, name: `Show ${id}`, contentRatings, keywords: TV_KEYWORDS[id].map((k) => ({ id: k, name: `kw${k}` })) });
    }
    if (p === '/api/v1/settings/radarr') return json(res, 200, [{ isDefault: true, is4k: false, activeDirectory: '/media/movies' }]);
    if (p === '/api/v1/settings/sonarr') return json(res, 200, [{ isDefault: true, is4k: false, activeDirectory: '/media/tv', activeAnimeDirectory: '/media/anime' }]);
    if ((m = /^\/api\/v1\/movie\/(\d+)\/recommendations$/.exec(p))) {
      return json(res, 200, { page: 1, totalResults: 2, results: [{ id: 100, mediaType: 'movie' }, { id: 200, mediaType: 'movie' }] });
    }
    if (p === '/api/v1/discover/trending') {
      return json(res, 200, {
        page: 1,
        results: [
          { id: 100, mediaType: 'movie' },
          { id: 200, mediaType: 'movie' },
          { id: 300, mediaType: 'movie' },
          { id: 31, mediaType: 'person', knownFor: [{ id: 100, mediaType: 'movie' }, { id: 200, mediaType: 'movie' }] },
        ],
      });
    }
    if (p === '/api/v1/search' && url.searchParams.get('query') === 'teen') {
      return json(res, 200, { page: 1, results: [
        ...[400, 401, 402, 600, 601].map((id) => ({ id, mediaType: 'movie' })),
        ...[500, 501, 502].map((id) => ({ id, mediaType: 'tv' })),
      ] });
    }
    if (p === '/api/v1/search') return json(res, 200, SEARCH_BODY, req);
    if (p === '/api/v1/discover/movies') return json(res, 200, { results: [{ id: 200, mediaType: 'movie' }, { id: 301, mediaType: 'movie' }] });
    if (p === '/api/v1/discover/keyword/5/movies') return json(res, 200, { results: [{ id: 100, mediaType: 'movie' }, { id: 200, mediaType: 'movie' }] }, req);
    if (p === '/api/v1/request/1') return json(res, 200, { id: 1, media: { id: 7, tmdbId: 100, mediaType: 'movie' } });
    if (p === '/api/v1/request' && req.method === 'POST') {
      seen.requests.push(JSON.parse(await readAll(req)));
      return json(res, 201, { id: 99 });
    }
    if (p === '/api/v1/settings/public') return json(res, 200, { initialized: true });
    if (p === '/login') return html(res, 200, nextHtml({}));
    if ((m = /^\/movie\/(\d+)$/.exec(p))) return html(res, 200, nextHtml({ movie: { id: Number(m[1]) } }));
    if ((m = /^\/_next\/data\/B1\/movie\/(\d+)\.json$/.exec(p))) return json(res, 200, { pageProps: { movie: { id: Number(m[1]) } } });
    const parts = [{ id: 100, mediaType: 'movie' }, { id: 200, mediaType: 'movie' }];
    if (p === '/collection/10') return html(res, 200, nextHtml({ collection: { id: 10, parts } }));
    if (p === '/_next/data/B1/collection/10.json') return json(res, 200, { pageProps: { collection: { id: 10, parts } } });
    if (p === '/_next/static/app.js') {
      if (req.headers['if-none-match'] === 'W/"static-1"') {
        res.writeHead(304, { etag: 'W/"static-1"' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/javascript', etag: 'W/"static-1"' });
      return res.end('console.log(1)');
    }
    return html(res, 404, '<h1>Seerr 404 page</h1>');
  });
}

function fakePush() {
  return http.createServer(async (req, res) => {
    const m = /^\/filters\/content\/([^/]+)$/.exec(new URL(req.url, 'http://x').pathname);
    if (!m || req.method !== 'PUT') return json(res, 404, {});
    if (req.headers['x-filter-store-secret'] !== SECRET) return json(res, 403, { error: 'bad secret' });
    const changes = JSON.parse(await readAll(req));
    seen.pushPuts.push({ jellyfinUserId: m[1], changes });
    const doc = JSON.parse(await readFile(storePath, 'utf8'));
    doc.users[m[1]] = { ...(doc.users[m[1]] ?? { blockedTags: [], hideAdult: false }), ...changes };
    await writeFile(storePath, JSON.stringify(doc));
    return json(res, 200, doc.users[m[1]]);
  });
}

function fakeJellyfin() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.headers.authorization !== 'MediaBrowser Token="jf-key"') return json(res, 401, {});
    let m;
    if (p === '/Localization/ParentalRatings') {
      return json(res, 200, [
        { Name: 'Unrated' },
        { Name: 'PG', Value: 10, RatingScore: { score: 10, subScore: 0 } },
        { Name: 'TV-PG', Value: 10, RatingScore: { score: 10, subScore: 0 } },
        { Name: 'PG-13', Value: 13, RatingScore: { score: 13, subScore: 0 } },
        { Name: 'TV-14', Value: 14, RatingScore: { score: 14, subScore: 0 } },
        { Name: 'R', Value: 17, RatingScore: { score: 17, subScore: 0 } },
      ]);
    }
    if (p === '/Library/VirtualFolders') {
      return json(res, 200, [
        { Name: 'Movies', ItemId: 'lib-movies', Locations: ['/media/movies'] },
        { Name: 'TV Shows', ItemId: 'lib-tv', Locations: ['/media/tv'] },
        { Name: 'Anime', ItemId: 'lib-anime', Locations: ['/media/anime/'] },
      ]);
    }
    if (p === '/System/Configuration') return json(res, 200, { MetadataCountryCode: 'US' });
    if ((m = /^\/Users\/([^/]+)$/.exec(p))) {
      if (m[1] === 'broken') return json(res, 500, {});
      return JF_POLICIES[m[1]] ? json(res, 200, { Id: m[1], Policy: JF_POLICIES[m[1]] }) : json(res, 404, {});
    }
    if (p === '/Items') {
      const who = url.searchParams.get('userId');
      const list = who ? (JF_VISIBLE[who] ?? JF_LIBRARY) : JF_LIBRARY;
      return json(res, 200, { Items: list.map((id) => ({ Type: 'Movie', ProviderIds: { Tmdb: String(id) } })) });
    }
    return json(res, 404, {});
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seerr-guard-'));
  storePath = join(dir, 'content-filters.json');
  await writeFile(storePath, JSON.stringify(baseStore()));
  seerr = fakeSeerr();
  push = fakePush();
  jf = fakeJellyfin();
  const seerrPort = await listen(seerr);
  const pushPort = await listen(push);
  const jfPort = await listen(jf);
  const probe = http.createServer();
  const guardPort = await listen(probe);
  await new Promise((r) => probe.close(r));

  guard = spawn(process.execPath, [join(HERE, '..', 'guard.mjs')], {
    env: {
      ...process.env,
      GUARD_PORT: String(guardPort),
      SEERR_URL: `http://127.0.0.1:${seerrPort}`,
      SEERR_API_KEY: API_KEY,
      STORE_PATH: storePath,
      CACHE_PATH: join(dir, 'keywords.json'),
      PUSH_URL: `http://127.0.0.1:${pushPort}`,
      FILTER_STORE_SECRET: SECRET,
      INTERNAL_NETWORKS: '127.0.0.1/32',
      RELAY_NETWORKS: '172.31.77.0/24',
      LOOKUP_BUDGET_MS: '500',
      STORE_RECHECK_MS: '50',
      JELLYFIN_URL: `http://127.0.0.1:${jfPort}`,
      JELLYFIN_API_KEY: 'jf-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  guard.stderr.on('data', (d) => process.stderr.write(`[guard stderr] ${d}`));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('guard did not start')), 10000);
    guard.stdout.on('data', (d) => {
      if (String(d).includes('seerr-guard enforcing')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  base = `http://127.0.0.1:${guardPort}`;
});

after(async () => {
  guard?.kill();
  await new Promise((r) => seerr.close(r));
  await new Promise((r) => push.close(r));
  await new Promise((r) => jf.close(r));
  await rm(dir, { recursive: true, force: true });
});

const as = (who) => ({ cookie: `connect.sid=${who}sid` });
const get = (path, headers = {}) => fetch(`${base}${path}`, { headers, redirect: 'manual' });
const ids = (body) => body.results.map((r) => r.id);

test('an unfiltered person gets everything, untouched', async () => {
  const detail = await get('/api/v1/movie/100', as('admin'));
  assert.equal(detail.status, 200);
  const trending = await (await get('/api/v1/discover/trending', as('admin'))).json();
  assert.deepEqual(ids(trending), [100, 200, 300, 31]);
});

test('a hidden title is a 404 on its API, sub-routes, requests and pages', async () => {
  const hidden = await get('/api/v1/movie/100', as('kid'));
  assert.equal(hidden.status, 404);
  assert.equal(hidden.headers.get('x-seerr-guard'), 'hidden');
  assert.equal((await get('/api/v1/movie/200', as('kid'))).status, 200);
  assert.equal((await get('/api/v1/movie/100/recommendations', as('kid'))).status, 404);
  assert.equal((await get('/api/v1/request/1', as('kid'))).status, 404);

  const page = await get('/movie/100', { ...as('kid'), accept: 'text/html' });
  assert.equal(page.status, 404);
  assert.match(await page.text(), /Seerr 404 page/, 'the not-found page is Seerr\'s own');
  assert.equal((await get('/_next/data/B1/movie/100.json', as('kid'))).status, 404);
  assert.equal((await get('/movie/200', as('kid'))).status, 200);
});

test('lists lose hidden rows, including a person\'s knownFor', async () => {
  const recs = await (await get('/api/v1/movie/200/recommendations', as('kid'))).json();
  assert.deepEqual(ids(recs), [200]);
  const trending = await (await get('/api/v1/discover/trending', as('kid'))).json();
  assert.equal(trending.results.some((r) => r.id === 100), false);
  const person = trending.results.find((r) => r.mediaType === 'person');
  assert.deepEqual(person.knownFor.map((k) => k.id), [200]);
});

test('an unchecked title stays hidden until it has been checked, then appears', async () => {
  // Movie 301 appears only here, answers its keyword lookup after 1.5 s, and
  // the lookup budget is 0.5 s - so the first answer cannot know it is clean.
  const first = await (await get('/api/v1/discover/movies', as('kid'))).json();
  assert.deepEqual(ids(first), [200], 'unchecked 301 is withheld from a filtered person');
  const unfiltered = await (await get('/api/v1/discover/movies', as('admin'))).json();
  assert.deepEqual(ids(unfiltered), [200, 301], 'an unfiltered person never waits and sees it');
  await new Promise((r) => setTimeout(r, 1800));
  const later = await (await get('/api/v1/discover/movies', as('kid'))).json();
  assert.deepEqual(ids(later), [200, 301], 'once checked and clean, it shows');
});

test('a request for a hidden title is refused and never reaches Seerr', async () => {
  const before = seen.requests.length;
  const blocked = await fetch(`${base}/api/v1/request`, {
    method: 'POST',
    headers: { ...as('kid'), 'content-type': 'application/json' },
    body: JSON.stringify({ mediaType: 'movie', mediaId: 100 }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('x-seerr-guard'), 'blocked');
  assert.equal(seen.requests.length, before);

  const allowed = await fetch(`${base}/api/v1/request`, {
    method: 'POST',
    headers: { ...as('kid'), 'content-type': 'application/json' },
    body: JSON.stringify({ mediaType: 'movie', mediaId: 200 }),
  });
  assert.equal(allowed.status, 201);
  assert.deepEqual(seen.requests.at(-1), { mediaType: 'movie', mediaId: 200 });
});

test('collection pages and their data lose hidden parts', async () => {
  const page = await (await get('/collection/10', { ...as('kid'), accept: 'text/html' })).text();
  const data = JSON.parse(/type="application\/json">([\s\S]*?)<\/script>/.exec(page)[1]);
  assert.deepEqual(data.props.pageProps.collection.parts.map((p) => p.id), [200]);
  const json = await (await get('/_next/data/B1/collection/10.json', as('kid'))).json();
  assert.deepEqual(json.pageProps.collection.parts.map((p) => p.id), [200]);
});

test('settings shim answers the fork fields and applies the fork permission rules', async () => {
  const mine = await (await get('/api/v1/user/3/settings/main', as('kid'))).json();
  assert.deepEqual(mine, { locale: 'en', blockedTags: '5', hideAdult: false, adultTags: '900,901' });

  const kidPost = await fetch(`${base}/api/v1/user/3/settings/main`, {
    method: 'POST',
    headers: { ...as('kid'), 'content-type': 'application/json' },
    body: JSON.stringify({ locale: 'nl', blockedTags: '', hideAdult: true, adultTags: '1' }),
  });
  assert.equal(kidPost.status, 200);
  assert.deepEqual(seen.settingsPosts.at(-1), { locale: 'nl' }, 'Seerr never sees the fork fields');
  assert.deepEqual(seen.pushPuts.at(-1), { jellyfinUserId: 'kid', changes: { hideAdult: true, name: 'robin' } }, 'a kid cannot clear their own blocked tags');
  const echoed = await kidPost.json();
  assert.equal(echoed.hideAdult, true);
  assert.equal(echoed.blockedTags, '5');

  const adminPost = await fetch(`${base}/api/v1/user/3/settings/main`, {
    method: 'POST',
    headers: { ...as('admin'), 'content-type': 'application/json' },
    body: JSON.stringify({ locale: 'nl', blockedTags: '5,6' }),
  });
  assert.equal(adminPost.status, 200);
  assert.deepEqual(seen.pushPuts.at(-1).changes, { blockedTags: [5, 6], name: 'robin' });
});

test('no store file at all means nobody is filtered, and the canary says so', async () => {
  await rm(storePath);
  await new Promise((r) => setTimeout(r, 120));
  const kid = await get('/api/v1/movie/100', as('kid'));
  assert.equal(kid.status, 200, 'a stack that never set up filters is not locked out');
  const canary = await get('/__guard/canary');
  assert.equal(canary.status, 500);
  assert.match(await canary.text(), /no canary configured/, 'where filters are used, the missing file turns the monitor red');
  await writeFile(storePath, JSON.stringify(baseStore()));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await get('/api/v1/movie/100', as('kid'))).status, 404, 'filters apply again as soon as the file is back');
});

test('a broken store withholds content from filterable people but not from admins', async () => {
  await writeFile(storePath, '{ this is not json');
  await new Promise((r) => setTimeout(r, 120));
  const kid = await get('/api/v1/discover/trending', as('kid'));
  assert.equal(kid.status, 503);
  assert.equal((await get('/api/v1/discover/trending', as('admin'))).status, 200);
  await writeFile(storePath, JSON.stringify(baseStore()));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await get('/api/v1/discover/trending', as('kid'))).status, 200);
});

test('a cached unfiltered answer cannot be revalidated into a filtered session', async () => {
  // The device searched earlier as an unfiltered person and kept the answer
  // with its ETag. Now a filtered person on the same device asks again.
  const staleEtag = etagOf(JSON.stringify(SEARCH_BODY));
  const res = await get('/api/v1/search?query=x', { ...as('kid'), 'if-none-match': staleEtag });
  assert.equal(res.status, 200, 'never a 304 that would reuse the unfiltered copy');
  assert.deepEqual(ids(await res.json()), [200]);
  assert.equal(res.headers.get('etag'), null, 'no validator to revalidate with next time');
  assert.match(res.headers.get('cache-control'), /no-store/);

  const admin = await get('/api/v1/search?query=x', { ...as('admin'), 'if-none-match': staleEtag });
  assert.equal(admin.status, 200, 'unfiltered answers are not stored for reuse either');
  assert.equal(admin.headers.get('etag'), null);
  assert.match(admin.headers.get('cache-control'), /no-store/);
});

const RELAYED = { 'x-forwarded-for': '203.0.113.9, 172.31.77.2' };
const signIn = (username, headers = {}) => fetch(`${base}/api/v1/auth/jellyfin`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ username, password: 'x' }),
});

test('through the relay an administrator cannot sign in, and gets no cookie', async () => {
  const before = seen.logouts.length;
  const res = await signIn('furkan', RELAYED);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('x-seerr-guard'), 'home-only');
  assert.equal(res.headers.get('set-cookie'), null, 'the session cookie never reaches the visitor');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.logouts.length, before + 1, 'and the session Seerr created is ended');
});

test('through the relay an ordinary person signs in normally', async () => {
  const res = await signIn('robin', RELAYED);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /connect\.sid=kidsid/);
});

test('an administrator session or the API key is refused through the relay but works at home', async () => {
  const relayed = await get('/api/v1/settings/main', { ...as('admin'), ...RELAYED });
  assert.equal(relayed.status, 403);
  const apiKey = await get('/api/v1/settings/main', { 'x-api-key': API_KEY, ...RELAYED });
  assert.equal(apiKey.status, 403, 'the API key acts as the owner, so it is refused too');
  const home = await get('/api/v1/settings/main', as('admin'));
  assert.equal(home.status, 200);
  const forged = await get('/api/v1/settings/main', { ...as('admin'), 'x-forwarded-for': '172.31.77.2, 192.168.1.10' });
  assert.equal(forged.status, 200, 'a relay address the visitor typed on the left does not decide anything');
  const kid = await get('/api/v1/movie/200', { ...as('kid'), ...RELAYED });
  assert.equal(kid.status, 200, 'filtered people use the relay as usual');
});

test('static assets keep their validators and may be revalidated', async () => {
  const first = await get('/_next/static/app.js', as('kid'));
  assert.equal(first.headers.get('etag'), 'W/"static-1"');
  const again = await get('/_next/static/app.js', { ...as('kid'), 'if-none-match': 'W/"static-1"' });
  assert.equal(again.status, 304);
});

test('static assets and unrelated routes pass straight through', async () => {
  const js = await get('/_next/static/app.js', as('kid'));
  assert.equal(js.status, 200);
  assert.equal(await js.text(), 'console.log(1)');
  assert.equal((await get('/api/v1/settings/public', as('kid'))).status, 200);
});

test('decide and canary report the filter working', async () => {
  const decide = await (await get('/__guard/decide?user=3&keys=movie:100,movie:200')).json();
  assert.deepEqual(decide.titles, { 'movie:100': 'hidden', 'movie:200': 'visible' });
  const canary = await get('/__guard/canary');
  assert.equal(await canary.text(), 'ok');
  assert.equal(canary.status, 200);
});

test('internal endpoints refuse proxied callers', async () => {
  const proxied = await get('/__guard/canary', { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(proxied.status, 403);
  const health = await (await get('/__guard/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'enforce');
});

const keysOf = (body) => body.results.map((r) => `${r.mediaType}:${r.id}`).sort();

test('Jellyfin limits apply in Seerr to someone with no keyword filter', async () => {
  // The first answer may still be waiting on lookups; the second has them.
  await get('/api/v1/search?query=teen', as('teen'));
  await new Promise((r) => setTimeout(r, 600));
  const seen = await (await get('/api/v1/search?query=teen', as('teen'))).json();
  assert.deepEqual(keysOf(seen), ['movie:401', 'movie:600', 'tv:502'],
    'the R film, the unrated film, the anime, the TV-14 series and the film Jellyfin hides are gone');
  assert.equal((await get('/api/v1/movie/400', as('teen'))).status, 404, 'R is above the PG-13 cap');
  assert.equal((await get('/api/v1/movie/402', as('teen'))).status, 404, 'no rating, and unrated films are blocked');
  assert.equal((await get('/api/v1/tv/500', as('teen'))).status, 404, 'anime: the Anime library is not theirs');
  assert.equal((await get('/api/v1/tv/501', as('teen'))).status, 404, 'TV-14 is above the cap');
  assert.equal((await get('/api/v1/movie/401', as('teen'))).status, 200);
  assert.equal((await get('/api/v1/tv/502', as('teen'))).status, 200, 'unrated series are not blocked for them');
});

test('a title already in the library is decided by Jellyfin, not predicted', async () => {
  assert.equal((await get('/api/v1/movie/600', as('teen'))).status, 200, 'rated R, but Jellyfin shows it to them');
  assert.equal((await get('/api/v1/movie/601', as('teen'))).status, 404, 'rated PG, but Jellyfin hides it from them');
});

test('a request beyond someone\'s Jellyfin limits is refused', async () => {
  const before = seen.requests.length;
  const res = await fetch(`${base}/api/v1/request`, {
    method: 'POST',
    headers: { ...as('teen'), 'content-type': 'application/json' },
    body: JSON.stringify({ mediaType: 'movie', mediaId: 400 }),
  });
  assert.equal(res.status, 403);
  assert.equal(seen.requests.length, before, 'it never reached Seerr');
});

test('someone Jellyfin limits in no way sees every title', async () => {
  const all = await (await get('/api/v1/search?query=teen', as('admin'))).json();
  assert.equal(all.results.length, 8);
});

test('when Jellyfin cannot say what someone may see, they get nothing rather than everything', async () => {
  const res = await get('/api/v1/search?query=teen', as('broken'));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('x-seerr-guard'), 'unavailable');
});
