/**
 * Broad keywords and the "sexual content" backup verdict, end to end.
 *
 * Against a fake Jellyfin, Seerr, AniList and MyAnimeList (Jikan). One person
 * hides "harem" (broad) and sexual content. Titles:
 *   i1  a plain film                       - nothing
 *   i2  a series AniList files under Ecchi - sexual content; its own tag "Female Harem" is reached by "harem"
 *   i3  a series MyAnimeList rates R+      - sexual content, once MyAnimeList answers
 *   i4  a film TMDB marks adult            - sexual content
 *   i5  a series with TMDB "reverse harem" - reached by the broad "harem"
 *   i6  an anime film Jellyfin never linked to AniList - found by title and year, tagged Rape
 *   i7  a live-action film                 - not anime, AniList is never asked
 *   i8  a series Jellyfin refuses to save  - skipped and reported; the rest still goes through
 * i2 also has trickplay data, which Jellyfin cannot take back in an update.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
let filters;
const servers = [];
const writes = { policies: [], items: [] };
let jikanUp = false;

const SEXUAL = 999999999;
const USERS = [
  { Id: 'admin-0000-0000', Name: 'admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
  { Id: 'kid-0000-00000001', Name: 'robin', Policy: { IsAdministrator: false, BlockedTags: [] } },
];
const ITEMS = [
  { Id: 'i1', Name: 'Plain film', Type: 'Movie', ProviderIds: { Tmdb: '1' }, Tags: [] },
  { Id: 'i2', Name: 'Harem series', Type: 'Series', ProviderIds: { Tmdb: '2', AniList: '50' }, Tags: ['Female Harem'] },
  { Id: 'i3', Name: 'Mild series', Type: 'Series', ProviderIds: { Tmdb: '3', AniList: '51' }, Tags: [] },
  { Id: 'i4', Name: 'Adult film', Type: 'Movie', ProviderIds: { Tmdb: '4' }, Tags: [] },
  { Id: 'i5', Name: 'Reverse series', Type: 'Series', ProviderIds: { Tmdb: '5' }, Tags: [] },
  { Id: 'i6', Name: 'Anime Film', Type: 'Movie', ProductionYear: 1998, ProviderIds: { Tmdb: '6' }, Tags: [] },
  { Id: 'i7', Name: 'Live Film', Type: 'Movie', ProductionYear: 2015, ProviderIds: { Tmdb: '7' }, Tags: [] },
  { Id: 'i8', Name: 'Broken series', Type: 'Series', ProviderIds: { Tmdb: '8' }, Tags: [] },
];
const searched = [];
const DETAILS = {
  'movie:1': { keywords: [] },
  'tv:2': { keywords: [] },
  'tv:3': { keywords: [] },
  'movie:4': { keywords: [], adult: true },
  'tv:5': { keywords: [{ id: 777, name: 'reverse harem' }] },
  'movie:6': { keywords: [{ id: 210024, name: 'anime' }] },
  'movie:7': { keywords: [{ id: 570, name: 'rape' }] },
  'tv:8': { keywords: [{ id: 777, name: 'reverse harem' }] },
};
const KEYWORD_NAMES = { 9194: 'harem', 777: 'reverse harem' };

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readAll = async (req) => {
  let t = '';
  for await (const c of req) t += c;
  return t ? JSON.parse(t) : null;
};
const serve = async (handler) => {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jellylab-sexual-'));
  const jf = await serve(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    let m;
    if (p === '/Users') return json(res, 200, structuredClone(USERS));
    if ((m = /^\/Users\/([^/]+)\/Policy$/.exec(p))) {
      writes.policies.push({ id: m[1], policy: await readAll(req) });
      return json(res, 204, {});
    }
    if (p === '/Items') return json(res, 200, { Items: structuredClone(ITEMS) });
    if ((m = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(p))) {
      const full = structuredClone(ITEMS.find((i) => i.Id === m[1]));
      if (m[1] === 'i2') full.Trickplay = { abc: { 320: { Width: 320 } } };
      return json(res, 200, full);
    }
    if ((m = /^\/Items\/([^/]+)$/.exec(p))) {
      const body = await readAll(req);
      // Like Jellyfin: trickplay data sent back in an update is a server error.
      if (body.Trickplay || m[1] === 'i8') return json(res, 500, {});
      writes.items.push({ id: m[1], item: body });
      return json(res, 204, {});
    }
    return json(res, 404, {});
  });
  const seerr = await serve((req, res) => {
    const url = new URL(req.url, 'http://x');
    let m;
    if ((m = /^\/api\/v1\/(movie|tv)\/(\d+)$/.exec(url.pathname))) {
      const d = DETAILS[`${m[1]}:${m[2]}`];
      return d ? json(res, 200, d) : json(res, 404, {});
    }
    if ((m = /^\/api\/v1\/keyword\/(\d+)$/.exec(url.pathname))) {
      return KEYWORD_NAMES[m[1]] ? json(res, 200, { id: Number(m[1]), name: KEYWORD_NAMES[m[1]] }) : json(res, 404, {});
    }
    if (url.pathname === '/api/v1/search/keyword') {
      const q = url.searchParams.get('query');
      const all = [{ id: 9194, name: 'harem' }, { id: 777, name: 'reverse harem' }, { id: 778, name: 'haremony' }];
      return json(res, 200, { page: 1, totalPages: 1, results: all.filter((k) => k.name.includes(q)) });
    }
    return json(res, 404, {});
  });
  const anilist = await serve(async (req, res) => {
    const { variables } = await readAll(req);
    if (variables.q) {
      searched.push(variables.q);
      // Same title, two years: only the 1998 one is taken.
      return json(res, 200, { data: { Page: { media: [
        { id: 60, startDate: { year: 1998 }, title: { romaji: 'ANIME FILM', english: null, native: null } },
        { id: 61, startDate: { year: 2005 }, title: { romaji: 'Anime Film', english: null, native: null } },
      ] } } });
    }
    const known = {
      50: { id: 50, isAdult: false, genres: ['Ecchi', 'Comedy'], idMal: 500 },
      51: { id: 51, isAdult: false, genres: ['Action'], idMal: 510 },
      60: { id: 60, isAdult: false, genres: ['Drama'], idMal: null, tags: [{ name: 'Rape', rank: 77 }] },
    };
    return json(res, 200, { data: { Page: { media: variables.ids.map((id) => known[id]).filter(Boolean) } } });
  });
  const jikan = await serve((req, res) => {
    if (!jikanUp) return json(res, 503, {});
    const id = /\/anime\/(\d+)/.exec(req.url)?.[1];
    return json(res, 200, { data: { rating: id === '510' ? 'R+ - Mild Nudity' : 'PG-13 - Teens 13 or older' } });
  });
  Object.assign(process.env, {
    JELLYFIN_URL: jf,
    JELLYSEERR_URL: seerr,
    JELLYSEERR_API_KEY: 'k',
    ANILIST_URL: anilist,
    JIKAN_URL: jikan,
    CONTENT_FILTERS_PATH: join(dir, 'content-filters.json'),
    KEYWORD_CACHE_PATH: join(dir, 'keywords.json'),
    FILTER_STAMPS_PATH: join(dir, 'stamps.json'),
    SEXUAL_CACHE_PATH: join(dir, 'sexual.json'),
    FILTERS_PATH: join(dir, 'filters.json'),
  });
  await writeFile(process.env.CONTENT_FILTERS_PATH, JSON.stringify({
    version: 2,
    adultTags: [],
    broadTags: [9194],
    users: { 'kid-0000-00000001': { name: 'robin', blockedTags: [9194, SEXUAL], hideAdult: false } },
  }));
  filters = await import('../filters.mjs');
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await rm(dir, { recursive: true, force: true });
});

test('containsWord matches whole words, any case', () => {
  assert.equal(filters.containsWord('Female Harem', 'harem'), true);
  assert.equal(filters.containsWord('reverse harem', 'harem'), true);
  assert.equal(filters.containsWord('harem', 'Harem'), true);
  assert.equal(filters.containsWord('haremony', 'harem'), false, 'part of another word does not count');
  assert.equal(filters.containsWord('erotic thriller', 'erotic'), true);
  assert.equal(filters.containsWord('soft porn', 'soft  porn'), true);
});

test('sexualFrom reads AniList and MyAnimeList the agreed way', () => {
  assert.deepEqual(filters.sexualFrom({ anilist: { isAdult: true, genres: [] } }), ['AniList: adult']);
  assert.deepEqual(filters.sexualFrom({ anilist: { genres: ['Hentai'] } }), ['AniList: Hentai']);
  assert.deepEqual(filters.sexualFrom({ anilist: { genres: ['Ecchi'] } }), ['AniList: Ecchi']);
  assert.deepEqual(filters.sexualFrom({ malRating: 'Rx - Hentai' }), ['MyAnimeList: Rx (hentai)']);
  assert.deepEqual(filters.sexualFrom({ malRating: 'R+ - Mild Nudity' }), ['MyAnimeList: R+ (mild nudity)']);
  assert.deepEqual(filters.sexualFrom({ malRating: 'R - 17+ (violence & profanity)' }), [], 'R alone is violence, not sex');
  // The official API writes them in lower case.
  assert.deepEqual(filters.sexualFrom({ malRating: 'r+' }), ['MyAnimeList: R+ (mild nudity)']);
  assert.deepEqual(filters.sexualFrom({ malRating: 'rx' }), ['MyAnimeList: Rx (hentai)']);
  assert.deepEqual(filters.sexualFrom({ malRating: 'r' }), []);
  assert.deepEqual(filters.sexualFrom({ malRating: 'pg_13' }), []);
  // AniList tags the household chose: rape, incest, prostitution at any strength, nudity from 50%.
  const tagged = (tags) => filters.sexualFrom({ anilist: { genres: [], tags } });
  assert.deepEqual(tagged([{ name: 'Rape', rank: 36 }]), ['AniList: Rape 36%']);
  assert.deepEqual(tagged([{ name: 'Incest', rank: 30 }]), ['AniList: Incest 30%']);
  assert.deepEqual(tagged([{ name: 'Prostitution', rank: 30 }]), ['AniList: Prostitution 30%']);
  assert.deepEqual(tagged([{ name: 'Nudity', rank: 56 }]), ['AniList: Nudity 56%']);
  assert.deepEqual(tagged([{ name: 'Nudity', rank: 50 }]), ['AniList: Nudity 50%'], '50% itself counts');
  assert.deepEqual(tagged([{ name: 'Nudity', rank: 48 }]), [], 'below 50% nudity does not');
  assert.deepEqual(tagged([{ name: 'Masturbation', rank: 25 }]), [], 'not a chosen tag');
  assert.deepEqual(filters.sexualFrom({ anilist: { genres: ['Action'] }, malRating: 'PG-13' }), []);
});

test('broad words and sexual content, with MyAnimeList down', async () => {
  jikanUp = false;
  writes.items.length = 0;
  writes.policies.length = 0;
  const out = await filters.syncContentFilters('token');

  const tags = Object.fromEntries(writes.items.map((w) => [w.id, w.item.Tags]));
  assert.deepEqual(tags.i2, ['Female Harem', 'sexual content'], 'AniList files it under Ecchi');
  assert.deepEqual(tags.i4, ['sexual content'], 'TMDB marks it adult');
  assert.deepEqual(tags.i5, ['reverse harem'], 'a TMDB keyword containing the broad word');
  assert.equal('i3' in tags, false, 'MyAnimeList did not answer: nothing learned, nothing added');
  assert.equal('i1' in tags, false);
  assert.deepEqual(tags.i6, ['sexual content'], 'linked to AniList by title and year, then judged by its tags');
  assert.equal('i7' in tags, false, 'live action: not on AniList, judged by its keywords only');
  assert.deepEqual(searched, ['Anime Film'], 'only the anime without a link is searched for');
  assert.deepEqual(out.writeFailures.map((f) => f.item), ['Broken series'], 'reported, and the others were still saved');
  const stamps = JSON.parse(await readFile(process.env.FILTER_STAMPS_PATH, 'utf8'));
  assert.equal('i8' in stamps.items, false, 'a title whose save failed is not on record, so it is tried again');

  const blocked = writes.policies.find((w) => w.id === 'kid-0000-00000001').policy.BlockedTags.sort();
  assert.deepEqual(blocked, ['Female Harem', 'harem', 'reverse harem', 'sexual content'],
    'the broad word reaches the TMDB keyword and the library tag; "haremony" is another word');

  const store = JSON.parse(await readFile(process.env.CONTENT_FILTERS_PATH, 'utf8'));
  assert.deepEqual(store.expansions, { 9194: { ids: [777, 9194], words: ['Female Harem'] } }, 'saved for seerr-guard');
  assert.deepEqual(filters.hiddenIdsFor(store, 'kid-0000-00000001'), [777, 9194, SEXUAL]);
  assert.deepEqual(out.sexual.map((s) => s.item).sort(), ['Anime Film', 'Harem series']);
});

test('once MyAnimeList answers, its R+ rating counts', async () => {
  jikanUp = true;
  writes.items.length = 0;
  const out = await filters.syncContentFilters('token');
  const tags = Object.fromEntries(writes.items.map((w) => [w.id, w.item.Tags]));
  assert.deepEqual(tags.i3, ['sexual content']);
  assert.deepEqual(out.sexual.find((s) => s.item === 'Mild series').why, ['MyAnimeList: R+ (mild nudity)']);
});

test('many lookups at once, as a Seerr search page makes them, all succeed', async () => {
  const answers = await Promise.all(Array.from({ length: 5 }, () => filters.sexualVerdictFor({ title: 'Anime Film', year: 1998 })));
  for (const a of answers) assert.deepEqual(a, { anilist: 60, why: ['AniList: Rape 77%'] });
  const unknown = await filters.sexualVerdictFor({ title: 'Nothing Like It', year: 1999 });
  assert.deepEqual(unknown, { anilist: null, why: [] }, 'no single AniList match: nothing to judge');
});
