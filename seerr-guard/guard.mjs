/**
 * seerr-guard - per-user content filtering in front of stock Seerr.
 *
 * Everybody reaches Seerr through this: browsers, the JellyLab app, Homarr,
 * npm. For a person with no hidden keywords it is a plain streaming proxy and
 * adds nothing. For a filtered person it removes hidden titles from every list
 * Seerr returns, answers 404 for a hidden title's page and API, and refuses a
 * request for one.
 *
 * It exists so Seerr itself can run unmodified and update like any other
 * image. The same filter used to be a fork of Seerr, which had to be rebased and
 * rebuilt by hand on every release. Stock Seerr cannot carry per-user rules in
 * its own blocklist - a blocklisted title is refused to *everyone*, on the
 * server - so the decision is made here, per title, from the TMDB keywords
 * Seerr's own detail endpoint returns.
 *
 * Fails closed. A title that has not been checked yet, a filter store that
 * exists but cannot be read, or a person who cannot be identified all mean
 * "hide" for anyone who might be filtered. The worst case is a short page for a
 * child, not an unfiltered one. (No store file at all means no filters were
 * ever set up, and nobody is filtered.)
 *
 * The rules live in filter.mjs, which does no I/O and is covered by
 * test/filter.test.mjs. No npm dependencies: stock node image, file mounted in.
 */

import http from 'node:http';
import zlib from 'node:zlib';
import { readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  PERMISSION, hasPermission, keyOf, readStore, entryForUser, hiddenSet, classify,
  collectKeys, filterBody, singleTitleKey, detailKeywords, makeHider,
  filterCollectionProps, rewriteNextData, buildIdOf, mergeSettings, splitSettings,
  allowedChanges, parseCidrs, isInternalPeer, rowKey,
} from './filter.mjs';

const {
  GUARD_PORT = '5055',
  SEERR_URL = 'http://jellyseerr:5055',
  SEERR_API_KEY = '',
  STORE_PATH = '/filters/content-filters.json',
  CACHE_PATH = '/data/keywords.json',
  PUSH_URL = 'http://jellylab-push:8099',
  FILTER_STORE_SECRET = '',
  // "shadow" decides and logs but never changes a response - for running in
  // front of the old fork and comparing before anything depends on this.
  GUARD_MODE = 'enforce',
  INTERNAL_NETWORKS = '172.18.0.0/16,127.0.0.1/32',
  LOOKUP_BUDGET_MS = '3000',
  STORE_RECHECK_MS = '2000',
} = process.env;

const SHADOW = GUARD_MODE === 'shadow';
const BUDGET = Number(LOOKUP_BUDGET_MS) || 3000;
const INTERNAL = parseCidrs(INTERNAL_NETWORKS);
const UPSTREAM = new URL(SEERR_URL);
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const DAY = 24 * 60 * 60 * 1000;
const TTL_KNOWN = 30 * DAY;
const TTL_MISSING = DAY;
const MAX_BODY = 16 * 1024 * 1024;
const MEDIA = new Set(['movie', 'tv']);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const delay = (ms) => new Promise((r) => setTimeout(r, ms).unref());

/* ================================================================ HTTP helpers */

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/*
 * Anything that is not a shared static asset can differ per person, so no
 * cache may ever reuse it across people - and a browser or phone is exactly
 * such a cache when two people use the same device.
 *
 * This was a real leak. Seerr tags its JSON with an ETag. A device that had
 * searched as an unfiltered person asked again, as a filtered one, with
 * If-None-Match; Seerr compared against its own unfiltered answer and said 304
 * Not Modified; the guard passed the 304 on, and the device showed its cached
 * unfiltered results. So for these paths the conditional headers never reach
 * Seerr (it always sends a full answer, which is then filtered), and responses
 * carry no validators and are never stored.
 */
const SHARED_STATIC = /^\/(_next\/static\/|imageproxy\/|avatarproxy\/|images\/|favicon|logo|sw\.js|site\.webmanifest|manifest|apple-|android-|offline|robots\.txt)/;
const isPersonal = (url) => !SHARED_STATIC.test(String(url ?? ''));

function upstreamHeaders(req, { identity = false, bodyLength = null } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP.has(name)) headers[name] = value;
  }
  const peer = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${peer}` : peer;
  headers['x-forwarded-proto'] ??= 'http';
  headers['x-forwarded-host'] ??= req.headers.host ?? '';
  if (identity) headers['accept-encoding'] = 'identity';
  if (isPersonal(req.url)) {
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }
  if (bodyLength !== null) {
    headers['content-length'] = String(bodyLength);
    delete headers['transfer-encoding'];
  }
  return headers;
}

function upstreamOptions(req, opts) {
  return {
    protocol: UPSTREAM.protocol,
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || 80,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, opts),
    agent,
  };
}

function responseHeaders(headers, { rewritten = false, personal = false } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP.has(name)) continue;
    if (rewritten && (name === 'content-length' || name === 'content-encoding' || name === 'etag')) continue;
    if (personal && (name === 'etag' || name === 'last-modified' || name === 'cache-control' || name === 'expires' || name === 'vary')) continue;
    out[name] = value;
  }
  return personal ? { ...out, ...PRIVATE } : out;
}

/** Plain streaming proxy: nothing buffered, nothing changed. */
function streamProxy(req, res, { body = null } = {}) {
  const up = http.request(upstreamOptions(req, { bodyLength: body ? body.length : null }), (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, responseHeaders(upRes.headers, { personal: isPersonal(req.url) }));
    upRes.pipe(res);
  });
  up.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 502, { message: `Seerr is not reachable: ${err.message}` });
    else res.destroy();
  });
  res.on('close', () => up.destroy());
  if (body) up.end(body);
  else req.pipe(up);
}

/** Fetch the upstream response in full, decoded, for inspecting or rewriting. */
function fetchUpstream(req, { body = null } = {}) {
  return new Promise((resolve, reject) => {
    const up = http.request(upstreamOptions(req, { identity: true, bodyLength: body ? body.length : null }), (upRes) => {
      const chunks = [];
      let size = 0;
      upRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          up.destroy(new Error('upstream response too large to inspect'));
          return;
        }
        chunks.push(chunk);
      });
      upRes.on('end', () => {
        let buffer = Buffer.concat(chunks);
        const headers = { ...upRes.headers };
        // Asked for identity, but a server may compress regardless.
        const encoding = String(headers['content-encoding'] ?? '').toLowerCase();
        try {
          if (encoding === 'gzip' || encoding === 'x-gzip') buffer = zlib.gunzipSync(buffer);
          else if (encoding === 'br') buffer = zlib.brotliDecompressSync(buffer);
          else if (encoding === 'deflate') buffer = zlib.inflateSync(buffer);
          if (encoding) delete headers['content-encoding'];
        } catch (err) {
          reject(new Error(`cannot decode ${encoding} response: ${err.message}`));
          return;
        }
        delete headers['content-length'];
        resolve({ status: upRes.statusCode ?? 502, headers, buffer });
      });
      upRes.on('error', reject);
    });
    up.on('error', reject);
    if (body) up.end(body);
    else up.end();
  });
}

const isJson = (headers) => /\bjson\b/i.test(String(headers['content-type'] ?? ''));
const isHtml = (headers) => /text\/html/i.test(String(headers['content-type'] ?? ''));

function relay(res, up, extra = {}) {
  // Only personal paths are ever fetched in full, so everything relayed is personal.
  const headers = { ...responseHeaders(up.headers, { rewritten: true, personal: true }), ...extra, 'content-length': String(up.buffer.length) };
  res.writeHead(up.status, headers);
  res.end(up.buffer);
}

/*
 * A response rewritten for one person must never be served to another from a
 * cache, and must not replace the unfiltered copy in anyone's browser cache.
 */
const PRIVATE = { 'cache-control': 'private, no-store', vary: 'Cookie, X-Api-Key, X-Api-User' };

function sendBody(res, status, headers, buffer) {
  res.writeHead(status, { ...headers, 'content-length': String(buffer.length) });
  res.end(buffer);
}

function sendJson(res, status, obj, extra = {}) {
  const buffer = Buffer.from(JSON.stringify(obj));
  sendBody(res, status, { 'content-type': 'application/json; charset=utf-8', ...PRIVATE, ...extra }, buffer);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ===================================================================== store */

let storeState = { ok: false, error: 'not loaded yet', store: null, mtimeMs: -1, checkedAt: 0 };

/**
 * The filter store, re-read when the file changes (checked at most every 2 s).
 *
 * jellylab-push is the only writer. It replaces the file atomically, so a read
 * here sees either the old document or the new one, never half of each.
 */
async function currentStore() {
  const now = Date.now();
  if (now - storeState.checkedAt < (Number(STORE_RECHECK_MS) || 2000)) return storeState;
  storeState.checkedAt = now;
  try {
    const info = await stat(STORE_PATH);
    if (info.mtimeMs !== storeState.mtimeMs || !storeState.ok) {
      const store = readStore(await readFile(STORE_PATH, 'utf8'));
      const wasBroken = !storeState.ok;
      storeState = { ok: true, error: null, store, mtimeMs: info.mtimeMs, checkedAt: now };
      log(`filter store ${wasBroken ? 'loaded' : 'reloaded'}: ${store.users.size} people${store.canary ? ', canary configured' : ''}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      /*
       * No store at all means nobody is filtered, the same as jellylab-push
       * reads it. Without this a stack that never set up filters would lock
       * every non-admin out of Seerr. A store that exists and cannot be parsed
       * is the dangerous case, and that one still fails closed below. Where
       * filters are in use, the canary monitor turns red the moment the file
       * disappears, because the canary lives in it.
       */
      if (!storeState.missing) log('no filter store: nobody is filtered');
      storeState = { ok: true, missing: true, error: null, store: { users: new Map(), adultTags: [], canary: null }, mtimeMs: -1, checkedAt: now };
      return storeState;
    }
    if (storeState.ok || storeState.error !== err.message) log(`filter store unavailable, failing closed: ${err.message}`);
    storeState = { ok: false, error: err.message, store: null, mtimeMs: -1, checkedAt: now };
  }
  return storeState;
}

async function putStore(jellyfinUserId, changes) {
  const res = await fetch(`${PUSH_URL}/filters/content/${encodeURIComponent(jellyfinUserId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-filter-store-secret': FILTER_STORE_SECRET },
    body: JSON.stringify(changes),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`jellylab-push answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  storeState.checkedAt = 0;
}

/* ================================================================== verdicts */

/*
 * A title's TMDB keyword ids, keyed `movie:603`. Keywords on a title almost
 * never change, so a verdict is trusted for 30 days and a stale one is still
 * used while it is refreshed in the background. Persisted, so a restart does
 * not make every page slow again.
 */
const verdicts = new Map();
const inflight = new Map();
let cacheDirty = false;

async function loadCache() {
  try {
    const doc = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    for (const [key, v] of Object.entries(doc.entries ?? {})) {
      if (Array.isArray(v.k) && Number.isFinite(v.at)) verdicts.set(key, { keywords: v.k, at: v.at, ttl: v.ttl ?? TTL_KNOWN });
    }
    log(`keyword cache: ${verdicts.size} titles`);
  } catch (err) {
    if (err.code !== 'ENOENT') log(`keyword cache unreadable, starting empty: ${err.message}`);
  }
}

async function saveCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  const entries = {};
  for (const [key, v] of verdicts) entries[key] = { k: v.keywords, at: v.at, ttl: v.ttl };
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, entries }), 'utf8');
    await rename(tmp, CACHE_PATH);
  } catch (err) {
    cacheDirty = true;
    log(`keyword cache not saved: ${err.message}`);
  }
}

function remember(key, keywords, ttl = TTL_KNOWN) {
  verdicts.set(key, { keywords, at: Date.now(), ttl });
  cacheDirty = true;
}

let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 8) await new Promise((r) => waiting.push(r));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function lookup(key) {
  if (inflight.has(key)) return inflight.get(key);
  const [type, id] = key.split(':');
  const promise = limited(async () => {
    if (!SEERR_API_KEY) throw new Error('SEERR_API_KEY is not set');
    const res = await fetch(`${SEERR_URL}/api/v1/${type}/${id}`, {
      headers: { 'x-api-key': SEERR_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) {
      remember(key, [], TTL_MISSING);
      return [];
    }
    if (!res.ok) throw new Error(`seerr /${type}/${id} -> ${res.status}`);
    const keywords = detailKeywords(await res.json());
    if (keywords === null) throw new Error(`seerr /${type}/${id} has no keywords field`);
    remember(key, keywords);
    return keywords;
  }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  promise.catch((err) => log(`keyword lookup failed for ${key}: ${err.message}`));
  return promise;
}

/** Known keywords for a title (stale allowed), refreshing expired ones in the background. */
function verdictOf(key) {
  const v = verdicts.get(key);
  if (!v) return undefined;
  if (Date.now() - v.at > v.ttl && !inflight.has(key)) lookup(key).catch(() => {});
  return v.keywords;
}

const verdictView = { get: verdictOf };

/** Look up whatever is unknown, but never wait longer than the budget. */
async function ensureVerdicts(keys, budget = BUDGET) {
  const unknown = [...keys].filter((key) => verdictOf(key) === undefined);
  if (!unknown.length) return;
  const all = Promise.allSettled(unknown.map((key) => lookup(key)));
  await Promise.race([all, delay(budget)]);
}

/* ===================================================================== users */

const sessions = new Map();
const usersById = new Map();

const normalizeUser = (u) => ({
  id: u.id,
  permissions: Number(u.permissions) | 0,
  jellyfinUserId: u.jellyfinUserId || null,
  name: u.displayName || u.jellyfinUsername || u.username || u.email || `#${u.id}`,
});

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function trimCache(map) {
  if (map.size > 5000) map.clear();
}

async function userById(id) {
  const cached = usersById.get(id);
  if (cached && cached.until > Date.now()) return cached.user;
  const res = await fetch(`${SEERR_URL}/api/v1/user/${id}`, {
    headers: { 'x-api-key': SEERR_API_KEY },
    signal: AbortSignal.timeout(5000),
  });
  let user = null;
  if (res.ok) user = normalizeUser(await res.json());
  else if (res.status !== 404) throw new Error(`seerr /user/${id} -> ${res.status}`);
  trimCache(usersById);
  usersById.set(id, { user, until: Date.now() + 60000 });
  return user;
}

/**
 * Who is making this request, as Seerr will see it.
 *
 * The same two ways Seerr authenticates: its API key (acting as user 1, or as
 * the user named in X-API-User), or the connect.sid session cookie. null means
 * anonymous; a thrown error means Seerr could not be asked, which the caller
 * treats very differently.
 */
async function resolveUser(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && SEERR_API_KEY && apiKey === SEERR_API_KEY) {
    return userById(Number(req.headers['x-api-user']) || 1);
  }
  const sid = cookieValue(req.headers.cookie, 'connect.sid');
  if (!sid) return null;
  const cached = sessions.get(sid);
  if (cached && cached.until > Date.now()) return cached.user;
  const res = await fetch(`${SEERR_URL}/api/v1/auth/me`, {
    headers: { cookie: `connect.sid=${sid}` },
    signal: AbortSignal.timeout(5000),
  });
  let user = null;
  if (res.ok) user = normalizeUser(await res.json());
  else if (res.status !== 401 && res.status !== 403) throw new Error(`seerr /auth/me -> ${res.status}`);
  trimCache(sessions);
  sessions.set(sid, { user, until: Date.now() + (user ? 60000 : 10000) });
  return user;
}

/* ================================================================= decisions */

function decided(ctx, action, key, req) {
  const path = new URL(req.url, 'http://guard').pathname;
  log(`${SHADOW ? 'would ' : ''}${action}${key ? ` ${key}` : ''} for ${ctx.user.name} (#${ctx.user.id}) ${req.method} ${path}`);
}

async function titleHidden(ctx, key, budget = BUDGET) {
  if (verdictOf(key) === undefined) await Promise.race([lookup(key).catch(() => {}), delay(budget)]);
  return ctx.hide(key);
}

let notFoundPage = { at: 0, buffer: null, type: 'text/html; charset=utf-8' };

/** Seerr's own not-found page, so a hidden title looks like one that does not exist. */
async function sendNotFoundPage(req, res) {
  if (!notFoundPage.buffer || Date.now() - notFoundPage.at > 5 * 60 * 1000) {
    try {
      const up = await fetch(`${SEERR_URL}/seerr-guard-not-found`, {
        headers: { 'accept-language': req.headers['accept-language'] ?? 'en', accept: 'text/html' },
        signal: AbortSignal.timeout(5000),
      });
      notFoundPage = { at: Date.now(), buffer: Buffer.from(await up.arrayBuffer()), type: up.headers.get('content-type') ?? 'text/html; charset=utf-8' };
    } catch {
      notFoundPage = { at: Date.now(), buffer: Buffer.from('<!doctype html><title>404</title><h1>404 - Page not found</h1>'), type: 'text/html; charset=utf-8' };
    }
  }
  sendBody(res, 404, { 'content-type': notFoundPage.type, ...PRIVATE, 'x-seerr-guard': 'hidden' }, notFoundPage.buffer);
}

const hiddenJson = (res) => sendJson(res, 404, { message: 'Not found' }, { 'x-seerr-guard': 'hidden' });

async function listResponse(req, res, ctx) {
  const up = await fetchUpstream(req);
  if (up.status < 200 || up.status >= 300 || !isJson(up.headers)) return relay(res, up);
  let body;
  try {
    body = JSON.parse(up.buffer.toString('utf8'));
  } catch {
    return relay(res, up);
  }
  const keys = collectKeys(body);
  if (!keys.size) return relay(res, up, PRIVATE);
  await ensureVerdicts(keys);
  const { body: out, removed } = filterBody(body, ctx.hide);
  if (!removed) return relay(res, up, PRIVATE);
  decided(ctx, `filter ${removed} row(s) from`, null, req);
  if (SHADOW) return relay(res, up, PRIVATE);
  return sendJson(res, up.status, out, { 'x-seerr-guard': 'filtered' });
}

async function titleResponse(req, res, ctx, route) {
  if (route.sub) {
    // A sub-path of a hidden title - season, ratings, recommendations - is as
    // hidden as the title itself. Its own lists are then filtered as usual.
    if (await titleHidden(ctx, route.key)) {
      decided(ctx, '404', route.key, req);
      if (!SHADOW) return hiddenJson(res);
    }
    return listResponse(req, res, ctx);
  }

  const up = await fetchUpstream(req);
  if (up.status !== 200 || !isJson(up.headers)) return relay(res, up);
  let body;
  try {
    body = JSON.parse(up.buffer.toString('utf8'));
  } catch {
    return relay(res, up);
  }
  // The detail response names its own keywords, so it is decided from itself
  // and cached for everyone - no second lookup.
  const keywords = detailKeywords(body);
  if (keywords) remember(route.key, keywords);
  if (ctx.hide(route.key)) {
    decided(ctx, '404', route.key, req);
    if (!SHADOW) return hiddenJson(res);
  }
  return relay(res, up, PRIVATE);
}

async function singleResponse(req, res, ctx) {
  const up = await fetchUpstream(req);
  if (up.status !== 200 || !isJson(up.headers)) return relay(res, up);
  let key = null;
  try {
    key = singleTitleKey(JSON.parse(up.buffer.toString('utf8')));
  } catch {
    return relay(res, up);
  }
  if (key && (await titleHidden(ctx, key))) {
    decided(ctx, '404', key, req);
    if (!SHADOW) return hiddenJson(res);
  }
  return relay(res, up, PRIVATE);
}

async function createResponse(req, res, ctx, route) {
  const raw = await readBody(req);
  let parsed = null;
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    // Seerr answers malformed bodies itself.
    return streamProxy(req, res, { body: raw });
  }
  const mediaType = parsed?.mediaType;
  const tmdbId = Number(route.kind === 'create-request' ? parsed?.mediaId : parsed?.tmdbId);
  if (MEDIA.has(mediaType) && Number.isInteger(tmdbId)) {
    const key = keyOf(mediaType, tmdbId);
    if (await titleHidden(ctx, key, Math.max(BUDGET, 5000))) {
      decided(ctx, '403', key, req);
      if (!SHADOW) return sendJson(res, 403, { message: 'This media is not available to you.' }, { 'x-seerr-guard': 'blocked' });
    }
  }
  return streamProxy(req, res, { body: raw });
}

async function pageTitleResponse(req, res, ctx, route) {
  if (await titleHidden(ctx, route.key)) {
    decided(ctx, '404', route.key, req);
    if (!SHADOW) {
      // A 404 on page data makes the Next.js router load the page URL for real,
      // which then lands on the not-found page below.
      return route.data ? sendJson(res, 404, { notFound: true }, { 'x-seerr-guard': 'hidden' }) : sendNotFoundPage(req, res);
    }
  }
  return streamProxy(req, res);
}

async function pageCollectionResponse(req, res, ctx, route) {
  const up = await fetchUpstream(req);
  if (up.status !== 200) return relay(res, up);

  if (route.data) {
    if (!isJson(up.headers)) return relay(res, up);
    let body;
    try {
      body = JSON.parse(up.buffer.toString('utf8'));
    } catch {
      return relay(res, up);
    }
    await ensureVerdicts(collectKeys(body.pageProps?.collection ?? {}));
    const { pageProps, removed } = filterCollectionProps(body.pageProps, ctx.hide);
    if (!removed) return relay(res, up, PRIVATE);
    decided(ctx, `filter ${removed} part(s) from`, null, req);
    if (SHADOW) return relay(res, up, PRIVATE);
    return sendJson(res, 200, { ...body, pageProps }, { 'x-seerr-guard': 'filtered' });
  }

  if (!isHtml(up.headers)) return relay(res, up);
  const html = up.buffer.toString('utf8');
  let data = null;
  rewriteNextData(html, (d) => {
    data = d;
    return d;
  });
  await ensureVerdicts(collectKeys(data?.props?.pageProps?.collection ?? {}));
  let removedTotal = 0;
  const { html: rewritten } = rewriteNextData(html, (d) => {
    const { pageProps, removed } = filterCollectionProps(d?.props?.pageProps, ctx.hide);
    removedTotal = removed;
    return removed ? { ...d, props: { ...d.props, pageProps } } : d;
  });
  if (!removedTotal) return relay(res, up, PRIVATE);
  decided(ctx, `filter ${removedTotal} part(s) from`, null, req);
  if (SHADOW) return relay(res, up, PRIVATE);
  const headers = { ...responseHeaders(up.headers, { rewritten: true, personal: true }), 'x-seerr-guard': 'filtered' };
  return sendBody(res, 200, headers, Buffer.from(rewritten, 'utf8'));
}

/* ============================================= fork API compatibility shim */

async function settingsResponse(req, res, route, user) {
  if (SHADOW) return streamProxy(req, res);
  const state = await currentStore();
  const subject = route.seerrUserId === user.id ? user : await userById(route.seerrUserId).catch(() => null);
  const entryOf = (s) => (s.ok ? entryForUser(s.store, subject ?? { id: route.seerrUserId }) : null);
  const merge = (up, s) => {
    if (up.status < 200 || up.status >= 300 || !isJson(up.headers)) return relay(res, up);
    let body;
    try {
      body = JSON.parse(up.buffer.toString('utf8'));
    } catch {
      return relay(res, up);
    }
    return sendJson(res, up.status, mergeSettings(body, entryOf(s), s.ok ? s.store.adultTags : []));
  };

  if (req.method === 'GET') return merge(await fetchUpstream(req), state);

  const raw = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return streamProxy(req, res, { body: raw });
  }
  const { forward, wants } = splitSettings(parsed);
  const up = await fetchUpstream(req, { body: Buffer.from(JSON.stringify(forward)) });
  if (up.status >= 200 && up.status < 300 && Object.keys(wants).length) {
    const { apply, ignored } = allowedChanges({ actor: user, subjectId: route.seerrUserId, wants });
    if (ignored.length) log(`ignored ${ignored.join(', ')} from ${user.name} (#${user.id}) for user #${route.seerrUserId}: not allowed`);
    if (Object.keys(apply).length) {
      if (!subject?.jellyfinUserId) {
        log(`filter change for user #${route.seerrUserId} dropped: no Jellyfin account to key it by`);
      } else {
        try {
          await putStore(subject.jellyfinUserId, { ...apply, name: subject.name });
          log(`filter changed for ${subject.name} by ${user.name}: ${JSON.stringify(apply)}`);
        } catch (err) {
          return sendJson(res, 502, { message: `Settings saved, but the content filter could not be updated: ${err.message}` });
        }
      }
    }
  }
  return merge(up, await currentStore());
}

/* ================================================================ internal */

function sendText(res, status, text) {
  sendBody(res, status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, Buffer.from(text));
}

async function decideEndpoint(res, url) {
  const user = await userById(Number(url.searchParams.get('user')));
  if (!user) return sendJson(res, 404, { message: 'no such Seerr user' });
  const state = await currentStore();
  if (!state.ok) return sendJson(res, 503, { message: `store: ${state.error}` });
  const hidden = hiddenSet(entryForUser(state.store, user), state.store.adultTags);
  const keys = String(url.searchParams.get('keys') ?? '').split(',').filter((k) => /^(movie|tv):\d+$/.test(k));
  await ensureVerdicts(keys, 15000);
  const hide = makeHider(hidden, verdictView, { failClosed: false });
  const titles = {};
  for (const key of keys) {
    const keywords = verdictOf(key);
    titles[key] = keywords === undefined ? 'unknown' : hide(key) ? 'hidden' : 'visible';
  }
  return sendJson(res, 200, { user: user.name, filtered: hidden.size > 0, hiddenKeywords: [...hidden], titles });
}

/**
 * Prove the filter still works, as a filtered person would experience it.
 *
 * Uptime Kuma polls this and alerts on anything but `ok`. It goes through this
 * very server, as the canary account, so a Seerr update that renames a route or
 * drops the keywords field shows up here the next morning instead of as a
 * child seeing something they should not. The canary has no request
 * permission, so even a broken guard cannot turn the request check into a
 * real request.
 */
async function canaryEndpoint(res) {
  if (SHADOW) return sendText(res, 503, 'shadow mode: not enforcing');
  const state = await currentStore();
  if (!state.ok) return sendText(res, 500, `FAIL store: ${state.error}`);
  const canary = state.store.canary;
  if (!canary) return sendText(res, 500, 'FAIL no canary configured in the store');

  const base = `http://127.0.0.1:${GUARD_PORT}`;
  const as = { 'x-api-key': SEERR_API_KEY, 'x-api-user': String(canary.seerrUserId) };
  const [hiddenType, hiddenId] = canary.hiddenTitle.split(':');
  const [cleanType, cleanId] = canary.cleanTitle.split(':');
  const failures = [];
  const check = async (name, fn) => {
    try {
      const problem = await fn();
      if (problem) failures.push(`${name}: ${problem}`);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  };
  const get = (path, headers = {}) => fetch(`${base}${path}`, { headers: { ...as, ...headers }, redirect: 'manual', signal: AbortSignal.timeout(20000) });

  await check('hidden title API', async () => {
    const r = await get(`/api/v1/${hiddenType}/${hiddenId}`);
    return r.status === 404 && r.headers.get('x-seerr-guard') === 'hidden' ? null : `expected guarded 404, got ${r.status}`;
  });
  let buildId = null;
  await check('clean title API', async () => {
    const r = await get(`/api/v1/${cleanType}/${cleanId}`);
    if (r.status !== 200) return `expected 200, got ${r.status}`;
    return detailKeywords(await r.json()) === null ? 'detail response no longer carries keywords' : null;
  });
  await check('hidden title page', async () => {
    const r = await get(`/${hiddenType}/${hiddenId}`, { accept: 'text/html' });
    return r.status === 404 ? null : `expected 404, got ${r.status}`;
  });
  // Title pages render only for a browser session, and the canary has none, so
  // the build id is read from the login page, which anyone may load.
  await check('page build id', async () => {
    const r = await fetch(`${base}/login`, { headers: { accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (r.status !== 200) return `expected the login page, got ${r.status}`;
    buildId = buildIdOf(await r.text());
    return buildId ? null : 'no __NEXT_DATA__ build id on the login page';
  });
  if (buildId) {
    await check('hidden title page data', async () => {
      const r = await get(`/_next/data/${buildId}/${hiddenType}/${hiddenId}.json`);
      return r.status === 404 ? null : `expected 404, got ${r.status}`;
    });
  }
  await check('request for hidden title', async () => {
    const r = await fetch(`${base}/api/v1/request`, {
      method: 'POST',
      headers: { ...as, 'content-type': 'application/json' },
      body: JSON.stringify({ mediaType: hiddenType, mediaId: Number(hiddenId) }),
      signal: AbortSignal.timeout(20000),
    });
    return r.status === 403 && r.headers.get('x-seerr-guard') === 'blocked' ? null : `expected guarded 403, got ${r.status}`;
  });
  if (hiddenType === 'movie' && canary.keywordId) {
    await check('keyword list', async () => {
      const r = await get(`/api/v1/discover/keyword/${canary.keywordId}/movies`);
      if (r.status !== 200) return `expected 200, got ${r.status}`;
      const body = await r.json();
      return (body.results ?? []).some((row) => rowKey(row) === canary.hiddenTitle) ? 'hidden title is listed' : null;
    });
  }

  if (failures.length) {
    log(`canary FAILED: ${failures.join(' | ')}`);
    return sendText(res, 500, `FAIL ${failures.join(' | ')}`);
  }
  return sendText(res, 200, 'ok');
}

async function internal(req, res, url) {
  if (url.pathname === '/__guard/health') {
    const state = await currentStore();
    return sendJson(res, state.ok ? 200 : 503, {
      ok: state.ok,
      mode: SHADOW ? 'shadow' : 'enforce',
      store: state.ok ? 'ok' : state.error,
      people: state.ok ? state.store.users.size : 0,
      cachedTitles: verdicts.size,
    });
  }
  if (!isInternalPeer(req.socket.remoteAddress, req.headers, INTERNAL)) return sendText(res, 403, 'internal only');
  if (url.pathname === '/__guard/canary') return canaryEndpoint(res);
  if (url.pathname === '/__guard/decide') return decideEndpoint(res, url);
  return sendText(res, 404, 'not found');
}

/* =================================================================== server */

async function handle(req, res) {
  const url = new URL(req.url, 'http://guard');
  if (url.pathname.startsWith('/__guard/')) return internal(req, res, url);

  const route = classify(req.method, url.pathname);
  if (route.kind === 'pass') return streamProxy(req, res);

  let user = null;
  try {
    user = await resolveUser(req);
  } catch (err) {
    // Seerr could not say who this is. Anyone might be filtered, so content is
    // withheld until it can - unless Seerr itself is down, in which case the
    // request would fail anyway and passing it on gives the real error.
    log(`cannot identify caller for ${req.method} ${url.pathname}: ${err.message}`);
    if (route.kind !== 'settings' && !SHADOW) {
      return sendJson(res, 503, { message: 'Could not verify who you are. Try again in a moment.' }, { 'x-seerr-guard': 'unavailable' });
    }
    return streamProxy(req, res);
  }
  if (!user) return streamProxy(req, res);

  if (route.kind === 'settings') return settingsResponse(req, res, route, user);

  const state = await currentStore();
  if (!state.ok) {
    if (hasPermission(user.permissions, PERMISSION.MANAGE_USERS) || SHADOW) return streamProxy(req, res);
    log(`withheld ${req.method} ${url.pathname} from ${user.name}: filter store unavailable`);
    const message = 'Content filters are unavailable right now.';
    return route.kind === 'page-title' && !route.data
      ? sendText(res, 503, message)
      : sendJson(res, 503, { message }, { 'x-seerr-guard': 'unavailable' });
  }

  const hidden = hiddenSet(entryForUser(state.store, user), state.store.adultTags);
  if (!hidden.size) return streamProxy(req, res);

  const ctx = { user, hidden, hide: makeHider(hidden, verdictView) };
  switch (route.kind) {
    case 'api-title': return titleResponse(req, res, ctx, route);
    case 'api-single': return singleResponse(req, res, ctx);
    case 'api-list': return listResponse(req, res, ctx);
    case 'create-request':
    case 'create-watchlist': return createResponse(req, res, ctx, route);
    case 'page-title': return pageTitleResponse(req, res, ctx, route);
    case 'page-collection': return pageCollectionResponse(req, res, ctx, route);
    default: return streamProxy(req, res);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`error on ${req.method} ${req.url}: ${err.stack ?? err.message}`);
    if (!res.headersSent) sendJson(res, err.status ?? 502, { message: err.status === 413 ? err.message : 'seerr-guard failed on this request' });
    else res.destroy();
  });
});
server.keepAliveTimeout = 65000;

await loadCache();
await currentStore();
setInterval(() => saveCache(), 15000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await saveCache();
    process.exit(0);
  });
}
if (!SEERR_API_KEY) log('WARNING: SEERR_API_KEY is not set - every lookup fails, so filtered people see nothing');
if (!FILTER_STORE_SECRET) log('WARNING: FILTER_STORE_SECRET is not set - filter changes from the app cannot be saved');
server.listen(Number(GUARD_PORT), () => log(`seerr-guard ${SHADOW ? 'SHADOW' : 'enforcing'} on :${GUARD_PORT} -> ${SEERR_URL}`));
