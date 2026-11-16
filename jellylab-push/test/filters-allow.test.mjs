/**
 * Per-person exceptions: "always show Food Wars to Dalia, not to Tarik".
 *
 * Against a fake Jellyfin that keeps what is written to it, so a second sync
 * sees the first one's result. Both people hide keyword 5 ("ecchi"); Tarik has
 * also blocked "Nudity" by hand. Food Wars carries "ecchi" (from its keywords)
 * and "Nudity" (from its metadata); another series carries "ecchi" only.
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

const USERS = [
  { Id: 'admin-0000-0000', Name: 'admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
  { Id: 'dalia-000-00000001', Name: 'dalia', Policy: { IsAdministrator: false, BlockedTags: [] } },
  { Id: 'tarik-000-00000001', Name: 'tarik', Policy: { IsAdministrator: false, BlockedTags: ['Nudity'] } },
];
const ITEMS = [
  { Id: 'fw', Name: 'Food Wars', Type: 'Series', ProviderIds: { Tmdb: '1' }, Tags: ['ecchi', 'cooking', 'Nudity'] },
  { Id: 'ot', Name: 'Other', Type: 'Series', ProviderIds: { Tmdb: '2' }, Tags: [] },
];
const DETAILS = { 'tv:1': { keywords: [{ id: 5, name: 'ecchi' }] }, 'tv:2': { keywords: [{ id: 5, name: 'ecchi' }] } };

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
const tagsOf = (id) => ITEMS.find((i) => i.Id === id).Tags;
const blockedOf = (id) => USERS.find((u) => u.Id === id).Policy.BlockedTags;
const setStore = (dalia) => writeFile(process.env.CONTENT_FILTERS_PATH, JSON.stringify({
  version: 2,
  adultTags: [],
  users: {
    'dalia-000-00000001': { name: 'dalia', blockedTags: [5], hideAdult: false, ...dalia },
    'tarik-000-00000001': { name: 'tarik', blockedTags: [5], hideAdult: false },
  },
}));

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jellylab-allow-'));
  const jf = await serve(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    let m;
    if (p === '/Users') return json(res, 200, structuredClone(USERS));
    if ((m = /^\/Users\/([^/]+)\/Policy$/.exec(p))) {
      USERS.find((u) => u.Id === m[1]).Policy = await readAll(req);
      return json(res, 204, {});
    }
    if (p === '/Items') return json(res, 200, { Items: structuredClone(ITEMS) });
    if ((m = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(p))) return json(res, 200, structuredClone(ITEMS.find((i) => i.Id === m[1])));
    if ((m = /^\/Items\/([^/]+)$/.exec(p))) {
      ITEMS.find((i) => i.Id === m[1]).Tags = (await readAll(req)).Tags;
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
    if ((m = /^\/api\/v1\/keyword\/(\d+)$/.exec(url.pathname))) return json(res, 200, { id: 5, name: 'ecchi' });
    return json(res, 404, {});
  });
  Object.assign(process.env, {
    JELLYFIN_URL: jf,
    JELLYSEERR_URL: seerr,
    JELLYSEERR_API_KEY: 'k',
    CONTENT_FILTERS_PATH: join(dir, 'content-filters.json'),
    KEYWORD_CACHE_PATH: join(dir, 'keywords.json'),
    FILTER_STAMPS_PATH: join(dir, 'stamps.json'),
    SEXUAL_CACHE_PATH: join(dir, 'sexual.json'),
    FILTERS_PATH: join(dir, 'filters.json'),
  });
  filters = await import('../filters.mjs');
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await rm(dir, { recursive: true, force: true });
});

test('allowTitles are cleaned and validated', () => {
  assert.deepEqual(filters.cleanAllowTitles([{ key: 'tv:1', name: ' Food Wars ' }, { key: 'tv:1', name: 'again' }, { key: 'nope', name: 'x' }]),
    [{ key: 'tv:1', name: 'Food Wars' }]);
  assert.match(filters.validateContent({ version: 2, adultTags: [], users: { a: { blockedTags: [], hideAdult: false, allowTitles: [{ key: 'x' }] } } }), /allowTitles/);
});

test('an allowed title is shown to that person only', async () => {
  await setStore({ allowTitles: [{ key: 'tv:1', name: 'Food Wars' }] });
  await filters.syncContentFilters('token');

  assert.deepEqual(tagsOf('fw').sort(), ['Nudity (Food Wars)', 'cooking', 'ecchi (Food Wars)'],
    'every tag anybody blocks is renamed; the rest stays');
  assert.deepEqual(tagsOf('ot'), ['ecchi'], 'other titles are untouched');
  assert.deepEqual(blockedOf('dalia-000-00000001'), ['ecchi'], 'Dalia blocks ecchi, so Food Wars no longer matches for her');
  assert.deepEqual(blockedOf('tarik-000-00000001').sort(), ['Nudity', 'Nudity (Food Wars)', 'ecchi', 'ecchi (Food Wars)'],
    'Tarik gets the variants of what he blocks, his own "Nudity" included');

  const stamps = JSON.parse(await readFile(process.env.FILTER_STAMPS_PATH, 'utf8'));
  assert.deepEqual(stamps.restore.fw, ['Nudity'], 'the metadata tag is remembered; "ecchi" comes back from its keyword anyway');
});

test('a second run changes nothing', async () => {
  const fw = [...tagsOf('fw')];
  const tarik = [...blockedOf('tarik-000-00000001')];
  const out = await filters.syncContentFilters('token');
  assert.deepEqual(tagsOf('fw'), fw);
  assert.deepEqual(blockedOf('tarik-000-00000001'), tarik);
  assert.equal(out.stamped.length + out.cleared.length + out.applied.length, 0);
});

test('a metadata refresh that brings "ecchi" back is undone', async () => {
  ITEMS.find((i) => i.Id === 'fw').Tags.push('ecchi');
  await filters.syncContentFilters('token');
  assert.equal(tagsOf('fw').includes('ecchi'), false);
  assert.equal(tagsOf('fw').includes('ecchi (Food Wars)'), true);
});

test('removing the exception puts everything back as it was', async () => {
  await setStore({});
  await filters.syncContentFilters('token');
  assert.deepEqual(tagsOf('fw').sort(), ['Nudity', 'cooking', 'ecchi']);
  assert.deepEqual(blockedOf('tarik-000-00000001').sort(), ['Nudity', 'ecchi'], 'his own "Nudity" stays, the variants go');
  assert.deepEqual(blockedOf('dalia-000-00000001'), ['ecchi']);
  const stamps = JSON.parse(await readFile(process.env.FILTER_STAMPS_PATH, 'utf8'));
  assert.equal('fw' in stamps.restore, false);
});
