/**
 * The filter routes, against the real server process.
 *
 * Only what can be proven without a Jellyfin: the shared secret opens the
 * store write, nothing else does without a signed-in administrator, and the
 * page itself is served.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let dir;
let proc;
let base;
let jellyfin;
let meCalls = 0;

// Jellyfin, as far as a token check goes: one valid user token.
const GOOD = 'token-of-a-signed-in-user';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jellylab-push-routes-'));
  jellyfin = http.createServer((req, res) => {
    const token = /Token="([^"]*)"/.exec(req.headers.authorization ?? '')?.[1];
    if (req.url === '/Users/Me') meCalls++;
    if (req.url === '/Users/Me' && token === GOOD) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ Name: 'talha', Policy: { IsAdministrator: false } }));
    }
    res.writeHead(401);
    res.end();
  });
  const jfPort = await new Promise((r) => jellyfin.listen(0, '127.0.0.1', () => r(jellyfin.address().port)));
  const probe = http.createServer();
  const port = await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
  await new Promise((r) => probe.close(r));
  proc = spawn(process.execPath, [join(HERE, '..', 'index.mjs')], {
    env: {
      ...process.env,
      PUSH_PORT: String(port),
      DATA_DIR: dir,
      MEDIA_PATH: dir,
      CONTENT_FILTERS_PATH: join(dir, 'content-filters.json'),
      KEYWORD_CACHE_PATH: join(dir, 'keywords.json'),
      FILTERS_PATH: join(dir, 'filters.json'),
      FILTER_STORE_SECRET: 'shared-secret',
      JELLYFIN_URL: `http://127.0.0.1:${jfPort}`,
      JELLYFIN_API_KEY: '',
      SONARR_API_KEY: '',
      RADARR_API_KEY: '',
      QBIT_PASSWORD: '',
      PROWLARR_API_KEY: '',
      // The test client stands in for npm: it is the trusted peer, and a
      // forwarded-for ending in the relay network marks a relay visitor.
      INTERNAL_NETWORKS: '127.0.0.1/32',
      RELAY_NETWORKS: '172.31.77.0/24',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('jellylab-push did not start')), 10000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  proc?.kill();
  jellyfin?.close();
  await rm(dir, { recursive: true, force: true });
});

// What npm sends for a visitor who came in through the relay.
const RELAYED = { 'x-forwarded-for': '203.0.113.9, 172.31.77.2' };

const put = (id, body, headers = {}) => fetch(`${base}/filters/content/${id}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('the shared secret can write the store', async () => {
  const res = await put('kid-0000-00000001', { blockedTags: [5, 6], name: 'talha' }, { 'x-filter-store-secret': 'shared-secret' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { blockedTags: [5, 6], hideAdult: false, name: 'talha' });
  const doc = JSON.parse(await readFile(join(dir, 'content-filters.json'), 'utf8'));
  assert.deepEqual(doc.users['kid-0000-00000001'].blockedTags, [5, 6]);
});

test('a wrong secret and no token cannot', async () => {
  assert.equal((await put('kid-0000-00000001', { blockedTags: [] }, { 'x-filter-store-secret': 'nope' })).status, 401);
  assert.equal((await put('kid-0000-00000001', { blockedTags: [] })).status, 401);
  const doc = JSON.parse(await readFile(join(dir, 'content-filters.json'), 'utf8'));
  assert.deepEqual(doc.users['kid-0000-00000001'].blockedTags, [5, 6], 'unchanged');
});

test('reading the store needs a signed-in administrator', async () => {
  assert.equal((await fetch(`${base}/filters/content`)).status, 401);
  assert.equal((await fetch(`${base}/filters/keywords?query=gore`)).status, 401);
});

test('the filter page is served', async () => {
  const res = await fetch(`${base}/filters/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Content filters/);
});

test('existing routes still answer', async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('at home nothing asks for a sign-in', async () => {
  assert.equal((await fetch(`${base}/storage`)).status, 200);
  assert.equal((await fetch(`${base}/downloads`)).status, 200);
  assert.equal((await fetch(`${base}/filters/admin`)).status, 200);
});

test('through the relay, looking needs a Jellyfin sign-in', async () => {
  for (const path of ['/storage', '/downloads', '/filters', '/filters/for?user=x']) {
    assert.equal((await fetch(`${base}${path}`, { headers: RELAYED })).status, 401, `${path} without a token`);
    assert.equal((await fetch(`${base}${path}`, { headers: { ...RELAYED, 'x-emby-token': 'made-up' } })).status, 401, `${path} with a bad token`);
    assert.equal((await fetch(`${base}${path}`, { headers: { ...RELAYED, 'x-emby-token': GOOD } })).status, 200, `${path} signed in`);
  }
  const storage = await (await fetch(`${base}/storage`, { headers: { ...RELAYED, 'x-emby-token': GOOD } })).json();
  assert.equal(typeof storage.free, 'number');
});

test('through the relay, a sign-in is remembered rather than rechecked on every poll', async () => {
  const signed = { ...RELAYED, 'x-emby-token': GOOD };
  await fetch(`${base}/downloads`, { headers: signed });
  const calls = meCalls;
  assert.ok(calls > 0, 'the token was checked against Jellyfin at least once');
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/downloads`, { headers: signed })).status, 200);
  assert.equal(meCalls, calls);
});

test('through the relay, nothing can be changed, signed in or not', async () => {
  const signed = { ...RELAYED, 'x-emby-token': GOOD, 'content-type': 'application/json' };
  const refused = [
    ['POST', '/cancel', { tmdbId: 1, type: 'movie' }],
    ['POST', '/monitor', { tmdbId: 1, type: 'movie', monitored: false }],
    ['GET', '/candidates?tmdbId=1&type=movie'],
    ['POST', '/logs', 'a log'],
    ['PUT', '/filters', { filters: [] }],
    ['POST', '/filters/apply'],
    ['GET', '/filters/admin'],
    ['POST', '/filters/login', { username: 'admin', password: 'x' }],
    ['GET', '/filters/content'],
    ['GET', '/filters/keywords?query=x'],
  ];
  for (const [method, path, body] of refused) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: signed,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  // Not even with the store secret, which is for seerr-guard inside Docker.
  const store = await put('kid-0000-00000001', { blockedTags: [] }, { ...RELAYED, 'x-filter-store-secret': 'shared-secret' });
  assert.equal(store.status, 403);
  const doc = JSON.parse(await readFile(join(dir, 'content-filters.json'), 'utf8'));
  assert.deepEqual(doc.users['kid-0000-00000001'].blockedTags, [5, 6], 'unchanged');
});

test('only the hop npm appended decides', async () => {
  // A visitor at home cannot make itself look relayed by what it sends, and a
  // relay visitor cannot make itself look local by adding a LAN address.
  assert.equal((await fetch(`${base}/storage`, { headers: { 'x-forwarded-for': '172.31.77.2, 192.168.1.10' } })).status, 200);
  assert.equal((await fetch(`${base}/storage`, { headers: { 'x-forwarded-for': '192.168.1.10, 172.31.77.2' } })).status, 401);
});

test('the public path prefix is understood', async () => {
  assert.deepEqual(await (await fetch(`${base}/jellylab-push/health`)).json(), { ok: true });
  assert.equal((await fetch(`${base}/jellylab-push/storage`, { headers: { ...RELAYED, 'x-emby-token': GOOD } })).status, 200);
  assert.equal((await fetch(`${base}/jellylab-push/cancel`, { method: 'POST', headers: { ...RELAYED, 'x-emby-token': GOOD } })).status, 403);
  assert.equal((await fetch(`${base}/jellylab-pushy/health`)).status, 404);
});
