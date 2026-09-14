import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSION, hasPermission, keyOf, parseIds, readStore, entryForUser, hiddenSet,
  classify, rowKey, collectKeys, filterBody, singleTitleKey, detailKeywords, makeHider,
  filterCollectionProps, rewriteNextData, buildIdOf, mergeSettings, splitSettings,
  allowedChanges, parseCidrs, isInternalPeer, isPrivileged, addressIn, viaRelay,
} from '../filter.mjs';

const ADULT = [256466, 155477, 195669, 198385, 356759, 341367];

const storeText = (extra = {}) => JSON.stringify({
  version: 2,
  adultTags: ADULT,
  users: {
    kid: { name: 'talha', blockedTags: [1, 2], hideAdult: false },
    self: { name: 'furkan', blockedTags: [], hideAdult: true },
  },
  canary: null,
  ...extra,
});

test('permissions: ADMIN implies everything, others are exact bits', () => {
  assert.equal(hasPermission(PERMISSION.ADMIN, PERMISSION.MANAGE_USERS), true);
  assert.equal(hasPermission(PERMISSION.MANAGE_USERS, PERMISSION.MANAGE_USERS), true);
  assert.equal(hasPermission(32 + 128, PERMISSION.MANAGE_USERS), false);
  assert.equal(hasPermission(undefined, PERMISSION.REQUEST), false);
});

test('parseIds accepts every shape the fork and store used, and drops junk and zero', () => {
  assert.deepEqual(parseIds('["256466","155477"]'), [155477, 256466]);
  assert.deepEqual(parseIds('12, 34,,0,x'), [12, 34]);
  assert.deepEqual(parseIds([3, '2', 2, -1, 1.5]), [2, 3]);
  assert.deepEqual(parseIds(''), []);
  assert.deepEqual(parseIds(null), []);
  assert.deepEqual(parseIds('[broken'), []);
});

test('readStore parses a valid store and rejects anything it does not understand', () => {
  const store = readStore(storeText());
  assert.deepEqual(store.users.get('kid').blockedTags, [1, 2]);
  assert.equal(store.users.get('self').hideAdult, true);
  assert.deepEqual(store.adultTags, [...ADULT].sort((a, b) => a - b));
  assert.throws(() => readStore('{"version":1,"users":{}}'), /version/);
  assert.throws(() => readStore('{"version":2,"users":[]}'), /users/);
  assert.throws(() => readStore('not json'));
  assert.throws(() => readStore(storeText({ canary: { seerrUserId: 'x' } })), /canary/);
});

test('entryForUser matches by Jellyfin id, and the canary by Seerr id', () => {
  const store = readStore(storeText({ canary: { seerrUserId: 9, blockedTags: [7], hiddenTitle: 'movie:1', cleanTitle: 'movie:2', keywordId: 7 } }));
  assert.equal(entryForUser(store, { id: 3, jellyfinUserId: 'kid' }).name, 'talha');
  assert.deepEqual(entryForUser(store, { id: 9 }).blockedTags, [7]);
  assert.equal(entryForUser(store, { id: 4, jellyfinUserId: 'nobody' }), null);
  assert.equal(entryForUser(store, { id: 5 }), null);
  assert.equal(entryForUser(null, { id: 1 }), null);
});

test('hiddenSet adds the adult ids only when the switch is on', () => {
  const store = readStore(storeText());
  assert.deepEqual([...hiddenSet(store.users.get('kid'), store.adultTags)].sort(), [1, 2]);
  assert.equal(hiddenSet(store.users.get('self'), store.adultTags).size, ADULT.length);
  assert.equal(hiddenSet(null, store.adultTags).size, 0);
});

test('classify: API routes', () => {
  assert.deepEqual(classify('GET', '/api/v1/user/5/settings/main'), { kind: 'settings', seerrUserId: 5 });
  assert.deepEqual(classify('POST', '/api/v1/user/5/settings/main'), { kind: 'settings', seerrUserId: 5 });
  assert.equal(classify('POST', '/api/v1/request').kind, 'create-request');
  assert.equal(classify('POST', '/api/v1/watchlist').kind, 'create-watchlist');
  assert.deepEqual(classify('GET', '/api/v1/movie/603'), { kind: 'api-title', key: 'movie:603', sub: '' });
  assert.deepEqual(classify('GET', '/api/v1/tv/1399/season/2'), { kind: 'api-title', key: 'tv:1399', sub: '/season/2' });
  assert.deepEqual(classify('GET', '/api/v1/movie/603/recommendations/'), { kind: 'api-title', key: 'movie:603', sub: '/recommendations' });
  assert.deepEqual(classify('GET', '/api/v1/request/12'), { kind: 'api-single', resource: 'request' });
  assert.deepEqual(classify('GET', '/api/v1/issue/3'), { kind: 'api-single', resource: 'issue' });
  assert.equal(classify('GET', '/api/v1/discover/trending').kind, 'api-list');
  assert.equal(classify('GET', '/api/v1/person/31/combined_credits').kind, 'api-list');
  assert.equal(classify('GET', '/api/v1/auth/me').kind, 'pass');
  assert.equal(classify('GET', '/api/v1/settings/public').kind, 'pass');
  assert.equal(classify('DELETE', '/api/v1/request/12').kind, 'pass');
  assert.equal(classify('POST', '/api/v1/request/12/approve').kind, 'pass');
});

test('classify: pages, page data, and everything else', () => {
  assert.deepEqual(classify('GET', '/movie/603'), { kind: 'page-title', key: 'movie:603', data: false });
  assert.deepEqual(classify('GET', '/tv/1399/cast'), { kind: 'page-title', key: 'tv:1399', data: false });
  assert.deepEqual(classify('GET', '/_next/data/abc123/movie/603.json'), { kind: 'page-title', key: 'movie:603', data: true });
  assert.deepEqual(classify('GET', '/_next/data/abc123/tv/1399/similar.json'), { kind: 'page-title', key: 'tv:1399', data: true });
  assert.deepEqual(classify('GET', '/collection/10'), { kind: 'page-collection', data: false });
  assert.deepEqual(classify('GET', '/_next/data/abc123/collection/10.json'), { kind: 'page-collection', data: true });
  assert.equal(classify('GET', '/_next/static/chunks/main.js').kind, 'pass');
  assert.equal(classify('GET', '/').kind, 'pass');
  assert.equal(classify('GET', '/movies').kind, 'pass');
  assert.equal(classify('GET', '/imageproxy/t/p/w300/x.jpg').kind, 'pass');
});

test('rowKey reads each row shape, tmdbId before an internal id', () => {
  assert.equal(rowKey({ id: 603, mediaType: 'movie' }), 'movie:603');
  assert.equal(rowKey({ id: 1, tmdbId: 1399, mediaType: 'tv' }), 'tv:1399');
  assert.equal(rowKey({ id: 55, type: 'movie', media: { id: 9, tmdbId: 603, mediaType: 'movie' } }), 'movie:603');
  assert.equal(rowKey({ id: 31, mediaType: 'person' }), null);
  assert.equal(rowKey({ id: 603 }), null);
  assert.equal(rowKey(null), null);
});

test('collectKeys walks results, parts, cast, crew and knownFor', () => {
  const body = {
    results: [
      { id: 1, mediaType: 'movie' },
      { id: 31, mediaType: 'person', knownFor: [{ id: 2, mediaType: 'tv' }] },
    ],
    parts: [{ id: 3, mediaType: 'movie' }],
    cast: [{ id: 4, mediaType: 'movie' }],
    crew: [{ id: 4, mediaType: 'movie' }],
  };
  assert.deepEqual([...collectKeys(body)].sort(), ['movie:1', 'movie:3', 'movie:4', 'tv:2']);
  assert.equal(collectKeys(null).size, 0);
});

test('filterBody removes hidden rows everywhere and leaves counts and other fields alone', () => {
  const body = {
    page: 1, totalResults: 40, totalPages: 2,
    results: [
      { id: 1, mediaType: 'movie' },
      { id: 2, mediaType: 'movie' },
      { id: 31, mediaType: 'person', knownFor: [{ id: 2, mediaType: 'movie' }, { id: 5, mediaType: 'tv' }] },
    ],
    cast: [{ id: 2, mediaType: 'movie' }],
  };
  const hide = (key) => key === 'movie:2';
  const { body: out, removed } = filterBody(body, hide);
  assert.equal(removed, 3);
  assert.deepEqual(out.results.map(rowKey), ['movie:1', null]);
  assert.deepEqual(out.results[1].knownFor.map(rowKey), ['tv:5']);
  assert.deepEqual(out.cast, []);
  assert.equal(out.totalResults, 40);
  assert.equal(body.results.length, 3, 'input is not mutated');
});

test('filterBody hands back the very same object when nothing is hidden', () => {
  const body = { results: [{ id: 1, mediaType: 'movie' }] };
  const { body: out, removed } = filterBody(body, () => false);
  assert.equal(out, body);
  assert.equal(removed, 0);
  assert.deepEqual(filterBody([1, 2], () => true), { body: [1, 2], removed: 0 });
  assert.deepEqual(filterBody(null, () => true), { body: null, removed: 0 });
});

test('singleTitleKey and detailKeywords', () => {
  assert.equal(singleTitleKey({ id: 12, media: { tmdbId: 603, mediaType: 'movie' } }), 'movie:603');
  assert.equal(singleTitleKey({ id: 12 }), null);
  assert.deepEqual(detailKeywords({ keywords: [{ id: 9, name: 'a' }, { id: 3, name: 'b' }] }), [3, 9]);
  assert.deepEqual(detailKeywords({ keywords: [] }), []);
  assert.equal(detailKeywords({ id: 603 }), null, 'missing keywords means cannot tell, not clean');
});

test('makeHider fails closed on titles it has no verdict for, unless told not to', () => {
  const verdicts = new Map([['movie:1', [5]], ['movie:2', []]]);
  const hide = makeHider(new Set([5]), verdicts);
  assert.equal(hide('movie:1'), true);
  assert.equal(hide('movie:2'), false);
  assert.equal(hide('movie:3'), true);
  assert.equal(makeHider(new Set([5]), verdicts, { failClosed: false })('movie:3'), false);
});

test('collection page props and embedded __NEXT_DATA__ are filtered', () => {
  const pageProps = { collection: { id: 10, name: 'Saga', parts: [{ id: 1, mediaType: 'movie' }, { id: 2, mediaType: 'movie' }] } };
  const hide = (key) => key === 'movie:2';
  const { pageProps: out, removed } = filterCollectionProps(pageProps, hide);
  assert.equal(removed, 1);
  assert.deepEqual(out.collection.parts.map(rowKey), ['movie:1']);
  assert.equal(filterCollectionProps({ other: 1 }, hide).removed, 0);

  const data = { props: { pageProps }, page: '/collection/[collectionId]', buildId: 'b1' };
  const html = `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
  assert.equal(buildIdOf(html), 'b1');
  const { html: rewritten, changed } = rewriteNextData(html, (d) => {
    const r = filterCollectionProps(d.props.pageProps, hide);
    return r.removed ? { ...d, props: { ...d.props, pageProps: r.pageProps } } : d;
  });
  assert.equal(changed, true);
  assert.deepEqual(JSON.parse(/type="application\/json">([\s\S]*?)<\/script>/.exec(rewritten)[1]).props.pageProps.collection.parts.length, 1);
  assert.equal(rewriteNextData('<html></html>', () => ({})).changed, false);
});

test('rewriteNextData escapes < so a title cannot close the script tag', () => {
  const html = '<script id="__NEXT_DATA__" type="application/json">{"a":1}</script>';
  const { html: out } = rewriteNextData(html, () => ({ title: '</script><img>' }));
  assert.equal(out.includes('</script><img>'), false);
  assert.match(out, /\\u003c\/script>/);
});

test('settings shim: merge, split and permission rules match the fork', () => {
  const merged = mergeSettings({ locale: 'nl' }, { blockedTags: [1, 2], hideAdult: true }, [7, 8]);
  assert.deepEqual(merged, { locale: 'nl', blockedTags: '1,2', hideAdult: true, adultTags: '7,8' });
  assert.deepEqual(mergeSettings({ locale: 'nl' }, null, []), { locale: 'nl', blockedTags: '', hideAdult: false, adultTags: '' });

  const { forward, wants } = splitSettings({ locale: 'nl', blockedTags: '3,4', hideAdult: true, adultTags: '9' });
  assert.deepEqual(forward, { locale: 'nl' });
  assert.deepEqual(wants, { blockedTags: [3, 4], hideAdult: true });
  assert.deepEqual(splitSettings({ locale: 'nl' }).wants, {}, 'a missing field keeps what is stored');

  const admin = { id: 1, permissions: PERMISSION.ADMIN };
  const kid = { id: 3, permissions: 32 };
  assert.deepEqual(allowedChanges({ actor: admin, subjectId: 3, wants }), { apply: wants, ignored: [] });
  assert.deepEqual(allowedChanges({ actor: kid, subjectId: 3, wants }), { apply: { hideAdult: true }, ignored: ['blockedTags'] });
  assert.deepEqual(allowedChanges({ actor: kid, subjectId: 4, wants }), { apply: {}, ignored: ['blockedTags', 'hideAdult'] });
});

test('isInternalPeer: default Docker network and loopback only, never proxied, relay or LAN', () => {
  const ranges = parseCidrs('172.18.0.0/16,127.0.0.1/32, junk, 10.0.0.0/99');
  assert.equal(ranges.length, 2);
  assert.equal(isInternalPeer('172.18.0.16', {}, ranges), true);
  assert.equal(isInternalPeer('::ffff:172.18.0.16', {}, ranges), true);
  assert.equal(isInternalPeer('127.0.0.1', {}, ranges), true);
  assert.equal(isInternalPeer('::1', {}, ranges), true);
  assert.equal(isInternalPeer('172.18.0.14', { 'x-forwarded-for': '192.168.1.10' }, ranges), false);
  assert.equal(isInternalPeer('172.31.77.2', {}, ranges), false);
  assert.equal(isInternalPeer('192.168.1.10', {}, ranges), false);
  assert.equal(isInternalPeer('garbage', {}, ranges), false);
});

test('keyOf', () => {
  assert.equal(keyOf('tv', 1399), 'tv:1399');
});

test('isPrivileged: admins, settings and user managers, but not request managers', () => {
  assert.equal(isPrivileged(2), true);
  assert.equal(isPrivileged(4), true);
  assert.equal(isPrivileged(8), true);
  assert.equal(isPrivileged(16 + 32 + 128), false, 'request + auto-approve + manage requests is day-to-day use');
  assert.equal(isPrivileged(0), false);
});

test('viaRelay trusts only the last forwarded address, and only from inside Docker', () => {
  const internal = parseCidrs('172.18.0.0/16,127.0.0.1/32');
  const relay = parseCidrs('172.31.77.0/24');
  assert.equal(viaRelay('172.18.0.14', { 'x-forwarded-for': '172.31.77.2' }, internal, relay), true);
  assert.equal(viaRelay('172.18.0.14', { 'x-forwarded-for': '203.0.113.9, 172.31.77.2' }, internal, relay), true, 'whatever the visitor sent stays on the left');
  assert.equal(viaRelay('172.18.0.14', { 'x-forwarded-for': '172.31.77.2, 192.168.1.10' }, internal, relay), false, 'a forged relay address on the left does not count');
  assert.equal(viaRelay('172.18.0.14', { 'x-forwarded-for': '192.168.1.10' }, internal, relay), false);
  assert.equal(viaRelay('192.168.1.10', { 'x-forwarded-for': '172.31.77.2' }, internal, relay), false, 'only npm inside Docker can vouch for the address');
  assert.equal(viaRelay('172.18.0.14', {}, internal, relay), false);
  assert.equal(viaRelay('172.18.0.14', { 'x-forwarded-for': '172.31.77.2' }, internal, []), false, 'off unless configured');
  assert.equal(addressIn('::1', internal), true);
});
