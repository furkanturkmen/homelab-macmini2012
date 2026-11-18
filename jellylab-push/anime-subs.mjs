/**
 * Anime with English ASS subtitles where there is a choice.
 *
 * ASS subtitles know where each line goes: a sign at the top of the picture,
 * dialogue at the bottom, two speakers apart. SRT has no positions, so a
 * converted sign lands on top of the dialogue and both are unreadable; the
 * overlap merge (scripts/subtitle-overlap.py) can only stack them. And a "raw"
 * release has no English at all, leaving Bazarr's SRT the only option.
 *
 * Release names do not say what is inside, so the choice is made from what
 * files have actually shown:
 *
 * 1. Every imported anime file is looked at in Jellyfin, and its release group
 *    is counted as shipping English ASS or not. Groups that do (at least
 *    ASS_MIN_FILES files, ASS_SHARE of them with English ASS) are written into
 *    the Sonarr custom format "English ASS group", which every profile scores
 *    +ASS_BONUS: equal releases tip toward them, nothing else is refused.
 * 2. A file without English ASS gets one look for a replacement: the same
 *    episodes from one of those groups, at the same or better resolution, that
 *    Sonarr would otherwise accept. If there is one it is grabbed and the
 *    current file stays until it has arrived; if not, the file is kept. Either
 *    way it is said once, and that season is not looked at again for
 *    RETRY_DAYS, so nothing loops.
 * 3. A replacement Sonarr will not import because it does not score higher
 *    ("not an upgrade") is imported by hand from the queue, since swapping is
 *    exactly what was asked for. Until then it is tagged "Keep" in
 *    qBittorrent: decluttarr removes "not an upgrade" downloads within minutes
 *    and leaves Keep alone. The tag comes off once the swap has left the
 *    queue, so decluttarr looks after it like any other download again.
 *
 * SRT-only anime is still downloaded as before. This only prefers.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { publish } from './notify.mjs';

const {
  SONARR_URL = 'http://sonarr:8989',
  SONARR_API_KEY = '',
  JELLYFIN_URL = 'http://jellyfin:8096',
  JELLYFIN_API_KEY = '',
  QBIT_URL = '',
  QBIT_USER = '',
  QBIT_PASSWORD = '',
} = process.env;

export const KEEP_TAG = 'Keep';

const STORE_PATH = process.env.ANIME_SUBS_PATH || `${process.env.DATA_DIR || '/data'}/anime-subs.json`;
export const FORMAT_NAME = 'English ASS group';
export const ASS_BONUS = 30;
export const ASS_MIN_FILES = 3;
export const ASS_SHARE = 0.8;
const RETRY_DAYS = 30;
const DAY = 24 * 3600 * 1000;
// Files of one season arrive over a few minutes; act once they have settled.
const SETTLE_MS = Number(process.env.ANIME_SUBS_SETTLE_MS) || 5 * 60 * 1000;
// Jellyfin may need a while to pick a new file up.
const FIND_TRIES = 10;
const FIND_WAIT_MS = 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ pure */

const ENGLISH = new Set(['eng', 'en', 'english']);

/**
 * What English subtitles a Jellyfin item has inside it: 'ass', 'other' (SRT,
 * WebVTT, PGS…) or 'none'. Sidecar files are not counted: they say nothing
 * about the release, and Bazarr adds SRT ones later anyway.
 */
export function englishSubs(streams = []) {
  const english = streams.filter(s => s.Type === 'Subtitle' && !s.IsExternal
    && ENGLISH.has(String(s.Language ?? '').toLowerCase()));
  if (english.some(s => ['ass', 'ssa'].includes(String(s.Codec).toLowerCase()))) return 'ass';
  return english.length ? 'other' : 'none';
}

/** Groups that have shown English ASS often enough to be preferred. */
export function assGroups(groups) {
  return Object.entries(groups)
    .filter(([, c]) => {
      const total = (c.ass ?? 0) + (c.other ?? 0) + (c.none ?? 0);
      return (c.ass ?? 0) >= ASS_MIN_FILES && (c.ass ?? 0) / total >= ASS_SHARE;
    })
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const groupRegex = (names) => `^(${names.map(escape).join('|')})$`;

const rejectionText = (r) => (r.rejections ?? []).map(x => (typeof x === 'string' ? x : x.reason ?? ''));
// What Sonarr says when it already has the episodes: not a reason to skip a
// release we want for its subtitles.
const ONLY_BECAUSE_WE_HAVE_IT = /meets (quality )?cutoff|not an upgrade|existing file/i;

/**
 * The release to swap to, or null. `current` is { resolution, episodes,
 * group }; `assNames` the preferred groups.
 */
export function pickReplacement(releases, current, assNames) {
  const preferred = new Set(assNames.map(n => n.toLowerCase()));
  const candidates = releases.filter(r => {
    if (!r.releaseGroup || !preferred.has(r.releaseGroup.toLowerCase())) return false;
    if (r.releaseGroup.toLowerCase() === String(current.group ?? '').toLowerCase()) return false;
    if ((r.quality?.quality?.resolution ?? 0) < current.resolution) return false;
    if (r.protocol === 'torrent' && !(r.seeders > 0)) return false;
    const covered = new Set(r.mappedEpisodeNumbers ?? []);
    if (!current.episodes.every(n => covered.has(n))) return false;
    return rejectionText(r).every(t => ONLY_BECAUSE_WE_HAVE_IT.test(t));
  });
  // What Sonarr itself would rank higher first, then the best-seeded.
  candidates.sort((a, b) => (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0)
    || (b.seeders ?? 0) - (a.seeders ?? 0));
  return candidates[0] ?? null;
}

/** Queue rows of our swaps that Sonarr will not import on its own. */
export function stuckSwaps(queue, swaps) {
  const ours = new Map(Object.values(swaps).filter(s => s.downloadId && s.result === 'grabbed')
    .map(s => [s.downloadId.toLowerCase(), s]));
  return queue.filter(q => q.downloadId && ours.has(q.downloadId.toLowerCase())
    && q.trackedDownloadState === 'importBlocked');
}

/* ------------------------------------------------------------------ store */

async function loadStore() {
  try {
    const doc = JSON.parse(await readFile(STORE_PATH, 'utf8'));
    return { groups: doc.groups ?? {}, seen: doc.seen ?? {}, swaps: doc.swaps ?? {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { groups: {}, seen: {}, swaps: {} };
    throw err;
  }
}

async function saveStore(store) {
  await mkdir(STORE_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 1));
  await rename(tmp, STORE_PATH);
}

/* ------------------------------------------------------------------ apis */

async function sonarr(path, init) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${SONARR_URL}/api/v3/${path}${sep}apikey=${SONARR_API_KEY}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`sonarr ${path.split('?')[0]} answered ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function jellyfin(path) {
  const res = await fetch(`${JELLYFIN_URL}${path}`, {
    headers: { Authorization: `MediaBrowser Client="jellylab-push", Device="homelab", DeviceId="jellylab-push", Version="1", Token="${JELLYFIN_API_KEY}"` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`jellyfin ${path.split('?')[0]} answered ${res.status}`);
  return res.json();
}

/** Jellyfin's view of these files ({path: streams}), once it has them all. */
async function streamsFor(seriesPath, paths) {
  const all = (await jellyfin('/Items?Recursive=true&IncludeItemTypes=Series&Fields=Path')).Items ?? [];
  const series = all.find(s => s.Path === seriesPath);
  if (!series) return null;
  const eps = (await jellyfin(`/Shows/${series.Id}/Episodes?Fields=MediaStreams,Path`)).Items ?? [];
  const byPath = new Map(eps.map(e => [e.Path, e.MediaStreams ?? []]));
  if (!paths.every(p => byPath.get(p)?.length)) return null;
  return Object.fromEntries(paths.map(p => [p, byPath.get(p)]));
}

/** Keep Sonarr's "English ASS group" format in step with what files showed. */
export async function syncFormat(store) {
  const names = assGroups(store.groups);
  if (!names.length) return;
  const value = groupRegex(names);
  const formats = await sonarr('customformat');
  let format = formats.find(f => f.name === FORMAT_NAME);
  const spec = {
    name: FORMAT_NAME,
    implementation: 'ReleaseGroupSpecification',
    negate: false,
    required: true,
    fields: [{ name: 'value', value }],
  };
  if (!format) {
    format = await sonarr('customformat', { method: 'POST', body: JSON.stringify({
      name: FORMAT_NAME, includeCustomFormatWhenRenaming: false, specifications: [spec] }) });
    log(`anime subs: created "${FORMAT_NAME}" with ${names.length} group(s)`);
  } else if (format.specifications?.[0]?.fields?.find(f => f.name === 'value')?.value !== value
             || format.specifications.length !== 1) {
    await sonarr(`customformat/${format.id}`, { method: 'PUT', body: JSON.stringify({ ...format, specifications: [spec] }) });
    log(`anime subs: "${FORMAT_NAME}" now ${names.length} group(s)`);
  }
  for (const profile of await sonarr('qualityprofile')) {
    const item = profile.formatItems.find(i => i.format === format.id);
    if (item && item.score === ASS_BONUS) continue;
    const formatItems = item
      ? profile.formatItems.map(i => (i.format === format.id ? { ...i, score: ASS_BONUS } : i))
      : [...profile.formatItems, { format: format.id, name: FORMAT_NAME, score: ASS_BONUS }];
    await sonarr(`qualityprofile/${profile.id}`, { method: 'PUT', body: JSON.stringify({ ...profile, formatItems }) });
  }
}

/*
 * qBittorrent, logged in once. Every login is a new session, and a client that
 * logs in per request piles them up (the arrs did, see the qBit session loop);
 * so the cookie is kept and only replaced when qBittorrent refuses it.
 */
let qbitCookie = null;

async function qbitLogin() {
  const res = await fetch(`${QBIT_URL}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: QBIT_USER, password: QBIT_PASSWORD }),
    signal: AbortSignal.timeout(15000),
  });
  const cookie = res.headers.get('set-cookie')?.match(/SID=[^;]+/)?.[0];
  if (!res.ok || !cookie) throw new Error(`qbittorrent login answered ${res.status}`);
  qbitCookie = cookie;
}

async function qbit(path, form) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!qbitCookie) await qbitLogin();
    const res = await fetch(`${QBIT_URL}/api/v2/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: qbitCookie },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 403) { qbitCookie = null; continue; }
    if (!res.ok) throw new Error(`qbittorrent ${path} answered ${res.status}`);
    return res.text();
  }
  throw new Error(`qbittorrent ${path}: refused after a fresh login`);
}

/** The torrent's hash, from what Sonarr's release carries. */
export function torrentHash(release) {
  if (release.infoHash) return release.infoHash.toLowerCase();
  const m = String(release.guid ?? release.magnetUrl ?? '').match(/btih:([0-9a-f]{40})/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Tag a swap Keep. Sonarr hands the torrent to qBittorrent a moment after the
 * grab, so a missing torrent is tried again for a minute.
 */
async function keep(hash) {
  if (!QBIT_URL || !hash) return false;
  for (let i = 0; i < 12; i++) {
    const info = JSON.parse(await qbit('torrents/info', { hashes: hash }) || '[]');
    if (info.length) {
      await qbit('torrents/addTags', { hashes: hash, tags: KEEP_TAG });
      return true;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}

async function unkeep(hash) {
  if (!QBIT_URL || !hash) return;
  await qbit('torrents/removeTags', { hashes: hash, tags: KEEP_TAG });
}

/* ------------------------------------------------------------------ flow */

const pending = new Map();   // `${seriesId}:${season}` -> { fileIds:Set, timer }
let work = Promise.resolve();
const oneAtATime = (fn) => (work = work.then(fn, fn));

/** A Sonarr import event. Files of one season are handled together. */
export function noteImport(v) {
  if (!SONARR_API_KEY || !JELLYFIN_API_KEY) return;
  const seriesId = Number(v.sonarr_series_id);
  const fileId = Number(v.sonarr_episodefile_id);
  const season = Number(v.sonarr_episodefile_seasonnumber);
  if (!seriesId || !fileId) return;
  const key = `${seriesId}:${season}`;
  const p = pending.get(key) ?? { fileIds: new Set(), timer: null };
  p.fileIds.add(fileId);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pending.delete(key);
    oneAtATime(() => checkSeason(seriesId, season, [...p.fileIds]).catch(err =>
      log(`anime subs: check failed for series ${seriesId} season ${season}: ${err.message}`)));
  }, SETTLE_MS);
  p.timer.unref?.();
  pending.set(key, p);
}

async function checkSeason(seriesId, season, fileIds, tries = 0) {
  const series = await sonarr(`series/${seriesId}`);
  if (series.seriesType !== 'anime') return;
  const files = (await Promise.all(fileIds.map(id => sonarr(`episodefile/${id}`).catch(() => null)))).filter(Boolean);
  if (!files.length) return;
  const streams = await streamsFor(series.path, files.map(f => f.path));
  if (!streams) {
    if (tries + 1 >= FIND_TRIES) return log(`anime subs: ${series.title} not in Jellyfin yet, gave up`);
    await new Promise(r => setTimeout(r, FIND_WAIT_MS));
    return checkSeason(seriesId, season, fileIds, tries + 1);
  }

  const store = await loadStore();
  const kinds = files.map(f => ({ file: f, kind: englishSubs(streams[f.path]) }));
  for (const { file, kind } of kinds) {
    const group = file.releaseGroup;
    if (!group || store.seen[file.id]) continue;
    store.seen[file.id] = kind;
    const c = (store.groups[group] ??= { ass: 0, other: 0, none: 0 });
    c[kind]++;
  }
  await saveStore(store);
  await syncFormat(store).catch(err => log(`anime subs: format sync failed: ${err.message}`));

  const missing = kinds.filter(k => k.kind !== 'ass');
  if (!missing.length) return;
  const key = `${seriesId}:${season}`;
  const earlier = store.swaps[key];
  if (earlier && Date.now() - Date.parse(earlier.at) < RETRY_DAYS * DAY) return;

  const episodes = (await sonarr(`episode?seriesId=${seriesId}&seasonNumber=${season}`))
    .filter(e => missing.some(m => m.file.id === e.episodeFileId))
    .map(e => e.episodeNumber);
  const current = {
    resolution: Math.min(...missing.map(m => m.file.quality?.quality?.resolution ?? 0)),
    episodes,
    group: missing[0].file.releaseGroup,
  };
  const what = missing.every(m => m.kind === 'none') ? 'no English subtitles inside' : 'English subtitles, but not ASS';
  const label = `${series.title}${season ? ` season ${season}` : ''}`;
  const releases = await sonarr(`release?seriesId=${seriesId}&seasonNumber=${season}`);
  const pick = pickReplacement(releases, current, assGroups(store.groups));
  if (!pick) {
    store.swaps[key] = { at: new Date().toISOString(), result: 'kept' };
    await saveStore(store);
    log(`anime subs: ${label}: ${what}, no ASS release to swap to`);
    await publish({
      title: `Subtitles: ${label}`,
      body: `${what} (${current.group || 'unknown group'}). No release with English ASS found, so it stays as it is.`,
      tags: 'speech_balloon',
    });
    return;
  }
  await sonarr('release', { method: 'POST', body: JSON.stringify({ guid: pick.guid, indexerId: pick.indexerId }) });
  const hash = torrentHash(pick);
  store.swaps[key] = {
    at: new Date().toISOString(), result: 'grabbed', title: pick.title,
    downloadId: hash, seriesId,
  };
  await saveStore(store);
  const kept = await keep(hash).catch(err => (log(`anime subs: could not tag ${pick.title} Keep: ${err.message}`), false));
  if (!kept) log(`anime subs: ${pick.title} not tagged Keep; decluttarr may remove it if Sonarr refuses it`);
  log(`anime subs: ${label}: ${what}, grabbed ${pick.title}`);
  await publish({
    title: `Subtitles: ${label}`,
    body: `${what} (${current.group || 'unknown group'}). Getting ${pick.releaseGroup}'s release instead, which has English ASS; the current files stay until it is in.`,
    tags: 'speech_balloon',
  });
}

/**
 * Import swaps Sonarr is holding back. Run from a timer. A swap is only ever
 * one of ours (recorded when grabbed), so nothing else in the queue is
 * touched.
 */
export async function importStuckSwaps() {
  if (!SONARR_API_KEY) return;
  const store = await loadStore();
  if (!Object.values(store.swaps).some(s => s.downloadId && ['grabbed', 'imported'].includes(s.result))) return;
  const queue = (await sonarr('queue?pageSize=500')).records ?? [];
  // Swaps that have left the queue are finished, however that happened: the
  // Keep tag comes off so decluttarr treats the torrent like any other again.
  const inQueue = new Set(queue.map(q => q.downloadId?.toLowerCase()).filter(Boolean));
  for (const swap of Object.values(store.swaps)) {
    if (!swap.downloadId || !['grabbed', 'imported'].includes(swap.result)) continue;
    if (inQueue.has(swap.downloadId.toLowerCase())) continue;
    try {
      await unkeep(swap.downloadId.toLowerCase());
      swap.result = 'done';
      log(`anime subs: ${swap.title} has left the queue, Keep removed`);
    } catch (err) {
      log(`anime subs: could not remove Keep from ${swap.title}: ${err.message}`);
    }
  }
  const seen = new Set();
  for (const row of stuckSwaps(queue, store.swaps)) {
    if (seen.has(row.downloadId)) continue;
    seen.add(row.downloadId);
    const items = await sonarr(`manualimport?downloadId=${row.downloadId}&seriesId=${row.seriesId}&filterExistingFiles=false`);
    const files = items.filter(i => i.episodes?.length).map(i => ({
      path: i.path,
      seriesId: row.seriesId,
      episodeIds: i.episodes.map(e => e.id),
      quality: i.quality,
      languages: i.languages,
      releaseGroup: i.releaseGroup,
      downloadId: row.downloadId,
    }));
    if (!files.length) {
      log(`anime subs: ${row.title}: nothing Sonarr can match to import`);
      continue;
    }
    await sonarr('command', { method: 'POST', body: JSON.stringify({ name: 'ManualImport', files, importMode: 'auto' }) });
    const swap = Object.values(store.swaps).find(s => s.downloadId?.toLowerCase() === row.downloadId.toLowerCase());
    swap.result = 'imported';
    log(`anime subs: imported ${files.length} file(s) of ${row.title} by hand (Sonarr did not count it as an upgrade)`);
  }
  await saveStore(store);
}

/** Record a swap grabbed by hand, so its import is seen through too. */
export async function recordSwap({ key, title, downloadId, seriesId }) {
  const store = await loadStore();
  store.swaps[key] = { at: new Date().toISOString(), result: 'grabbed', title, downloadId, seriesId };
  await saveStore(store);
  await keep(downloadId?.toLowerCase());
}

/**
 * Learn from the library as it is: every anime file Sonarr has, judged in
 * Jellyfin. Run once to start the list from real files rather than names.
 */
export async function learnFromLibrary() {
  const store = await loadStore();
  const all = (await jellyfin('/Items?Recursive=true&IncludeItemTypes=Series&Fields=Path')).Items ?? [];
  const byPath = new Map(all.map(s => [s.Path, s]));
  let counted = 0;
  for (const series of await sonarr('series')) {
    if (series.seriesType !== 'anime') continue;
    const jf = byPath.get(series.path);
    if (!jf) continue;
    const eps = (await jellyfin(`/Shows/${jf.Id}/Episodes?Fields=MediaStreams,Path`)).Items ?? [];
    const streams = new Map(eps.map(e => [e.Path, e.MediaStreams ?? []]));
    for (const file of await sonarr(`episodefile?seriesId=${series.id}`)) {
      if (!file.releaseGroup || store.seen[file.id] || !streams.get(file.path)?.length) continue;
      const kind = englishSubs(streams.get(file.path));
      store.seen[file.id] = kind;
      (store.groups[file.releaseGroup] ??= { ass: 0, other: 0, none: 0 })[kind]++;
      counted++;
    }
  }
  await saveStore(store);
  await syncFormat(store);
  return { counted, groups: assGroups(store.groups) };
}
