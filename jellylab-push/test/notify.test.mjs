/**
 * The wording of Sonarr and Radarr pushes, and the batching.
 *
 * Against a fake ntfy and a fake Radarr queue, because what matters is what
 * lands on the phone: how many pushes, and what they say.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let ntfy;
let radarr;
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
});

const episode = (n, extra = {}) => ({
  sonarr_eventtype: 'Download',
  sonarr_series_title: 'Black Clover',
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
  assert.equal(sent[0].title, 'Black Clover: 6 new episodes');
  assert.equal(sent[0].body, 'Season 1: episodes 54–57, 60, 122\nHDTV-1080p');
});

test('a single episode keeps its title', async () => {
  sent.length = 0;
  await notify.handleArrEvent(episode(8, { sonarr_series_title: 'Lanterns', sonarr_episodefile_episodetitles: 'Dirt and Stars', sonarr_episodefile_quality: 'WEBDL-1080p' }));
  await notify.flushAll();
  assert.deepEqual([sent[0].title, sent[0].body], ['Lanterns: new episode', 'S1E8 · Dirt and Stars\nWEBDL-1080p']);
});

test('upgrades are reported apart from new episodes', async () => {
  sent.length = 0;
  await notify.handleArrEvent(episode(1));
  await notify.handleArrEvent(episode(2, { sonarr_isupgrade: 'True' }));
  await notify.flushAll();
  assert.deepEqual(sent.map(s => s.title).sort(), ['Black Clover: better copy of an episode', 'Black Clover: new episode']);
});

test('a film goes out at once', async () => {
  sent.length = 0;
  await notify.handleArrEvent({ radarr_eventtype: 'Download', radarr_movie_title: 'Dune', radarr_movie_year: '2021', radarr_moviefile_quality: 'Bluray-1080p' });
  assert.deepEqual([sent[0].title, sent[0].body], ['New film: Dune (2021)', 'Bluray-1080p']);
});

test('a stuck import says why, from the queue', async () => {
  sent.length = 0;
  const event = {
    radarr_eventtype: 'ManualInteractionRequired',
    radarr_movie_title: 'The Chronicles of Narnia: The Voyage of the Dawn Treader',
    radarr_movie_year: '2010',
    radarr_download_id: 'abc123',
    radarr_download_title: 'The Chronicles of Narnia - Voyage of the Dawn Tredder (2010) [1080p]',
  };
  await notify.handleArrEvent(event);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Needs a hand: The Chronicles of Narnia: The Voyage of the Dawn Treader (2010)');
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
