/**
 * Requests that are going nowhere, said once.
 *
 * A Seerr request stays "Requested" for as long as Radarr or Sonarr is
 * looking, and nothing ever closes one that cannot be filled. I Adore You
 * (2015) was requested on 2026-09-22 and three weeks later still read
 * "Requested" with no download behind it and no copy anywhere worth having.
 * Seerr cannot decline a request once it is approved (only pending ones), so
 * the honest thing left is to say so: one push per request, once it has been
 * obtainable for STALE_DAYS and still has not arrived, with the reason.
 *
 * Read-only on purpose. It never declines, deletes, unmonitors or
 * blocklists anything: Radarr and Sonarr go on looking, and a copy that
 * turns up later still arrives on its own.
 *
 * "Obtainable" matters. A film still in cinemas has nothing to find, and an
 * episode that aired yesterday is not late. The clock starts at the later of
 * the request and the day the title could first have been downloaded: the
 * digital or disc release for a film (cinema + 90 days when neither is known,
 * Radarr's own rule), and the oldest missing episode's air date for a series.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { publish } from './notify.mjs';

const {
  JELLYSEERR_URL = 'http://jellyseerr:5055',
  JELLYSEERR_API_KEY = '',
  SONARR_URL = 'http://sonarr:8989',
  SONARR_API_KEY = '',
  RADARR_URL = 'http://radarr:7878',
  RADARR_API_KEY = '',
} = process.env;

const DAY = 24 * 3600 * 1000;
export const STALE_DAYS = Number(process.env.STALE_DAYS) || 14;
const NOTIFIED_PATH = process.env.STALE_NOTIFIED_PATH || `${process.env.DATA_DIR || '/data'}/stale-notified.json`;

const log = (...a) => console.log(new Date().toISOString(), ...a);

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/** When a film could first have been downloaded, by Radarr's own availability rule. */
export function movieObtainableSince(m) {
  const released = [ms(m.digitalRelease), ms(m.physicalRelease)].filter(Number.isFinite);
  if (m.minimumAvailability === 'announced') return 0;
  if (m.minimumAvailability === 'inCinemas' && Number.isFinite(ms(m.inCinemas))) return ms(m.inCinemas);
  if (released.length) return Math.min(...released);
  if (Number.isFinite(ms(m.inCinemas))) return ms(m.inCinemas) + 90 * DAY;
  return 0;
}

/**
 * The requests that are late, from data already fetched.
 *
 * requests: Seerr requests (filter=processing). movies: Radarr movies.
 * series: Sonarr series. episodes: { [sonarrSeriesId]: episode[] }.
 * moving: set of "movie:<tmdb>" / "tv:<tmdb>" whose download is progressing.
 */
export function findStale({ requests, movies, series, episodes, moving = new Set(), now = Date.now(), days = STALE_DAYS }) {
  const out = [];
  const movieByTmdb = new Map(movies.map(m => [m.tmdbId, m]));
  const seriesByTmdb = new Map(series.map(s => [s.tmdbId, s]));

  for (const r of requests) {
    if (r.is4k || r.status !== 2) continue;
    const tmdbId = r.media?.tmdbId;
    const key = `${r.type}:${tmdbId}`;
    const requestedAt = ms(r.createdAt);
    let since;
    let name;

    if (r.type === 'movie') {
      const m = movieByTmdb.get(tmdbId);
      if (!m || !m.monitored || m.hasFile || !m.isAvailable) continue;
      since = Math.max(requestedAt, movieObtainableSince(m));
      name = m.year ? `${m.title} (${m.year})` : m.title;
    } else if (r.type === 'tv') {
      const s = seriesByTmdb.get(tmdbId);
      if (!s || !s.monitored) continue;
      const seasons = new Set((r.seasons ?? []).map(x => x.seasonNumber));
      const missing = (episodes[s.id] ?? []).filter(e =>
        seasons.has(e.seasonNumber) && e.monitored && !e.hasFile
        && Number.isFinite(ms(e.airDateUtc)) && ms(e.airDateUtc) < now);
      if (!missing.length) continue;
      since = Math.max(requestedAt, Math.min(...missing.map(e => ms(e.airDateUtc))));
      const missingSeasons = [...new Set(missing.map(e => e.seasonNumber))].sort((a, b) => a - b);
      name = `${s.title}, season${missingSeasons.length > 1 ? 's' : ''} ${missingSeasons.join(', ')}`;
      out.push(...late({ r, key, since, name, now, days, moving, missing: missing.length }));
      continue;
    } else {
      continue;
    }
    out.push(...late({ r, key, since, name, now, days, moving }));
  }
  return out;
}

function late({ r, key, since, name, now, days, moving, missing }) {
  if (!Number.isFinite(since) || now - since < days * DAY) return [];
  if (moving.has(key)) return [];
  return [{
    requestId: r.id,
    key,
    type: r.type,
    tmdbId: r.media?.tmdbId,
    name,
    requestedBy: r.requestedBy?.displayName || r.requestedBy?.username || 'someone',
    requestedAt: r.createdAt,
    days: Math.floor((now - since) / DAY),
    ...(missing ? { missing } : {}),
  }];
}

/*
 * Why it is late, from what the background sweep (index.mjs) and the queue
 * already know. Ordered by how much it tells a person to do.
 */
export function reasonFor({ download, verdict }) {
  if (download) {
    const pct = Math.round(100 * (download.livePercent ?? download.percent ?? 0));
    return `The download is stuck at ${pct}%: nobody is sharing it right now.`;
  }
  if (verdict && verdict.accepted > 0 && (verdict.bestSeeders ?? 0) >= 5) {
    return `Copies are available (${verdict.bestSeeders} people sharing the best one) but nothing grabbed one. `
      + 'A search in Radarr or Sonarr will most likely fix it.';
  }
  if (verdict && verdict.accepted > 0) {
    return 'The only copies online have (almost) nobody sharing them.';
  }
  if (verdict) {
    const quality = Object.keys(verdict.rejections ?? {}).find(k => /not wanted in profile/i.test(k));
    return quality
      ? 'No copy in a quality you allow exists online (there are only worse ones).'
      : 'No copy of it can be found online.';
  }
  return 'Nothing has been downloaded yet.';
}

export function staleMessage(item, reason) {
  const app = item.type === 'tv' ? 'Sonarr' : 'Radarr';
  const on = new Date(item.requestedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return {
    title: `Still not here after ${item.days} days: ${item.name}`,
    body: [
      `Requested by ${item.requestedBy} on ${on}.`,
      reason,
      `${app} keeps looking, and it will arrive by itself if a copy turns up.`,
    ].join('\n'),
  };
}

/* ------------------------------------------------------------------- I/O */

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url.replace(/apikey=[^&]+/, 'apikey=…')} -> ${res.status}`);
  return res.json();
}

async function loadNotified() {
  try {
    return JSON.parse(await readFile(NOTIFIED_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`stale: notified list unreadable, starting fresh: ${err.message}`);
    return {};
  }
}

async function saveNotified(doc) {
  await mkdir(NOTIFIED_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(`${NOTIFIED_PATH}.tmp`, JSON.stringify(doc), 'utf8');
  await rename(`${NOTIFIED_PATH}.tmp`, NOTIFIED_PATH);
}

// Progress per download between ticks, to tell a slow download from a dead one.
const lastPercent = new Map();

/**
 * Look once. `downloads` maps "movie:<tmdb>" / "tv:<tmdb>" to the queue
 * summary index.mjs builds; `verdictFor(key)` returns the sweep's answer.
 * With send false it only reports what it would say.
 */
export async function check({ downloads = {}, verdictFor = () => null, send = true, now = Date.now() } = {}) {
  if (!JELLYSEERR_API_KEY || !RADARR_API_KEY || !SONARR_API_KEY) return { skipped: 'missing api key' };

  const requests = [];
  for (let skip = 0; ; skip += 100) {
    const page = await getJson(`${JELLYSEERR_URL}/api/v1/request?filter=processing&take=100&skip=${skip}`,
      { 'X-Api-Key': JELLYSEERR_API_KEY });
    requests.push(...(page.results ?? []));
    if ((page.results ?? []).length < 100) break;
  }
  const [movies, series] = await Promise.all([
    getJson(`${RADARR_URL}/api/v3/movie?apikey=${RADARR_API_KEY}`),
    getJson(`${SONARR_URL}/api/v3/series?apikey=${SONARR_API_KEY}`),
  ]);

  const wantedTv = new Set(requests.filter(r => r.type === 'tv').map(r => r.media?.tmdbId));
  const episodes = {};
  for (const s of series.filter(x => wantedTv.has(x.tmdbId))) {
    episodes[s.id] = await getJson(`${SONARR_URL}/api/v3/episode?seriesId=${s.id}&apikey=${SONARR_API_KEY}`);
  }

  // Moving = more done than last time we looked, or bytes arriving right now.
  const moving = new Set();
  for (const [key, d] of Object.entries(downloads)) {
    const pct = d.livePercent ?? d.percent ?? 0;
    if ((d.liveSpeed ?? 0) > 0 || pct > (lastPercent.get(key) ?? Infinity)) moving.add(key);
    lastPercent.set(key, pct);
  }

  const stale = findStale({ requests, movies, series, episodes, moving, now });
  const notified = await loadNotified();
  const live = new Set(requests.map(r => String(r.id)));
  for (const id of Object.keys(notified)) if (!live.has(id)) delete notified[id];

  const report = [];
  for (const item of stale) {
    const msg = staleMessage(item, reasonFor({ download: downloads[item.key], verdict: verdictFor(item.key) }));
    const already = Boolean(notified[item.requestId]);
    report.push({ ...item, ...msg, notified: already ? notified[item.requestId] : null });
    if (send && !already) {
      await publish({ ...msg, tags: 'hourglass' });
      notified[item.requestId] = new Date(now).toISOString();
      log(`stale: told about request ${item.requestId} (${item.name}, ${item.days} days)`);
    }
  }
  if (send) await saveNotified(notified);
  return { stale: report };
}
