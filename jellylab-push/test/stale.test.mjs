/**
 * Which requests count as late, and what the push says about them.
 *
 * Pure functions over the shapes Seerr, Radarr and Sonarr return, so the
 * cases below are the real ones that prompted this: a film long released
 * with no copy, films still in cinemas, a series whose newest episode aired
 * yesterday.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStale, movieObtainableSince, reasonFor, staleMessage } from '../stale.mjs';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const request = (id, type, tmdbId, created, extra = {}) => ({
  id, type, status: 2, is4k: false, createdAt: created,
  media: { tmdbId }, requestedBy: { displayName: 'mo' }, ...extra,
});
const movie = (tmdbId, extra) => ({
  tmdbId, title: `Film ${tmdbId}`, year: 2015, monitored: true, hasFile: false, isAvailable: true,
  minimumAvailability: 'released', ...extra,
});

const run = (over) => findStale({ requests: [], movies: [], series: [], episodes: {}, now: NOW, days: 14, ...over });

test('a released film requested three weeks ago is late', () => {
  const out = run({
    requests: [request(107, 'movie', 372113, daysAgo(19))],
    movies: [movie(372113, { inCinemas: '2015-09-24T00:00:00Z' })],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].days, 19);
  assert.equal(out[0].name, 'Film 372113 (2015)');
});

test('a film requested last week is not late yet', () => {
  assert.equal(run({
    requests: [request(1, 'movie', 5, daysAgo(7))],
    movies: [movie(5, { inCinemas: '2015-01-01T00:00:00Z' })],
  }).length, 0);
});

test('the clock starts when the film could first be downloaded, not at the request', () => {
  // Requested in cinemas a month ago, digital release five days ago.
  const m = movie(6, { inCinemas: daysAgo(40), digitalRelease: daysAgo(5) });
  assert.equal(run({ requests: [request(2, 'movie', 6, daysAgo(30))], movies: [m] }).length, 0);
  // Cinema only, no release dates: Radarr's cinema + 90 days.
  assert.equal(movieObtainableSince(movie(7, { inCinemas: '2026-01-01T00:00:00Z' })),
    Date.parse('2026-01-01T00:00:00Z') + 90 * 86400000);
});

test('still in cinemas, already on disk, or no longer monitored: never late', () => {
  const requests = [request(1, 'movie', 1, daysAgo(60)), request(2, 'movie', 2, daysAgo(60)), request(3, 'movie', 3, daysAgo(60))];
  const movies = [movie(1, { isAvailable: false }), movie(2, { hasFile: true }), movie(3, { monitored: false })];
  assert.equal(run({ requests, movies }).length, 0);
});

test('a download still making progress is not late', () => {
  const out = run({
    requests: [request(1, 'movie', 9, daysAgo(30))],
    movies: [movie(9, { inCinemas: '2015-01-01T00:00:00Z' })],
    moving: new Set(['movie:9']),
  });
  assert.equal(out.length, 0);
});

test('a series is late by its oldest missing aired episode in the requested seasons', () => {
  const series = [{ id: 40, tmdbId: 400, title: 'Show', monitored: true }];
  const ep = (season, n, aired, hasFile = false) => ({ seasonNumber: season, episodeNumber: n, airDateUtc: aired, monitored: true, hasFile });
  const requests = [request(9, 'tv', 400, daysAgo(30), { seasons: [{ seasonNumber: 2 }] })];

  // Season 2's only missing episode aired yesterday: not late.
  let out = run({ requests, series, episodes: { 40: [ep(2, 1, daysAgo(40), true), ep(2, 2, daysAgo(1))] } });
  assert.equal(out.length, 0);

  // Missing since twenty days ago: late. Season 1 is not part of the request.
  out = run({ requests, series, episodes: { 40: [ep(1, 1, daysAgo(400)), ep(2, 1, daysAgo(20)), ep(2, 2, daysAgo(13))] } });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Show, season 2');
  assert.equal(out[0].missing, 2);
  assert.equal(out[0].days, 20);

  // Not aired at all: nothing is missing yet.
  out = run({ requests, series, episodes: { 40: [ep(2, 1, null)] } });
  assert.equal(out.length, 0);
});

test('the reason tells you whether to act', () => {
  assert.match(reasonFor({ download: { livePercent: 0 } }), /stuck at 0%/);
  assert.match(reasonFor({ verdict: { accepted: 15, bestSeeders: 100 } }), /search in Radarr or Sonarr will most likely fix it/);
  assert.match(reasonFor({ verdict: { accepted: 2, bestSeeders: 1 } }), /nobody sharing/);
  assert.match(reasonFor({ verdict: { accepted: 0, rejections: { 'DVD is not wanted in profile': 7 } } }), /only worse ones/);
  assert.match(reasonFor({ verdict: { accepted: 0, rejections: {} } }), /No copy of it can be found/);
  assert.match(reasonFor({}), /Nothing has been downloaded/);
});

test('the push reads as a sentence', () => {
  const msg = staleMessage(
    { type: 'movie', name: 'I Adore You (2015)', requestedBy: 'mo', requestedAt: '2026-09-22T10:00:00Z', days: 19 },
    'No copy of it can be found online.');
  assert.equal(msg.title, 'Still not here after 19 days: I Adore You (2015)');
  assert.equal(msg.body, 'Requested by mo on 22 Sept.\nNo copy of it can be found online.\nRadarr keeps looking, and it will arrive by itself if a copy turns up.');
});
