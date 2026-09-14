/**
 * The per-person filter store and the Jellyfin half of enforcement.
 *
 * syncContentFilters runs against a fake Jellyfin and a fake Seerr, because
 * the thing worth proving is what it writes: which markers land on which
 * items, and whose BlockedTags change.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
let jellyfin;
let seerr;
let filters;
const writes = { policies: [], items: [] };

const USERS = [
  { Id: 'admin-0000-0000', Name: 'admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
  { Id: 'kid-0000-00000001', Name: 'talha', Policy: { IsAdministrator: false, BlockedTags: ['handmade'] } },
  { Id: 'self-000-00000001', Name: 'furkan', Policy: { IsAdministrator: false, BlockedTags: ['jellylab:kw:5'] } },
];
const ITEMS = [
  { Id: 'i100', Name: 'Hidden film', Type: 'Movie', ProviderIds: { Tmdb: '100' }, Tags: [] },
  { Id: 'i200', Name: 'Clean film', Type: 'Movie', ProviderIds: { Tmdb: '200' }, Tags: ['jellylab:kw:5'] },
  { Id: 'i300', Name: 'Lookup fails', Type: 'Series', ProviderIds: { Tmdb: '300' }, Tags: ['jellylab:kw:5'] },
  { Id: 'i400', Name: 'No TMDB id', Type: 'Movie', ProviderIds: {}, Tags: [] },
  { Id: 'i500', Name: 'Some Collection', Type: 'BoxSet', ProviderIds: { Tmdb: '263' }, Tags: [] },
];
const KEYWORDS = { 'movie:100': [5, 9], 'movie:200': [7] };

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};
const readAll = async (req) => {
  let t = '';
  for await (const c of req) t += c;
  return t ? JSON.parse(t) : null;
};
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jellylab-push-'));
  jellyfin = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    let m;
    if (p === '/Users') return json(res, 200, structuredClone(USERS));
    if ((m = /^\/Users\/([^/]+)\/Policy$/.exec(p)) && req.method === 'POST') {
      writes.policies.push({ id: m[1], policy: await readAll(req) });
      return json(res, 204, {});
    }
    if (p === '/Items') return json(res, 200, { Items: structuredClone(ITEMS) });
    if ((m = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(p))) return json(res, 200, { ...structuredClone(ITEMS.find((i) => i.Id === m[1])), Overview: 'kept' });
    if ((m = /^\/Items\/([^/]+)$/.exec(p)) && req.method === 'POST') {
      writes.items.push({ id: m[1], item: await readAll(req) });
      return json(res, 204, {});
    }
    return json(res, 404, {});
  });
  seerr = http.createServer((req, res) => {
    const m = /^\/api\/v1\/(movie|tv)\/(\d+)$/.exec(new URL(req.url, 'http://x').pathname);
    if (req.headers['x-api-key'] !== 'k') return json(res, 401, {});
    if (!m) return json(res, 404, {});
    const key = `${m[1]}:${m[2]}`;
    if (key === 'tv:300') return json(res, 500, { message: 'boom' });
    if (!(key in KEYWORDS)) return json(res, 404, {});
    return json(res, 200, { id: Number(m[2]), keywords: KEYWORDS[key].map((id) => ({ id, name: `kw${id}` })) });
  });
  const jfPort = await listen(jellyfin);
  const seerrPort = await listen(seerr);
  Object.assign(process.env, {
    JELLYFIN_URL: `http://127.0.0.1:${jfPort}`,
    JELLYSEERR_URL: `http://127.0.0.1:${seerrPort}`,
    JELLYSEERR_API_KEY: 'k',
    CONTENT_FILTERS_PATH: join(dir, 'content-filters.json'),
    KEYWORD_CACHE_PATH: join(dir, 'keywords.json'),
    FILTERS_PATH: join(dir, 'filters.json'),
  });
  filters = await import('../filters.mjs');
});

after(async () => {
  await new Promise((r) => jellyfin.close(r));
  await new Promise((r) => seerr.close(r));
  await rm(dir, { recursive: true, force: true });
});

test('parseIds and hiddenIdsFor', () => {
  assert.deepEqual(filters.parseIds('5, 3,,0,x,3'), [3, 5]);
  assert.deepEqual(filters.parseIds([2, '1', -4]), [1, 2]);
  const doc = { version: 2, adultTags: [900], users: { a: { blockedTags: [5], hideAdult: true }, b: { blockedTags: [], hideAdult: false } } };
  assert.deepEqual(filters.hiddenIdsFor(doc, 'a'), [5, 900]);
  assert.deepEqual(filters.hiddenIdsFor(doc, 'b'), []);
  assert.deepEqual(filters.hiddenIdsFor(doc, 'nobody'), []);
});

test('withPersonChange keeps omitted fields and removes people left with nothing', () => {
  const doc = { version: 2, adultTags: [], users: { kid: { name: 'talha', blockedTags: [5], hideAdult: false } } };
  const adult = filters.withPersonChange(doc, 'kid', { hideAdult: true });
  assert.deepEqual(adult.users.kid, { name: 'talha', blockedTags: [5], hideAdult: true });
  const cleared = filters.withPersonChange(doc, 'kid', { blockedTags: [] });
  assert.equal('kid' in cleared.users, false);
  assert.equal('kid' in doc.users, true, 'input is not mutated');
  const added = filters.withPersonChange(doc, 'new', { blockedTags: '8,7', name: ' tarik ' });
  assert.deepEqual(added.users.new, { blockedTags: [7, 8], hideAdult: false, name: 'tarik' });
});

test('validateContent rejects shapes the guard would not parse', () => {
  assert.equal(filters.validateContent({ version: 2, adultTags: [], users: {} }), null);
  assert.match(filters.validateContent({ version: 1, adultTags: [], users: {} }), /version/);
  assert.match(filters.validateContent({ version: 2, adultTags: [], users: { a: { blockedTags: ['5'], hideAdult: false } } }), /blockedTags/);
  assert.match(filters.validateContent({ version: 2, adultTags: [], users: { a: { blockedTags: [], hideAdult: 'no' } } }), /hideAdult/);
});

test('a missing store is empty, an unreadable one throws', async () => {
  const empty = await filters.loadContent();
  assert.deepEqual(empty.users, {});
  assert.equal(empty.adultTags.length, 6);
  await writeFile(process.env.CONTENT_FILTERS_PATH, '{ broken');
  await assert.rejects(filters.loadContent());
  await rm(process.env.CONTENT_FILTERS_PATH);
});

test('setPersonFilters writes atomically and queues concurrent changes', async () => {
  await Promise.all([
    filters.setPersonFilters('kid-0000-00000001', { blockedTags: [5], name: 'talha' }),
    filters.setPersonFilters('self-000-00000001', { hideAdult: true, name: 'furkan' }),
  ]);
  const doc = JSON.parse(await readFile(process.env.CONTENT_FILTERS_PATH, 'utf8'));
  assert.deepEqual(Object.keys(doc.users).sort(), ['kid-0000-00000001', 'self-000-00000001'], 'neither change lost the other');
  await assert.rejects(filters.setPersonFilters('../../etc', { blockedTags: [1] }), /Jellyfin user id/);
  await filters.setPersonFilters('self-000-00000001', { hideAdult: false });
});

test('sync stamps by keyword, blocks per person, and never unhides on a failed lookup', async () => {
  writes.policies.length = 0;
  writes.items.length = 0;
  const out = await filters.syncContentFilters('token');

  const byItem = Object.fromEntries(writes.items.map((w) => [w.id, w.item.Tags]));
  assert.deepEqual(byItem.i100, ['jellylab:kw:5'], 'carries keyword 5, which somebody is hidden from; keyword 9 nobody asked for');
  assert.deepEqual(byItem.i200, [], 'no longer carries a hidden keyword, stale marker cleared');
  assert.equal('i300' in byItem, false, 'lookup failed: its existing marker is left alone');
  assert.equal('i400' in byItem, false, 'no TMDB id: not touched');
  assert.equal('i500' in byItem, false, 'a collection is not a title: not looked up, not touched');
  assert.equal(writes.items.find((w) => w.id === 'i100').item.Overview, 'kept', 'the full item goes back, not just Tags');

  const byUser = Object.fromEntries(writes.policies.map((w) => [w.id, w.policy.BlockedTags]));
  assert.deepEqual(byUser['kid-0000-00000001'].sort(), ['handmade', 'jellylab:kw:5'], 'hand-made blocks are kept');
  assert.deepEqual(byUser['self-000-00000001'], [], 'furkan had a marker but is no longer filtered');
  assert.equal('admin-0000-0000' in byUser, false, 'an unfiltered admin policy is untouched');

  assert.equal(out.lookupFailures, 1);
  assert.equal(out.library, 3);
  assert.deepEqual(out.tags, [5]);
});

test('with nobody filtered, markers are cleared without asking Seerr anything', async () => {
  await filters.setPersonFilters('kid-0000-00000001', { blockedTags: [] });
  writes.items.length = 0;
  const out = await filters.syncContentFilters('token');
  const cleared = writes.items.map((w) => w.id).sort();
  assert.deepEqual(cleared, ['i200', 'i300'], 'every stamped item is cleared, including the one whose lookup fails');
  assert.equal(out.lookupFailures, 0);
});
