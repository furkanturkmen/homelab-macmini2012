# Release rules

How a request becomes the right download, and the two ways it stops being one.

Both failures below looked identical from the app — a request that said
"searching" and never finished — and needed opposite fixes.

| | Fall (2022) | Bin Roye (2015) |
|---|---|---|
| releases found | 256 | 7 |
| accepted | 34 | **0** |
| what happened | grabbed a `PROPER` that was an `.exe`, twice | nothing was ever grabbable |
| cause | ranking put revision above score | profile forbids the only quality that exists |
| fixed by | R0, R1 | R8, R9 |

## R0 — Score must be allowed to decide

`downloadPropersAndRepacks` ships as `preferAndUpgrade`, which sorts
**quality tier → revision → custom format score**. A release with `PROPER` in
its title wins on revision before the score is ever read.

That is a text field an indexer types. `Fall 2022 PROPER 1080p WEBRip x265
RARBG` scored **−20** with 24 seeders and beat `Fall.2022.1080p.WEBRip.DD5.1
.x264-NOGRP` at **+15** with 1813, on every search, forever.

Set `doNotPrefer` on both apps. Add a `Repack/Proper` custom format at **+5** so
genuine propers are still preferred — weighed against everything else, rather
than trumping it.

## R1 — Reject negatives outright

`minFormatScore: -100` means every penalty is a preference, never a refusal.
HEVC at −20 was not "avoid this", it was "rank this lower and take it anyway".

Set **0**. Anything scored negative stops being an option.

The trade: a title existing *only* in x265 finds nothing and sits in searching.
Grab it by hand when that happens. Fall had 42 clean x264 candidates, so at
1080p this is rare.

## R2 — The title is written by the attacker

`CAKES`, `PROPER`, `1080p`, `x264` are strings someone else chose. One of the
removed torrents was literally named `Reacher S04E05 1080p WEB H264-CAKES.exe`.

Scoring expresses **preference**. It is not a security boundary and no rule may
assume the title is honest.

## R3 — No global seeder floor

Tempting after Fall, and wrong. Bin Roye's legitimate DVDRips peak at **5**
seeders; a floor of 15 would permanently blacklist regional and catalogue
titles — the content that already struggles most.

`minimumSeeders: 1` rejects only the genuinely dead, which is all it should do.
Judge a suspicious torrent by its **contents** (R5), not its popularity. The
Fall malware had 24 seeders and would have passed any sane floor.

## R4 — Indexer trust is earned

Of six torrents `torrent-guard.py` has ever killed: TorrentDownload 3, EZTV 2,
one forged CAKES. Both of Fall's −20 entries and its only CAM came from
TorrentDownload.

Drop it, or leave it at priority 50 and require 50+ seeders from it alone.

## R5 — Only content inspection is real

`~/homelab-scripts/torrent-guard.py`, every minute, is the one rule that opens
the torrent and looks at what is inside rather than reading its name. Six kills,
zero false positives.

Everything above is a heuristic on a string. This is evidence.

## R6 — Every kill must teach

A removal that does not blocklist is an infinite loop: the guard deletes the
torrent, Radarr's next search ranks the same release first, grabs it again.
Fall went round twice and would have gone forever.

Remove through the *arr rather than the client:

```
DELETE /api/v3/queue/{id}?removeFromClient=true&blocklist=true
```

matching on `downloadId` (the uppercase torrent hash), falling back to a direct
qBittorrent delete when no queue record matches.

## R7 — Radarr and Sonarr must agree

Sonarr scores `Italian release` at −1000. Radarr has no such format, and a live
search for Fall returned two Italian releases at +15 sitting second and third.

Any rule worth having belongs in both, or the gap becomes the hole.

## R8 — Five profiles, named for the lowest they accept

A profile demanding 720p+ for a film that only ever shipped on DVD produces a
permanent, silent "searching" with no error anywhere. Bin Roye is a 2015 Urdu
film: seven releases, five DVDRip, one CAM, one unparseable.

Both apps shipped six or seven stock profiles, of which the library used two.
Harmless noise until the app grew a quality picker — at which point every one
became something choosable by mistake, and several were traps.

```
HD 1080p   1080p only
HD         720p and up          the default, and where 32 titles live
DVD        DVD and up
SD         SDTV and up
CAM        anything, last resort
```

**A floor, never a ceiling.** Both apps always grab the best release a profile
permits, so "CAM" still fetches 1080p when it exists and merely declines to
refuse a camrip when nothing else is there. All five top out at 1080p and
upgrade toward it, so a low pick is a placeholder, not a commitment.

Defined by quality **name**, not by a slice of each app's own ordering, because
they disagree: Sonarr ranks `Bluray-720p` and `WEB 720p` *above* `HDTV-1080p`,
a fair opinion about which looks better and a poor basis for a menu item called
"HD 1080p". Sonarr has no CAM, TELESYNC or TELECINE at all, so its CAM would
duplicate its SD and is skipped — television gets four.

`scripts/quality-profiles.py` owns this, and owns which title uses which
profile. `apply-release-rules.py` owns scoring only. **They must not both own
membership** — when they did, one re-added DVD rungs to "HD 1080p" and
recreated a profile the other had just pruned.

## R9 — A profile that upgrades may fall back

`DVDSCR, SDTV, DVD, DVD-R` on any profile with `upgradeAllowed`, which is the
entire safety argument: a DVD grabbed under such a profile is a **placeholder**
Radarr replaces the moment something better appears. On a profile that never
upgrades the same change would make a DVDRip permanent.

## R10 — Write an NFO, so Jellyfin never has to guess

Radarr imported Fall (2022) correctly and Jellyseerr still showed the request
as processing. Jellyfin had the file but had not identified it against TMDB —
no provider ids, no artwork — and **Jellyseerr matches on TMDB id alone**, so a
film sitting on disk looked like a request that had never been fulfilled.

Every metadata provider was disabled, leaving Jellyfin only the filename to go
on. That usually works and silently sometimes does not, which is the worst of
both. `XbmcMetadata` on in both apps: one small `.nfo` carrying
`<uniqueid type="tmdb">`, and the guessing stops.

## R11 — No 4K, and no remuxes

**4K cannot be scoped per user.** Jellyfin serves one file per title to
everyone, so a 4K copy becomes *everyone's* copy. Giving one person 4K and
another 1080p means a second Radarr with its own root folder and a second
Jellyfin library — see below. This server also has no HEVC hardware decoder
(i7-3615QM, HD 4000; Intel added it in Skylake), so anything that fails to
direct-play falls to software decoding on a 2012 CPU.

**Remux is out for the same practical reason.** A remux is the untouched
lossless stream at 20–40GB, and both apps take the highest allowed quality, so
one existing would beat every sane encode. Nothing at that bitrate direct-plays
to a phone over the mesh.

`Bluray-1080p` stays: it labels the *source*, not the size, and the best
encodes come from it — Pinocchio: Unstrung arrived as a 1.52GiB BluRay rip.

## Traps, all found the hard way

- **Deleting a profile orphans Jellyseerr.** It stores its default as a bare
  id; delete that profile and the id simply dangles. Nothing logs it, and the
  next request lands wherever Radarr falls back to. `quality-profiles.py`
  repairs it after a prune.
- **Radarr collections pin a profile too.** One per TMDB collection, each with
  its own `qualityProfileId`. That is how `QualityProfile [4] is in use`
  appears with no movie on it.
- **Radarr stores qualities worst-first.** Printing a profile in stored order
  puts the floor at the front and reads exactly backwards.
- **RSS sync only carries newly published releases.** A back-catalogue title is
  never searched for at all and sits reporting "searching" forever — there is
  no search-for-missing task. `scripts/search-missing.py` covers it; television
  is opt-in behind `--tv`, because the library has 256 missing episodes and
  firing them at once is a grab storm.
- **Dry-run everything.** Three separate bugs in these scripts were caught
  before touching the server: an override leaking between profiles, a removal
  that would have stripped DVD from `Any` and `SD`, and a 4K profile being
  handed DVD rungs.

## Two qualities of the same title

Not possible as configured, and that is the same mechanism that guarantees no
duplicates: one movie is one Radarr record, one profile, one file, and an
upgrade **replaces** rather than adds.

The supported way is a second Radarr instance with its own root folder,
registered in Jellyseerr as an `is4k` server, plus a second Jellyfin library —
which is exactly why Jellyseerr has a separate "Request 4K" flow and per-user
`REQUEST_4K` permissions. It produces two entries for one title by design; that
is not a side effect to configure away.

Deferred, deliberately. What covers most of the want instead is changing a
title's profile when something different is actually needed — Bin Roye moved
from `HD` to `CAM` and went looking for lower-quality releases with no second
entry appearing.

## Telling the two failures apart

`GET /candidates?tmdbId=…&type=movie|tv[&season=N]` on jellylab-push runs a live
interactive search and answers which failure a stuck request is:

```
Fall      found 256 · accepted 34   → the choosing is wrong  (R0, R1, R4)
Bin Roye  found   7 · accepted  0   → nothing is grabbable   (R8)
```

Only accepted releases are listed — a list of things that cannot be grabbed is
noise. When that list is empty the count and the rejection reasons are the
entire diagnosis, so those always come back.

It sweeps every indexer and takes tens of seconds. Asked for by hand, never
polled.
