# Subtitles

Bazarr on 6767, a handful of providers, and two settings that between them decide whether
anything arrives at all.

| | |
|---|---|
| providers | `opensubtitlescom` (account `the-furkan`, **VIP since 2026-08-30**), `subsource`, `subf2m`, `animekalesi`, `animesubinfo`, `whisperai` |
| profile | `English + Dutch + Turkish`, `cutoff: None`, on all 36 titles |
| embedded | `use_embedded_subs: true` — a language already inside the file is never fetched again |

## The cutoff trap

**`cutoff` means "stop looking once you have this one".**

The profile was named `English + Dutch` and had `cutoff` pointing at English.
So Bazarr found an English subtitle, considered the title finished, and never
went looking for Dutch — for months, doing exactly what it was told. Nothing in
the library had Dutch unless the release shipped it embedded.

`cutoff: None` collects every language in the profile. There is no reason to
set a cutoff on a profile whose whole point is several languages.

## Count embedded tracks, or the library looks broken

`use_embedded_subs` is on, so Bazarr deliberately does **not** fetch a language
the file already carries. Counting sidecar `.srt` files alone is therefore
badly misleading:

```
by sidecar only        the entire anime shelf looks unsubtitled
counting both          en 30/33 titles · nl 24/33 · tr 28/33
```

Maleficent (2014) carries English SDH inside. Tokyo Ghoul and Steins;Gate carry
English fansubs. Now You See Me carries Turkish. All of those read as gaps from
the outside and are not.

```
scripts/subtitle-coverage.py            both, per title
scripts/subtitle-coverage.py --missing  only the real gaps
```

Genuine gaps are a handful of films short one language, plus Dutch on anime —
which barely exists on these providers and is unlikely to arrive.

## A stall is a file, not a mystery

```
ssh homelab "docker exec bazarr sh -c 'cat /config/config/throttled_providers.dat'"
```

`{}` is healthy. Anything else names the reason and the wall-clock time Bazarr
will wait until:

```
{'opensubtitlescom': ('DownloadLimitExceeded', datetime(2026, 8, 31, 3, 16), '6 hours')}
```

**Bazarr honours its own throttle even after the provider's real limit lifts.**
Buying VIP changed nothing until that file was cleared and Bazarr restarted —
it was still sitting out a six-hour penalty from the free tier. With one
provider, its throttle is the whole budget.

## AnimeTosho is gone

AnimeTosho stopped taking new torrents in May 2026 and its feed server
(`feed.animetosho.org`) stopped resolving in October 2026. Bazarr 1.6.2 still
had it hardcoded, so every anime search ended in `ProxyError` and an hour's
throttle. Disabled 2026-10-26. `feed.animetosho.xyz` now redirects to an
`animetosho.net` run by someone else - not used.

## No Japanese

Anime ships Japanese embedded rather than published separately, and
`use_embedded_subs` finds those tracks without asking anyone. Requesting it
externally spent a quarter of the budget on searches that could not land.

## Subtitles that disappear for minutes

Symptom: subtitles are fine for a while, then nothing for several minutes, then
they come back — or they run on after the episode has ended.

Bazarr syncs every download to the audio. When ffsubsync fails it says nothing;
it applies whatever it found, and the history reads like success:

```
English subtitles synchronization ended with an offset of 48.86 seconds
and a framerate scale factor of 1.05.
```

Aoashi S01E03, 24:16 long, came out of that with its last line at 26:38 and a
16-minute stretch with no line at all. History alone cannot sort good from bad
— 421 files had a "large" correction and most of them are right; a 1.04 scale
is the correct fix for a 25 fps release.

`scripts/subtitle-health.py` measures the files against Jellyfin's runtime
instead:

| flag | means |
|---|---|
| overrun | last line ends > 60 s after the video |
| truncated | last line ends a hole's length before the video does: CD1 of a two-part upload, or subtitles for a shorter cut |
| hole | > 5 min without a line (episodes), > 15 min (films — 1917, The Revenant and Cast Away really are 10 quiet minutes) |
| sparse | < 3 lines a minute: a signs-only track |
| bloated | > 40 lines a minute: karaoke and effects turned into text |

```
python3 ~/homelab-scripts/subtitle-health.py            # report only
python3 ~/homelab-scripts/subtitle-health.py --fix      # blacklist + replace
```

`--fix` blacklists each flagged file in Bazarr. That deletes it and queues a
new search on its own — **do not queue a second search on top**: two jobs
syncing one file at the same time lost it (Aoashi E03, the first run). It also
does nothing while Bazarr has jobs queued, because a file being written reads
as broken. Cron runs it at 05:15.

After three blacklists for one title and language it keeps what it has. A
video in a cut nobody subtitles only ever gets another wrong file back:
Watchmen is the theatrical cut and every Dutch upload is the Ultimate Cut
(ends at 3:24 of 2:43); The Office seasons 2–9 are the longer "Superfan"
episodes, so Dutch and Turkish made for the broadcast cut end ten minutes
early and drift on the way.

First run, 2026-10-20: 87 flagged, 71 after tuning the thresholds, 67
replaced. Files Bazarr did not download itself are reported and left alone.

## Anime subtitles that never appear on the TV

Symptom: a remote viewer on the Android TV app starts an anime episode, no
subtitles come up, they restart it a few times and give up. Aoashi S2 and
Dragon Ball Super: Beerus for robin, 2026-10-26.

Remote users get the video remuxed, so the subtitle has to come as its own
stream. When it is a track *inside* the MKV, Jellyfin reads the whole file to
pull it out - 2.5 minutes for a 1.5 GB episode on this disk - and each
restart starts that over. Season 1 had Bazarr sidecars and loaded at once;
Crunchyroll releases carry English inside, and with AnimeTosho gone nothing
fetches a sidecar for them.

`scripts/subtitle-extract.py` runs from cron every 15 minutes and gives every
anime episode with an English text track inside a dialogue-only `.en.srt`
(signs, karaoke and drawings dropped). Jellyfin then picks the external SRT
by default - which also overrides releases that flag another language as
default (Aoashi S02E02 defaults to Thai).

```
tail ~/homelab-scripts/subtitle-extract.log
python3 ~/homelab-scripts/subtitle-extract.py --dry-run
```

Releases with no English inside at all (ToonsHub AMZN "Japan" WEB-DLs carry
only Japanese) still need a different release or a Bazarr sidecar.

## Two subtitle lines drawn over each other

Symptom: in an anime episode, a second line in italics is printed straight
through the dialogue ("I knew it. Which" with "Villager: Lv 1" on top of it).
Harem in the Labyrinth and Firefly Wedding, 2026-11-10.

Anime subtitles are mostly converted from fansub or Crunchyroll ASS files,
where a sign or status screen is translated at the top of the picture while
the dialogue runs at the bottom. SRT has no position, so both lines land at
the bottom at the same moment and the player draws them over each other.
Two people speaking at once does the same. Half of the anime sidecars had it.

`scripts/subtitle-overlap.py` runs from cron every 15 minutes (five minutes
after `subtitle-extract.py`) over the folders in `SUBTITLE_OVERLAP_DIRS`
(default `anime`) and rewrites every SRT with overlapping lines so that only
one cue is on screen at a time:

- an overlap under half a second ends the earlier line sooner
- a real overlap becomes one cue with the lines stacked; no text is lost
- karaoke left-overs (a lone `♪` or letter per cue) and lines repeated from a
  second copy of the track are dropped
- a file where many lines still overlap after that is a bad conversion: it is
  logged as `broken` and left alone - replace it in Bazarr instead

```
5,20,35,50 * * * * /usr/bin/python3 $HOME/homelab-scripts/subtitle-overlap.py >> $HOME/homelab-scripts/subtitle-overlap.log 2>&1
```

Bazarr also runs it on every subtitle it downloads, so a fresh file is merged
at once instead of at the next cron run. Compose mounts `scripts/` read-only
into the Bazarr container; in Bazarr, Settings → Subtitles → Post-Processing:

```
MEDIA_ROOT=/media python3 /homelab-scripts/subtitle-overlap.py --fix-file "{{subtitles}}"
```

```
grep broken ~/homelab-scripts/subtitle-overlap.log
python3 ~/homelab-scripts/subtitle-overlap.py --dry-run
python3 ~/homelab-scripts/subtitle-overlap.py --file Episode.en.srt   # print the result
```

## Two subtitles at once in Safari

Symptom: in Safari, Jellyfin's subtitle sits bottom centre and a second copy
sits bottom right, and switching subtitles off in Jellyfin leaves the second
one up.

Safari plays an MP4 with its own player. That player reads any text track
*inside* the file (`tx3g`/`mov_text` subtitles, and QuickTime chapter-text
tracks) and may switch one on by itself, drawn in the track's own box.
Jellyfin's menu only controls what Jellyfin draws. MKV never does this —
no browser plays it directly.

`scripts/mp4-text-guard.sh` runs from cron every 15 minutes and takes every
text track out of every MP4 under `/mnt/storage/media`:

- each subtitle track becomes a sidecar (`Film.en.srt`); a second track in the
  same language is named after the track's own label (`Film.PT.pt.srt`, shown
  as "PT - Portuguese"), worth renaming by hand to something readable like
  `Film.European.pt.srt`; an existing sidecar is never touched
- video and audio are copied into a new MP4, not re-encoded; it only replaces
  the original if the length matches and no text track is left
- the original goes to `/mnt/storage/media/.mp4-text-guard-originals/` for
  14 days — undoing a fix is one `mv` back, then a full metadata refresh

```
DRY_RUN=1 ~/homelab-scripts/mp4-text-guard.sh   # what it would change
tail ~/homelab-scripts/mp4-text-guard.log
```

After a fix Jellyfin keeps listing the old embedded tracks until the item gets
a **full** refresh (`MetadataRefreshMode=FullRefresh`) — a default refresh does
not probe the file again. Its library monitor usually does this on its own.

A hardlinked file (still seeding) stops sharing blocks with its download copy
when it is replaced; the space comes back when qBittorrent removes the torrent.

## Applying changes

`scripts/subtitle-languages.py`, dry-run by default:

```
python3 scripts/subtitle-languages.py                    # what it would change
python3 scripts/subtitle-languages.py --apply --search   # change it, then go looking
```

`--search` matters: adding a language does not backfill it. Bazarr only looks
when something asks, so without it the change appears to do nothing until the
next import.

## API notes

- Settings save by POSTing to `/api/system/settings`. List values need
  **repeated form fields** (`-d 'k=a' -d 'k=b'`), never a JSON string — a JSON
  string nests the list and silently disables every provider.
- Language profiles save through that same endpoint as `languages-profiles`,
  **not** through `/api/system/languages/profiles`, which is read-only (405).
- Providers that were tried and dropped: `yifysubtitles` served a *truncated*
  English sub (67 cues ending at 05:17 of a 20:45 film) and throttles
  constantly; `turkcealtyaziorg` needs an account. A partial sidecar looks
  exactly like a broken player — subtitles appear, then stop.
