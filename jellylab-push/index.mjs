/**
 * jellylab-push — answers the questions about the homelab that the Jellylab
 * app needs and Jellyfin cannot.
 *
 * Four questions so far.
 *
 * How much room is left on the media drive: Jellyfin has no API for it — it
 * reports what is in the library, never what is left to put there — and this
 * container already has the media mount visible, so a single statfs answers it.
 *
 * And what is actually downloading. Jellyseerr reports that already, but it
 * asks Sonarr for its queue without raising the page size, so it only ever sees
 * the first twenty rows. Sonarr queues one row per *episode*, so a single
 * 23-episode season pack fills the page on its own and everything behind it
 * looks idle - including, absurdly, whichever download is actually moving while
 * a stalled one sits at the top. This reads the whole queue.
 *
 * And what is not being looked for at all. A film still in cinemas sits at
 * "Processing" indefinitely and reads as a search finding nothing, when Radarr
 * has simply not started one and should not: isAvailable is false until the
 * film reaches its minimumAvailability.
 *
 * And, asked by hand rather than polled, what could actually be grabbed for a
 * title that is going nowhere. "Searching" covers both a release being chosen
 * badly and no permitted release existing at all, and those need opposite
 * fixes.
 *
 * It used to also bridge ntfy to Expo Push, so notifications would arrive
 * inside the app rather than in ntfy's own app. That is gone. Native iOS push
 * needs the `aps-environment` entitlement, Apple only issues it to a paid
 * Developer Program account, and this build deliberately strips it (see
 * plugins/withoutPushEntitlement.js). Notifications go to the ntfy app, which
 * works and costs nothing. The name is kept because the container, the port and
 * the app's configured URL all refer to it; the bridge is recoverable from git
 * if a paid account ever makes it worth having.
 *
 * No npm dependencies on purpose — this is a stock node image with the file
 * mounted in. Nothing to build, nothing to keep patched.
 */

import { createServer } from 'node:http';
import { statfs } from 'node:fs/promises';

const {
  PUSH_PORT = '8099',
  MEDIA_PATH = '/media',
  // The API keys stay here, on the server. The app asks this service instead,
  // so a phone never holds a credential that can rewrite the library.
  SONARR_URL = 'http://sonarr:8989',
  SONARR_API_KEY = '',
  RADARR_URL = 'http://radarr:7878',
  RADARR_API_KEY = '',
  // qBittorrent, for the numbers the *arrs only refresh once a minute.
  // Optional: without a password everything below is skipped and the app gets
  // exactly what it got before.
  QBIT_URL = 'http://gluetun:8083',
  QBIT_USER = '',
  QBIT_PASSWORD = '',
} = process.env;

const log = (...a) => console.log(new Date().toISOString(), ...a);

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/**
 * One page of a Sonarr or Radarr queue.
 *
 * Both are the same API with a different noun, so one function serves both.
 * The timeout matters: a wedged *arr should make this endpoint answer without
 * progress, not hang the app waiting for it.
 */
async function queuePage(base, key, page, extra) {
  const url = `${base}/api/v3/queue?page=${page}&pageSize=200&${extra}&apikey=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * The whole queue, not the first page of it.
 *
 * Paging until the records run out is the entire point of this endpoint - the
 * bug being worked around is precisely an assumption that page one is
 * everything. Capped at ten pages so a runaway queue cannot spin here forever.
 */
async function wholeQueue(base, key, extra) {
  const records = [];
  for (let page = 1; page <= 10; page++) {
    const body = await queuePage(base, key, page, extra);
    const batch = body.records ?? [];
    records.push(...batch);
    if (records.length >= (body.totalRecords ?? 0) || batch.length === 0) break;
  }
  return records;
}

/**
 * Queue rows collapsed to one entry per title, keyed by TMDB id.
 *
 * A season pack appears once per episode - 23 rows describing one torrent, each
 * carrying the size of the whole thing. Summing them would report 23 times the
 * real size, so the largest row wins instead: they all describe the same
 * download, so the largest is the download.
 *
 * TMDB rather than TVDB because that is what Jellyseerr keys a request on, and
 * matching them up is the only reason this exists.
 */
function byTmdbId(records, pick, live = {}) {
  const out = {};
  for (const r of records) {
    const parent = pick(r);
    const tmdbId = parent?.tmdbId;
    if (!tmdbId) continue;

    const size = r.size ?? 0;
    const left = r.sizeleft ?? r.sizeLeft ?? 0;
    const hash = (r.downloadId ?? '').toLowerCase();
    const prev = out[tmdbId];
    if (prev && prev.size >= size) continue;

    out[tmdbId] = {
      size,
      sizeLeft: left,
      percent: size > 0 ? Math.max(0, Math.min(1, (size - left) / size)) : null,
      // Sonarr says "warning" for a stalled torrent and puts the reason in
      // errorMessage; that is worth showing, because a stalled download and a
      // slow one look identical from a percentage alone.
      status: r.trackedDownloadState ?? r.status ?? null,
      stalled: /stalled|no connections/i.test(r.errorMessage ?? ''),
      title: r.title ?? null,
      /*
       * Enough to answer "how is it going" without a second service.
       *
       * qBittorrent has the live speed and the seed count, but reading it
       * would mean either a password in another place or opening its web UI to
       * every container on the docker network. Average speed is derivable from
       * what is already here - bytes done over time elapsed - and that is the
       * number worth knowing anyway: a torrent that has averaged 2MB/s over
       * ten hours is a different situation from one that briefly touched 20.
       */
      added: r.added ?? null,
      timeLeft: r.timeleft ?? null,
      indexer: r.indexer ?? null,
      client: r.downloadClient ?? null,
      /*
       * What was actually chosen, so the app can show it rather than only how
       * far along it is.
       *
       * The score is the interesting one. A release carrying PROPER in its
       * title outranks everything on revision alone, ahead of any custom
       * format score, so a negative score on a download in progress means the
       * ranking picked something the profile actively did not want.
       */
      quality: r.quality?.quality?.name ?? null,
      score: r.customFormatScore ?? null,
      languages: (r.languages ?? []).map(l => l?.name).filter(Boolean),
      // Sonarr's own words for why it is stuck. "The download is stalled with
      // no connections" is the seed count expressed as a symptom, and unlike a
      // seed count it needs no second credential to read.
      error: r.errorMessage ?? null,
      /*
       * Straight from qBittorrent, when it could be reached.
       *
       * Kept beside the *arr figures rather than replacing them: the app has
       * to render when this service has no qBittorrent password, and a screen
       * that works only when every credential is present is worse than one
       * that degrades.
       */
      ...(hash && live[hash]
        ? {
            livePercent: live[hash].percent,
            liveSpeed: live[hash].speed,
            seeders: live[hash].seeders,
            seedersTotal: live[hash].seedersTotal,
            peers: live[hash].peers,
            clientState: live[hash].state,
          }
        : {}),
    };
  }
  return out;
}

/**
 * The films Radarr is deliberately not looking for yet.
 *
 * A request for something still in cinemas sits at "Processing" forever and
 * reads as a search finding nothing - when in fact no search is running and
 * none should be. Radarr knows: isAvailable stays false until the film reaches
 * whatever minimumAvailability was set to, and digitalRelease is the date that
 * will happen, when anyone has announced one.
 *
 * Only the unavailable ones are returned. The library is hundreds of films and
 * the app only needs the handful that are waiting on the world.
 */
async function unreleasedMovies(base, key) {
  const res = await fetch(`${base}/api/v3/movie?apikey=${key}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const out = {};
  for (const m of await res.json()) {
    if (m.isAvailable || m.hasFile || !m.tmdbId) continue;
    out[m.tmdbId] = {
      // announced | inCinemas | released | deleted
      status: m.status ?? null,
      inCinemas: m.inCinemas ?? null,
      digitalRelease: m.digitalRelease ?? null,
      physicalRelease: m.physicalRelease ?? null,
    };
  }
  return out;
}

/**
 * The seasons Sonarr is still waiting on.
 *
 * The television half of the same problem as unreleasedMovies. A request for a
 * season currently airing sits at "Processing" week after week and reads as a
 * search finding nothing, when eight episodes simply do not exist yet.
 *
 * Sonarr counts them per season: episodeCount is how many have aired,
 * totalEpisodeCount how many there will be, and nextAiring when the following
 * one is due. Only seasons with something still to come are returned - a
 * finished series has nothing to say here.
 */
async function airingSeries(base, key) {
  const res = await fetch(`${base}/api/v3/series?apikey=${key}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const out = {};
  for (const show of await res.json()) {
    if (!show.tmdbId) continue;
    const seasons = {};
    for (const season of show.seasons ?? []) {
      // Season 0 is specials, which air on no schedule and are not what
      // anyone means by "has it aired yet".
      if (season.seasonNumber === 0) continue;
      const st = season.statistics ?? {};
      /*
       * nextAiring is the only unambiguous field here. episodeCount counts
       * *monitored* episodes, so a season nobody asked for reads as zero of
       * twenty-three and looks unaired - The Mentalist's later seasons finished
       * in 2012 and reported exactly that. A nextAiring date means there is
       * genuinely more to come; its absence means there is not.
       */
      if (!st.nextAiring) continue;
      seasons[season.seasonNumber] = {
        aired: st.episodeCount ?? 0,
        total: st.totalEpisodeCount ?? 0,
        nextAiring: st.nextAiring,
      };
    }
    if (Object.keys(seasons).length > 0) {
      out[show.tmdbId] = { status: show.status ?? null, seasons };
    }
  }
  return out;
}

/**
 * Live figures straight from the torrent client.
 *
 * Sonarr and Radarr refresh their queues from qBittorrent once a minute, so
 * everything derived from them is up to a minute stale - which at 20MB/s is
 * over a gigabyte. A download would show 0% and "< 1 MB/s" in the app while
 * qBittorrent had it at 22% and 20MB/s, because Radarr had not looked again
 * since the moment it was grabbed.
 *
 * This reads qBittorrent directly and merges by torrent hash. It is also the
 * only place a seed count exists: the *arr queue record has no such field.
 *
 * Entirely optional. With no password configured this returns an empty map and
 * every caller carries on with the *arr figures, exactly as before.
 *
 * The session cookie is fetched per call rather than cached. This is asked for
 * once every few seconds by one screen, a login costs one round trip on the
 * docker network, and a cached cookie that has silently expired is a class of
 * bug not worth inviting for that.
 */
async function qbitLive() {
  if (!QBIT_PASSWORD) return {};

  const body = new URLSearchParams({ username: QBIT_USER, password: QBIT_PASSWORD });
  const auth = await fetch(`${QBIT_URL}/api/v2/auth/login`, {
    method: 'POST',
    body,
    // qBittorrent rejects a login whose Referer is not its own origin.
    headers: { Referer: QBIT_URL },
    signal: AbortSignal.timeout(8000),
  });
  if (!auth.ok) throw new Error(`login ${auth.status}`);

  /*
   * Whatever the cookie is called.
   *
   * qBittorrent has named this SID historically and names it QBT_SID_<port>
   * now - this install returns QBT_SID_8083. Matching the old name exactly
   * meant a login that succeeded with a 204 and a perfectly good cookie was
   * reported as "no session cookie", which reads like bad credentials and is
   * not.
   *
   * A rejected login is a 200 carrying the word "Fails." rather than an error
   * status, so an empty cookie is the only signal that it did not work.
   */
  const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0];
  if (!/^[^=]*SID[^=]*=./i.test(cookie)) {
    throw new Error(cookie ? `unexpected cookie ${cookie.split('=')[0]}` : 'login rejected');
  }

  const res = await fetch(`${QBIT_URL}/api/v2/torrents/info`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${res.status}`);

  const out = {};
  for (const t of await res.json()) {
    // The *arrs record the hash uppercase in downloadId; qBittorrent reports
    // it lowercase. Lowercase is the key everywhere here.
    out[String(t.hash).toLowerCase()] = {
      percent: typeof t.progress === 'number' ? t.progress : null,
      speed: t.dlspeed ?? null,
      up: t.upspeed ?? null,
      // num_seeds is what we are connected to; num_complete is what the
      // tracker claims exists. The gap is the whole story on a dead swarm -
      // Bin Roye showed 0 of 14 for hours.
      seeders: t.num_seeds ?? null,
      seedersTotal: t.num_complete ?? null,
      peers: t.num_leechs ?? null,
      // downloading | stalledDL | metaDL | pausedDL | uploading | ...
      state: t.state ?? null,
      eta: t.eta ?? null,
    };
  }
  return out;
}

/**
 * Resolve a TMDB id to the id Radarr or Sonarr uses internally.
 *
 * The app only ever knows a TMDB id, because that is what Jellyseerr keys a
 * request on. Radarr indexes movies by it directly; Sonarr carries it on the
 * series alongside the TVDB id it actually prefers, so both are a lookup.
 */
async function localId(base, key, path, tmdbId) {
  const res = await fetch(`${base}/api/v3/${path}?apikey=${key}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const hit = (await res.json()).find(x => String(x.tmdbId) === String(tmdbId));
  return hit ? { id: hit.id, title: hit.title } : null;
}

/**
 * One episode to search for, standing in for the season.
 *
 * Sonarr's season search queries every indexer for the season *and* for each
 * episode, so a twelve-episode season is roughly twelve times the work. Across
 * eight indexers that took over 400 seconds and the request timed out, which
 * the app could only render as a failure - for a question that is answerable
 * in a couple of seconds.
 *
 * One episode answers it. The releases that exist for episode one are the same
 * releases that exist for the season - batches included, because a batch
 * matches every episode in it - and the question being asked is "is anything
 * grabbable at all", not "what exactly will be grabbed".
 *
 * Prefers an episode that is actually wanted: monitored, and without a file.
 * Asking about one already on disk returns "existing file meets cutoff" and
 * says nothing about whether the rest can be found.
 */
async function episodeToSearch(base, key, seriesId, season) {
  const res = await fetch(
    `${base}/api/v3/episode?seriesId=${seriesId}&seasonNumber=${encodeURIComponent(season)}&apikey=${key}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`${res.status}`);
  const episodes = await res.json();
  if (episodes.length === 0) return null;
  const wanted = episodes.find(e => e.monitored && !e.hasFile);
  return (wanted ?? episodes[0]).id;
}

/**
 * What could be grabbed for one title, and what was refused.
 *
 * The app says "searching" for two situations that are nothing alike. Fall
 * found 269 releases and accepted 42, then grabbed a PROPER that turned out to
 * be an .exe - the choosing was wrong. Bin Roye found seven and accepted none,
 * every one a DVDRip against a profile that starts at 720p - so no amount of
 * searching will ever succeed. Both looked identical from the phone.
 *
 * Only accepted releases are listed. A list of things that cannot be grabbed
 * is noise, and the ones that can be are what a person is choosing between.
 * But when nothing is accepted that empty list is the diagnosis rather than a
 * blank screen, so the count and the reasons come back regardless - they are
 * the entire answer in that case.
 *
 * This runs a live search across every indexer and takes tens of seconds. It
 * is asked for by hand from one card, never polled.
 */
async function candidates(base, key, query, limit = 10) {
  const res = await fetch(`${base}/api/v3/release?${query}&apikey=${key}`, {
    // Three minutes. A season search across eight indexers measured 110
    // seconds, and the old two-minute ceiling turned a slow-but-working
    // answer into a 502 just as it was about to succeed.
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const all = await res.json();

  const accepted = all.filter(r => !r.rejected);

  // Why the refused ones were refused, commonest first. Counted rather than
  // listed: seven rejections reading "DVD is not wanted in profile" is one
  // fact, not seven.
  const rejections = {};
  for (const r of all) {
    for (const reason of r.rejections ?? []) {
      rejections[reason] = (rejections[reason] ?? 0) + 1;
    }
  }

  return {
    found: all.length,
    accepted: accepted.length,
    releases: accepted
      // Score first because that is what the profile actually wants, seeders
      // second because between two equally wanted releases the one people are
      // still sharing is the one that will finish.
      .sort((a, b) =>
        (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0) ||
        (b.seeders ?? 0) - (a.seeders ?? 0))
      .slice(0, limit)
      .map(r => ({
        title: r.title ?? null,
        quality: r.quality?.quality?.name ?? null,
        // A PROPER or REPACK. Worth showing plainly: it is the flag that wins
        // a ranking outright, and the flag a hostile release forges.
        proper: (r.quality?.revision?.version ?? 1) > 1,
        score: r.customFormatScore ?? 0,
        seeders: r.seeders ?? null,
        leechers: r.leechers ?? null,
        size: r.size ?? null,
        indexer: r.indexer ?? null,
        languages: (r.languages ?? []).map(l => l?.name).filter(Boolean),
        age: r.ageDays ?? null,
      })),
    rejections: Object.fromEntries(
      Object.entries(rejections).sort((a, b) => b[1] - a[1]).slice(0, 6)),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true });
  }

  /**
   * Free space on the volume holding the media library.
   *
   * Unauthenticated on purpose: it is three numbers about disk space, on a
   * service reachable only over the LAN or the mesh VPN. Putting a secret in
   * front of it would mean the app shows nothing until that secret is
   * configured, for no gain worth having.
   */
  if (url.pathname === '/storage') {
    try {
      const s = await statfs(MEDIA_PATH);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      return send(res, 200, { total, free, used: total - free, path: MEDIA_PATH });
    } catch (err) {
      return send(res, 500, { error: `cannot read ${MEDIA_PATH}: ${err.message}` });
    }
  }

  /**
   * What is downloading, keyed by TMDB id so the app can line it up with a
   * Jellyseerr request.
   *
   * Unauthenticated for the same reason as /storage: it is progress numbers on
   * a service reachable only over the LAN or the mesh, and the mesh policy lets
   * guests reach 8096 and nothing else. It holds the API keys but never returns
   * them.
   *
   * A dead *arr costs its own half of the answer and nothing more - the other
   * half still comes back, with the failure named.
   */
  if (url.pathname === '/downloads') {
    const errors = {};
    // Fetched first, because both queues want to merge against it. A failure
    // here costs the live figures and nothing else.
    const live = await qbitLive().catch(e => { errors.qbittorrent = e.message; return {}; });
    const [tv, movies, unreleased, airing] = await Promise.all([
      SONARR_API_KEY
        ? wholeQueue(SONARR_URL, SONARR_API_KEY, 'includeSeries=true')
            .then(r => byTmdbId(r, x => x.series, live))
            .catch(e => { errors.sonarr = e.message; return {}; })
        : Promise.resolve({}),
      RADARR_API_KEY
        ? wholeQueue(RADARR_URL, RADARR_API_KEY, 'includeMovie=true')
            .then(r => byTmdbId(r, x => x.movie, live))
            .catch(e => { errors.radarr = e.message; return {}; })
        : Promise.resolve({}),
      RADARR_API_KEY
        ? unreleasedMovies(RADARR_URL, RADARR_API_KEY)
            .catch(e => { errors.radarrMovies = e.message; return {}; })
        : Promise.resolve({}),
      SONARR_API_KEY
        ? airingSeries(SONARR_URL, SONARR_API_KEY)
            .catch(e => { errors.sonarrSeries = e.message; return {}; })
        : Promise.resolve({}),
    ]);
    return send(res, 200, {
      tv,
      movies,
      unreleased,
      airing,
      ...(Object.keys(errors).length ? { errors } : {}),
    });
  }

  /**
   * The releases that could be grabbed for one title.
   *
   * Asked for from a single card when a request has sat still long enough to
   * be worth asking about, never polled: it runs a live search across every
   * indexer and takes tens of seconds.
   *
   * Movies need only a TMDB id. Television needs a season too - Sonarr
   * searches a season or an episode, never a whole series - and the app has
   * one, because a Jellyseerr request is made per season.
   */
  if (url.pathname === '/candidates') {
    const tmdbId = url.searchParams.get('tmdbId');
    const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
    const season = url.searchParams.get('season');
    if (!tmdbId) return send(res, 400, { error: 'tmdbId required' });

    const tv = type === 'tv';
    const key = tv ? SONARR_API_KEY : RADARR_API_KEY;
    const svc = tv ? SONARR_URL : RADARR_URL;
    if (!key) return send(res, 503, { error: `${tv ? 'sonarr' : 'radarr'} not configured` });
    if (tv && season === null) return send(res, 400, { error: 'season required for tv' });

    try {
      const found = await localId(svc, key, tv ? 'series' : 'movie', tmdbId);
      // Not tracked at all is a real answer, and a different one from finding
      // nothing to grab: nobody is searching because nothing was ever added.
      if (!found) return send(res, 200, { tracked: false, found: 0, accepted: 0, releases: [], rejections: {} });

      let query;
      if (tv) {
        // One episode rather than the whole season - see episodeToSearch.
        const episodeId = await episodeToSearch(svc, key, found.id, season);
        if (episodeId == null) {
          return send(res, 200, {
            tracked: true, title: found.title,
            found: 0, accepted: 0, releases: [], rejections: {},
          });
        }
        query = `episodeId=${episodeId}`;
      } else {
        query = `movieId=${found.id}`;
      }
      const out = await candidates(svc, key, query);
      return send(res, 200, { tracked: true, title: found.title, ...out });
    } catch (err) {
      return send(res, 502, { error: err.message });
    }
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(Number(PUSH_PORT), () => log(`listening on :${PUSH_PORT}`));
