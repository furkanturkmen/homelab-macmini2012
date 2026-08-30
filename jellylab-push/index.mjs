/**
 * jellylab-push — answers the questions about the homelab that the Jellylab
 * app needs and Jellyfin cannot.
 *
 * Three questions so far.
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
function byTmdbId(records, pick) {
  const out = {};
  for (const r of records) {
    const parent = pick(r);
    const tmdbId = parent?.tmdbId;
    if (!tmdbId) continue;

    const size = r.size ?? 0;
    const left = r.sizeleft ?? r.sizeLeft ?? 0;
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
    const [tv, movies, unreleased, airing] = await Promise.all([
      SONARR_API_KEY
        ? wholeQueue(SONARR_URL, SONARR_API_KEY, 'includeSeries=true')
            .then(r => byTmdbId(r, x => x.series))
            .catch(e => { errors.sonarr = e.message; return {}; })
        : Promise.resolve({}),
      RADARR_API_KEY
        ? wholeQueue(RADARR_URL, RADARR_API_KEY, 'includeMovie=true')
            .then(r => byTmdbId(r, x => x.movie))
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

  return send(res, 404, { error: 'not found' });
});

server.listen(Number(PUSH_PORT), () => log(`listening on :${PUSH_PORT}`));
