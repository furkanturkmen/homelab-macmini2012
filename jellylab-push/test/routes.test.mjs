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

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jellylab-push-routes-'));
  const probe = http.createServer();
  const port = await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
  await new Promise((r) => probe.close(r));
  proc = spawn(process.execPath, [join(HERE, '..', 'index.mjs')], {
    env: {
      ...process.env,
      PUSH_PORT: String(port),
      DATA_DIR: dir,
      CONTENT_FILTERS_PATH: join(dir, 'content-filters.json'),
      KEYWORD_CACHE_PATH: join(dir, 'keywords.json'),
      FILTERS_PATH: join(dir, 'filters.json'),
      FILTER_STORE_SECRET: 'shared-secret',
      JELLYFIN_URL: 'http://127.0.0.1:9',
      JELLYFIN_API_KEY: '',
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
  await rm(dir, { recursive: true, force: true });
});

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
