/**
 * The wording of Sonarr and Radarr pushes, and the batching.
 *
 * Against a fake ntfy, a fake Radarr queue and a fake Sonarr, because what
 * matters is what lands on the phone: how many pushes, and what they say.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let ntfy;
let radarr;
let sonarr;
let notify;
const sent = [];

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const decode = (h) => {
  const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(h ?? '');
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : h;
};

before(async () => {
  ntfy = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    sent.push({ title: decode(req.headers.title), body, tags: req.headers.tags, priority: req.headers.priority });
    res.end('{}');
  });
  radarr = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ records: [{
      downloadId: 'ABC123',
      statusMessages: [{ title: 'x', messages: ['Found matching movie via grab history, but release was matched to movie by ID. Manual Import required.'] }],
    }] }));
  });
  sonarr = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(fakeSonarr(url)));
  });
  process.env.SONARR_URL = `http://127.0.0.1:${await listen(sonarr)}`;
  process.env.SONARR_API_KEY = 'key';
  process.env.NTFY_URL = `http://127.0.0.1:${await listen(ntfy)}`;
  process.env.NTFY_TOPIC = 'topic';
  process.env.RADARR_URL = `http://127.0.0.1:${await listen(radarr)}`;
  process.env.RADARR_API_KEY = 'key';
  process.env.NOTIFY_QUIET_MS = '100000';
  notify = await import('../notify.mjs');
});

after(() => {
  ntfy.close();
  radarr.close();
  sonarr.close();
});

/*
 * One anime as Sonarr sees it: 24-minute episodes 1-13, and an OVA it counts
 * as number 11. File 201 is a normal episode, 202 a 3-minute extra filed as
 * episode 2, 203 the release's 12 filed as episode 11 (it took 11 for the OVA).
 */
const EPISODES = [
  { seasonNumber: 0, episodeNumber: 1, absoluteEpisodeNumber: 11, runtime: 25, episodeFileId: 0 },
  ...Array.from({ length: 13 }, (_, i) => ({
    seasonNumber: 1, episodeNumber: i + 1, absoluteEpisodeNumber: i + 1 < 11 ? i + 1 : i + 2, runtime: 24,
    episodeFileId: { 1: 201, 2: 202, 11: 203 }[i + 1] ?? 0,
  })),
];
const FILES = { 201: '24:10', 202: '3:05', 203: '24:30' };
function fakeSonarr(url) {
  const path = url.pathname.replace('/api/v3/', '');
  if (path === 'episode') return EPISODES;
  if (path === 'series/7') return { runtime: 24 };
  if (path.startsWith('episodefile/')) return { mediaInfo: { runTime: FILES[path.split('/')[1]] } };
  if (path === 'parse') {
    const title = url.searchParams.get('title');
    const se = /S(\d+)E(\d+)/.exec(title);
    const abs = / - (\d+) /.exec(title);
    return { parsedEpisodeInfo: se
      ? { seasonNumber: +se[1], episodeNumbers: [+se[2]], absoluteEpisodeNumbers: [] }
      : { episodeNumbers: [], absoluteEpisodeNumbers: abs ? [+abs[1]] : [] } };
  }
  return {};
}

const episode = (n, extra = {}) => ({
  sonarr_eventtype: 'Download',
  sonarr_series_title: 'an anime',
  sonarr_episodefile_seasonnumber: '1',
  sonarr_episodefile_episodenumbers: String(n),
  sonarr_episodefile_episodetitles: `Title ${n}`,
  sonarr_episodefile_quality: 'HDTV-1080p',
  sonarr_isupgrade: 'False',
  ...extra,
});

test('ranges collapse runs', () => {
  assert.equal(notify.ranges([30, 31, 32, 35, 38, 39, 40, 122]), '30–32, 35, 38–40, 122');
  assert.equal(notify.ranges([5]), '5');
});

test('thirty episodes are one push, not thirty', async () => {
  sent.length = 0;
  for (const n of [54, 55, 56, 57, 60, 122]) await notify.handleArrEvent(episode(n));
  assert.equal(sent.length, 0, 'nothing sent while the series is still arriving');
  await notify.flushAll();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'an anime: 6 new episodes');
  assert.equal(sent[0].body, 'Season 1: episodes 54–57, 60, 122\nHDTV-1080p');
});

test('a single episode keeps its title', async () => {
  sent.length = 0;
  await notify.handleArrEvent(episode(8, { sonarr_series_title: 'a show', sonarr_episodefile_episodetitles: 'Episode Title', sonarr_episodefile_quality: 'WEBDL-1080p' }));
  await notify.flushAll();
  assert.deepEqual([sent[0].title, sent[0].body], ['a show: new episode', 'S1E8 · Episode Title\nWEBDL-1080p']);
});

test('upgrades are reported apart from new episodes', async () => {
  sent.length = 0;
  await notify.handleArrEvent(episode(1));
  await notify.handleArrEvent(episode(2, { sonarr_isupgrade: 'True' }));
  await notify.flushAll();
  assert.deepEqual(sent.map(s => s.title).sort(), ['an anime: better copy of an episode', 'an anime: new episode']);
});

test('a film goes out at once', async () => {
  sent.length = 0;
  await notify.handleArrEvent({ radarr_eventtype: 'Download', radarr_movie_title: 'a film', radarr_movie_year: '2021', radarr_moviefile_quality: 'Bluray-1080p' });
  assert.deepEqual([sent[0].title, sent[0].body], ['New film: a film (2021)', 'Bluray-1080p']);
});

test('a stuck import says why, from the queue', async () => {
  sent.length = 0;
  const event = {
    radarr_eventtype: 'ManualInteractionRequired',
    radarr_movie_title: 'a film',
    radarr_movie_year: '2010',
    radarr_download_id: 'abc123',
    radarr_download_title: 'a film (2010) [1080p]',
  };
  await notify.handleArrEvent(event);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Needs a hand: a film (2010)');
  assert.match(sent[0].body, /different name than the title it was grabbed for/);
  assert.match(sent[0].body, /Don't delete the torrent yet/);
  assert.equal(sent[0].priority, 'high');

  await notify.handleArrEvent(event);
  assert.equal(sent.length, 1, 'the same download is not reported twice');
});

test('an unknown reason is passed through untouched', () => {
  assert.equal(notify.plainReason(['Something new went wrong']), 'Something new went wrong');
  assert.equal(notify.plainReason([]), null);
});

test('events that are not imports are ignored', async () => {
  sent.length = 0;
  assert.deepEqual(await notify.handleArrEvent({ sonarr_eventtype: 'Grab' }), { ignored: 'Grab' });
  await assert.rejects(notify.handleArrEvent({}), /not a sonarr or radarr event/);
  assert.equal(sent.length, 0);
});

const imported = (fileId, n, source) => episode(n, {
  sonarr_series_id: '7', sonarr_episodefile_id: String(fileId),
  sonarr_episodefile_sourcepath: `/media/downloads/batch/${source}`,
});

test('minutes reads Sonarr run times', () => {
  assert.equal(notify.minutes('24:30'), 24.5);
  assert.equal(notify.minutes('1:11:00'), 71);
  assert.equal(notify.minutes(''), null);
});

test('a file that fits its episode raises nothing', async () => {
  sent.length = 0;
  await notify.handleArrEvent(imported(201, 1, 'an anime - S01E01 [1080p].mkv'));
  await notify.flushAll();
  assert.equal(sent.length, 1, 'only the usual new-episode push');
});

test('a 3-minute extra filed as an episode is questioned', async () => {
  sent.length = 0;
  await notify.handleArrEvent(imported(202, 2, 'an anime Audio Dramas - S01E02.mkv'));
  await notify.flushAll();
  const doubt = sent.find(s => s.title === 'Check this: an anime');
  assert.ok(doubt, 'a separate warning push');
  assert.equal(doubt.priority, 'high');
  assert.match(doubt.body, /S01E02: the file is 3 min, the episode should be about 24 min/);
});

test('straight-through numbering across a bonus episode is questioned', async () => {
  sent.length = 0;
  await notify.handleArrEvent(imported(203, 11, '[Group] an anime - 12 [1080p].mkv'));
  await notify.flushAll();
  const doubt = sent.find(s => s.title === 'Check this: an anime');
  assert.ok(doubt);
  assert.match(doubt.body, /this file is its 12/);
  assert.match(doubt.body, /bonus episode S00E01 as number 11/);
});

test('straight-through numbering below the bonus episode is fine', () => {
  assert.deepEqual(notify.importDoubts({ label: 'S01E05', fileMinutes: 24, expectedMinutes: 24,
    straightNumbers: [5], bonus: [{ label: 'S00E01', number: 11 }] }), []);
});

test('a film-length file on one episode is questioned', () => {
  const [doubt] = notify.importDoubts({ label: 'S01E01', fileMinutes: 71, expectedMinutes: 24 });
  assert.match(doubt, /71 min.*about 24 min.*a film or several episodes/);
});
