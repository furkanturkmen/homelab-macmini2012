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

## R8 — Match the quality floor to what was actually released

A profile demanding 720p+ for a film that only ever shipped on DVD produces a
permanent, silent "searching" with no error anywhere. Bin Roye is a 2015 Urdu
film: seven releases, five DVDRip, one CAM, one unparseable.

Regional and pre-2010 catalogue titles need one profile that reaches all the
way down, used for nothing else:

```
Name            Archive (last resort to 1080p)
Allowed         CAM, DVDSCR, SDTV, DVD, DVD-R, Bluray-480p, Bluray-576p,
                HDTV-720p, WEB 720p, Bluray-720p,
                HDTV-1080p, WEB 1080p, Bluray-1080p
Excluded        WORKPRINT, TELESYNC, TELECINE, REGIONAL, Unknown
Cutoff          WEB 1080p
upgradeAllowed  true
minFormatScore  0
```

**Why a camrip is allowed here.** Radarr grabs the best allowed quality that
exists, so the low rungs are unreachable while anything above them is on offer:

```
1080p exists       takes 1080p, never considers CAM
only CAM exists    takes CAM rather than searching forever
1080p appears      upgrades, replaces the CAM
```

The cutoff at 1080p with upgrades on is what makes it self-correcting - a
camrip is a placeholder, not a decision.

It is confined to this profile. An ordinary film should fail rather than fetch
a camrip, and a camrip is a favourite malware wrapper: Bin Roye's only CAM came
from TorrentDownload. The defence that actually covers that is R5 opening the
torrent and looking inside, not this list.

TELESYNC and TELECINE are better than CAM and carry identical risk. Add them if
the last resort should be less bad rather than merely present.

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
