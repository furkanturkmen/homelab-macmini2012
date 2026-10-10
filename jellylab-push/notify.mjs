/**
 * Sonarr and Radarr events, said the way a person would say them.
 *
 * Both apps used to post to ntfy straight from their Custom Script, one push
 * per event. That was fine for a film a day and useless for anything else:
 * Black Clover arrived as 115 separate "Episode added" pushes on 2026-10-05,
 * thirty of them in one minute, and the one message that needed doing
 * something about - an import stuck behind a badly named folder - was a raw
 * torrent hash somewhere in the middle of them.
 *
 * So the scripts hand the event here instead, and this decides what to say:
 *
 * - Episodes are gathered per series and sent as one push once the series has
 *   gone quiet for a few minutes - "Black Clover: 31 new episodes" with the
 *   numbers as ranges. A drip of single episodes still arrives on its own,
 *   just a few minutes late.
 * - A film is sent straight away. There is never more than one at a time.
 * - A stuck import asks the app *why* it is stuck. The Custom Script is not
 *   told - there is no status-message variable - but the queue row still has
 *   it, and "the release name does not match the film" is what decides
 *   whether a person needs to act. The Voyage of the Dawn Treader sat
 *   unimported for two days behind a release spelled "Tredder", and Radarr's
 *   script had no case for it at all, so nobody heard.
 *
 * If this service is down the scripts post a plain message to ntfy
 * themselves, so a broken jellylab-push costs wording, never the message.
 */

const {
  NTFY_URL = 'http://ntfy',
  NTFY_TOPIC = '',
  NTFY_USER = '',
  NTFY_PASSWORD = '',
  SONARR_URL = 'http://sonarr:8989',
  SONARR_API_KEY = '',
  RADARR_URL = 'http://radarr:7878',
  RADARR_API_KEY = '',
} = process.env;

// A series is sent once nothing new has arrived for QUIET_MS, and never later
// than MAX_MS after its first episode, so a season trickling in over an hour
// still reports as it goes rather than all at the end.
const QUIET_MS = Number(process.env.NOTIFY_QUIET_MS) || 5 * 60 * 1000;
const MAX_MS = Number(process.env.NOTIFY_MAX_MS) || 30 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Post one message to ntfy. Swallows failure: a lost push is not worth a crash. */
export async function publish({ title, body, tags, priority = 'default' }) {
  if (!NTFY_TOPIC) return;
  const headers = { Title: encodeHeader(title), Tags: tags, Priority: priority };
  if (NTFY_USER) headers.Authorization = `Basic ${Buffer.from(`${NTFY_USER}:${NTFY_PASSWORD}`).toString('base64')}`;
  try {
    const res = await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) log(`ntfy answered ${res.status} for "${title}"`);
  } catch (err) {
    log(`ntfy failed for "${title}": ${err.message}`);
  }
}

/*
 * HTTP headers are Latin-1. A title with a dash or an Arabic film name in it
 * would be mangled or refused, and ntfy reads RFC 2047 encoded-words, so
 * anything outside plain ASCII goes that way.
 */
function encodeHeader(text) {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** [1,2,3,5,7,8] -> "1-3, 5, 7-8". */
export function ranges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j === i ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return parts.join(', ');
}

/**
 * One push for a batch of episodes of one series.
 *
 * Episode titles only for a single episode: for thirty they are a wall of
 * text nobody reads, and the numbers are what tell you how far along it is.
 */
export function episodeMessage(series, upgrade, eps) {
  const n = new Set(eps.map(e => `${e.season}:${e.episode}`)).size;
  const qualities = [...new Set(eps.map(e => e.quality).filter(Boolean))].join(', ');
  if (n === 1) {
    const e = eps[0];
    const line = `S${e.season}E${e.episode}${e.title ? ` · ${e.title}` : ''}`;
    return {
      title: upgrade ? `${series}: better copy of an episode` : `${series}: new episode`,
      body: [line, qualities].filter(Boolean).join('\n'),
    };
  }
  const bySeason = new Map();
  for (const e of eps) {
    if (!bySeason.has(e.season)) bySeason.set(e.season, []);
    bySeason.get(e.season).push(e.episode);
  }
  const lines = [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([s, list]) => `Season ${s}: episode${list.length > 1 ? 's' : ''} ${ranges(list)}`);
  return {
    title: upgrade ? `${series}: better copies of ${n} episodes` : `${series}: ${n} new episodes`,
    body: [...lines, qualities].filter(Boolean).join('\n'),
  };
}

export function movieMessage(title, year, quality, upgrade) {
  const name = year ? `${title} (${year})` : title;
  return {
    title: upgrade ? `Better copy: ${name}` : `New film: ${name}`,
    body: quality || '',
  };
}

/*
 * What the *arr said, in words that tell you whether to act.
 *
 * Matched against the messages Sonarr and Radarr actually emit (pulled from
 * their own binaries). Anything unrecognised is passed through as-is: the
 * app's own sentence beats a guess.
 */
const REASONS = [
  [/matched to (series|movie) by ID/i,
    'the release has a different name than the title it was grabbed for (often a typo by the uploader)'],
  [/was unexpected considering the .* folder name/i,
    'the folder name makes it think only some of the episodes are inside'],
  [/No files found are eligible for import|No files found for torrent/i,
    'there is no video file in the download'],
  [/appears to be a sample/i,
    'the video is only a short sample, not the real thing'],
  [/Not an upgrade for existing/i,
    'it is not better than the copy you already have'],
  [/Unknown (Series|Movie)|Unable to (parse|identify)/i,
    'it could not work out which title this is'],
  [/not wanted in profile/i,
    'its quality is not one you allow'],
];

export function plainReason(messages) {
  for (const m of messages) {
    for (const [re, text] of REASONS) if (re.test(m)) return text;
  }
  return messages[0] ?? null;
}

export function stuckMessage({ app, name, reason, release }) {
  const App = app === 'sonarr' ? 'Sonarr' : 'Radarr';
  return {
    title: `Needs a hand: ${name}`,
    body: [
      `Downloaded, but ${App} won't move it into the library${reason ? `: ${reason}` : '.'}`,
      `Don't delete the torrent yet. Open ${App} › Activity › Queue and use Manual Import.`,
      release ? `Release: ${release}` : null,
    ].filter(Boolean).join('\n'),
  };
}

/** The status messages on the queue row for one download, or [] when it cannot be found. */
async function queueReasons(app, downloadId) {
  const [base, key] = app === 'sonarr' ? [SONARR_URL, SONARR_API_KEY] : [RADARR_URL, RADARR_API_KEY];
  if (!key || !downloadId) return [];
  try {
    const res = await fetch(`${base}/api/v3/queue?pageSize=500&apikey=${key}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const rows = ((await res.json()).records ?? [])
      .filter(r => (r.downloadId ?? '').toLowerCase() === downloadId.toLowerCase());
    return [...new Set(rows.flatMap(r => (r.statusMessages ?? []).flatMap(s => s.messages ?? [])))];
  } catch {
    return [];
  }
}

const batches = new Map();

function flush(key) {
  const b = batches.get(key);
  if (!b) return;
  batches.delete(key);
  clearTimeout(b.timer);
  const msg = episodeMessage(b.series, b.upgrade, b.eps);
  return publish({ ...msg, tags: 'tv' });
}

function addEpisodes(series, upgrade, eps) {
  const key = `${series}\u0000${upgrade}`;
  const now = Date.now();
  let b = batches.get(key);
  if (!b) {
    b = { series, upgrade, eps: [], first: now, timer: null };
    batches.set(key, b);
  }
  b.eps.push(...eps);
  clearTimeout(b.timer);
  const wait = Math.max(0, Math.min(QUIET_MS, b.first + MAX_MS - now));
  b.timer = setTimeout(() => flush(key), wait);
  b.timer.unref?.();
}

/** Send whatever is still gathering. For shutdown, and for tests. */
export async function flushAll() {
  await Promise.all([...batches.keys()].map(flush));
}

// A download can be reported stuck more than once while it sits there.
const STUCK_SEEN = new Map();

/**
 * Handle one event from a Custom Script. `v` holds the script's variables,
 * lowercased, e.g. sonarr_eventtype.
 */
export async function handleArrEvent(v) {
  const app = v.sonarr_eventtype ? 'sonarr' : v.radarr_eventtype ? 'radarr' : null;
  if (!app) throw Object.assign(new Error('not a sonarr or radarr event'), { status: 400 });
  const get = (name) => (v[`${app}_${name}`] ?? '').trim();
  const event = get('eventtype');
  const upgrade = get('isupgrade') === 'True';

  if (event === 'Download' && app === 'sonarr') {
    const season = Number(get('episodefile_seasonnumber'));
    const numbers = get('episodefile_episodenumbers').split(',').map(Number).filter(Number.isFinite);
    const titles = get('episodefile_episodetitles').split('|');
    const quality = get('episodefile_quality');
    addEpisodes(get('series_title') || 'Unknown series', upgrade,
      (numbers.length ? numbers : ['?']).map((n, i) => ({ season, episode: n, title: titles[i] || '', quality })));
    return { queued: true };
  }

  if (event === 'Download' && app === 'radarr') {
    await publish({
      ...movieMessage(get('movie_title') || 'Unknown film', get('movie_year'), get('moviefile_quality'), upgrade),
      tags: 'clapper',
    });
    return { sent: true };
  }

  if (event === 'ManualInteractionRequired') {
    const id = get('download_id');
    if (id && STUCK_SEEN.has(id) && Date.now() - STUCK_SEEN.get(id) < 24 * 3600 * 1000) return { duplicate: true };
    if (id) STUCK_SEEN.set(id, Date.now());
    if (STUCK_SEEN.size > 500) STUCK_SEEN.clear();
    const name = app === 'sonarr'
      ? get('series_title') || 'Unknown series'
      : `${get('movie_title') || 'Unknown film'}${get('movie_year') ? ` (${get('movie_year')})` : ''}`;
    const reason = plainReason(await queueReasons(app, id));
    await publish({
      ...stuckMessage({ app, name, reason, release: get('download_title') }),
      tags: 'warning',
      priority: 'high',
    });
    return { sent: true };
  }

  return { ignored: event };
}
