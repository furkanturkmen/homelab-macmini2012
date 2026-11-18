/**
 * Subtitles ready before anyone presses play.
 *
 * Subtitles inside a video file are spread through its whole length, so
 * Jellyfin can only hand them to a player after reading the entire file
 * (1-2 GB for an episode). It does that the first time somebody turns them on
 * and keeps the result, which made every new episode's subtitles appear 20-35
 * seconds late while the second viewing was instant.
 *
 * This asks Jellyfin for each new file's subtitles in the background, one file
 * at a time, so that first read has already happened. One request is enough:
 * Jellyfin pulls every text track of the file out in the same pass. Newest
 * files go first, so a fresh import is ready soon after it lands while the rest
 * of the library is caught up behind it.
 *
 * Image subtitles (PGS, VobSub) are not extracted this way and are left alone.
 * Done files are remembered in subtitles-ready.json; a replaced file (an
 * upgrade) has a different size and is done again.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

const JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://jellyfin:8096';
const RECORD_PATH = process.env.SUBTITLES_READY_PATH
  || `${process.env.DATA_DIR || '/data'}/subtitles-ready.json`;
// Short: the usual failure is a file Jellyfin is still rescanning (its track
// numbers change when a subtitle file appears next to it), which is fine an
// hour later. A file that keeps failing costs one request an hour.
const RETRY_FAILED_MS = 3600 * 1000;
// Reading a big file over a busy disk can take minutes; anything longer is stuck.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// The file type Jellyfin stores each codec as, so it does not convert on top.
const EXTENSION = { subrip: 'srt', ass: 'ass', ssa: 'ssa', webvtt: 'vtt', mov_text: 'srt', text: 'srt' };

/**
 * Which files still need their subtitles pulled out, newest first.
 *
 * `items` are Jellyfin Movie/Episode items with MediaSources, sorted newest
 * first. `record` is { ready: {key: when}, failed: {key: {at, error}} }.
 */
export function filesToPrepare(items, record, now = Date.now()) {
  const out = [];
  for (const item of items) {
    for (const source of item.MediaSources ?? []) {
      const track = (source.MediaStreams ?? []).find(s =>
        s.Type === 'Subtitle' && !s.IsExternal && s.IsTextSubtitleStream);
      if (!track) continue;
      const key = `${item.Id}:${source.Id}:${source.Size ?? ''}`;
      if (record.ready[key]) continue;
      const failed = record.failed[key];
      if (failed && now - Date.parse(failed.at) < RETRY_FAILED_MS) continue;
      out.push({
        key,
        name: item.SeriesName ? `${item.SeriesName} ${item.Name}` : item.Name,
        path: `/Videos/${item.Id}/${source.Id}/Subtitles/${track.Index}/0/Stream.${EXTENSION[track.Codec] ?? 'vtt'}`,
      });
    }
  }
  return out;
}

/** Drop entries for files that are no longer in the library. */
export function pruneRecord(record, liveKeys) {
  const keep = (map) => Object.fromEntries(Object.entries(map).filter(([k]) => liveKeys.has(k)));
  return { ready: keep(record.ready), failed: keep(record.failed) };
}

export function liveKeys(items) {
  const keys = new Set();
  for (const item of items) {
    for (const source of item.MediaSources ?? []) keys.add(`${item.Id}:${source.Id}:${source.Size ?? ''}`);
  }
  return keys;
}

async function loadRecord() {
  try {
    const doc = JSON.parse(await readFile(RECORD_PATH, 'utf8'));
    return { ready: doc.ready ?? {}, failed: doc.failed ?? {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { ready: {}, failed: {} };
    throw err;
  }
}

async function saveRecord(record) {
  await mkdir(RECORD_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
  const tmp = `${RECORD_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(record));
  await rename(tmp, RECORD_PATH);
}

function headers(apiKey) {
  return { Authorization: `MediaBrowser Client="jellylab-push", Device="homelab", DeviceId="jellylab-push", Version="1", Token="${apiKey}"` };
}

async function libraryFiles(apiKey) {
  const q = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Episode',
    IsMissing: 'false',
    Fields: 'MediaSources',
    SortBy: 'DateCreated',
    SortOrder: 'Descending',
  });
  const res = await fetch(`${JELLYFIN_URL}/Items?${q}`, { headers: headers(apiKey), signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`jellyfin /Items: ${res.status}`);
  return (await res.json()).Items ?? [];
}

async function prepare(apiKey, file) {
  const res = await fetch(`${JELLYFIN_URL}${file.path}`, {
    headers: headers(apiKey), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // The body is the subtitle itself; read it so the request finishes cleanly.
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`answered ${res.status}`);
}

let busy = false;
let again = false;

/**
 * Prepare everything not yet done. One run at a time. An import during a run
 * (`newFile`) makes it look again straight away, so the new file goes before
 * the rest of a catch-up; the timer during a run is ignored, since the run
 * already covers everything the timer would find.
 */
export async function prepareSubtitles(apiKey, { newFile = false } = {}) {
  if (busy) {
    if (newFile) again = true;
    return;
  }
  busy = true;
  try {
    do {
      again = false;
      const items = await libraryFiles(apiKey);
      const record = pruneRecord(await loadRecord(), liveKeys(items));
      const todo = filesToPrepare(items, record);
      if (todo.length > 1) log(`subtitles: preparing ${todo.length} file(s), newest first`);
      let done = 0;
      for (const file of todo) {
        const started = Date.now();
        try {
          await prepare(apiKey, file);
          record.ready[file.key] = new Date().toISOString();
          delete record.failed[file.key];
          done++;
          if (todo.length === 1 || done % 50 === 0) {
            log(`subtitles: ${done}/${todo.length} ready (last: ${file.name}, ${Math.round((Date.now() - started) / 1000)}s)`);
          }
        } catch (err) {
          record.failed[file.key] = { at: new Date().toISOString(), error: err.message };
          log(`subtitles: could not prepare ${file.name}: ${err.message}`);
        }
        await saveRecord(record);
        // A new import waiting behind a long catch-up goes first.
        if (again) break;
      }
      if (todo.length > 1 && !again) log(`subtitles: ${done}/${todo.length} ready, caught up`);
    } while (again);
  } finally {
    busy = false;
  }
}
