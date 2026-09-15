# Phase 8 — Stop the server transcoding: prefer H.264 at grab time

Symptom: an episode plays for a while, then jumps back a few seconds and
replays them. Subtitles drift out of sync with the audio, several seconds
adrift by the middle of an episode. Both get worse the longer you watch.

## What is actually happening

Neither is a subtitle bug or a network problem. Both are the same event.

The HD 4000 can hardware-decode H.264, VC-1 and MPEG-2 — and nothing else.
There is no HEVC or AV1 decode block on Ivy Bridge; it predates them. Confirm
it on the machine rather than taking anyone's word:

```bash
docker exec jellyfin /usr/lib/jellyfin-ffmpeg/vainfo \
  --display drm --device /dev/dri/renderD128 | grep VAProfile
# VAProfileMPEG2Simple / Main, VAProfileH264*, VAProfileVC1*, VAProfileJPEGBaseline
# no VAProfileHEVC*, no VAProfileAV1* — those are absent, not disabled
```

So when a browser asks for an HEVC file it cannot play, Jellyfin transcodes.
The *encode* goes to the GPU — the ffmpeg command shows `h264_vaapi` — but the
*decode* has nowhere to go and lands on the CPU. Look for `hwupload_vaapi` in
the filter chain with no `-hwaccel vaapi` on the input: that combination means
software decode, hardware encode.

A 2012 i7 cannot software-decode 1080p HEVC and keep ahead of playback. The
HLS buffer empties, Jellyfin kills ffmpeg and restarts it at an earlier seek
point. Catching it mid-restart shows two processes seconds apart:

```bash
ps -eo pid,pcpu,args | grep [f]fmpeg
#  211%  ... -ss 00:10:33.633 ... h264_vaapi ...
#  192%  ... -ss 00:10:42.642 ... h264_vaapi ...
```

Every one of those restarts is a few seconds of video played twice. Subtitles
are delivered on the original timeline while the video and audio stream get
re-seeked under `-copyts`, so they slide apart at the same time. One cause,
two symptoms.

## How much of the library this affects

```bash
find /mnt/media -type f \( -name '*.mkv' -o -name '*.mp4' \) \
  | grep -v /downloads/ | sed 's|^/mnt/media|/media|' > /tmp/vids.txt
docker exec -i jellyfin sh -c 'while IFS= read -r f; do
  /usr/lib/jellyfin-ffmpeg/ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name -of csv=p=0 "$f"; done' < /tmp/vids.txt \
  | sort | uniq -c | sort -rn
```

At the time of writing: 163 HEVC, 134 H.264, 75 AV1 — so roughly two thirds of
the library is in a codec this machine cannot hardware-decode. AV1 is the worse
half: it is heavier to decode in software than HEVC, and no client in the house
hardware-decodes it either.

## Step 8.1 — Score H.264 up, HEVC and AV1 down

Sonarr v4 and Radarr v5+ do this with **custom formats** scored per quality
profile. Three formats, matched against the release title:

| format | regex | score |
|---|---|---|
| H.264 (x264) | `\b(x\|h)\.?264\b\|\bavc\b` | +15 |
| HEVC (x265) | `\b(x\|h)\.?265\b\|\bhevc\b` | −20 |
| AV1 | `\bav1\b` | −25 |

Score, do not ban. A "must not contain x265" rejection rule starves anime,
where plenty of series are released in x265 only — you would get nothing at
all rather than something that needs transcoding. Scoring means x264 wins
whenever it exists and x265 is still grabbed when it is the only option.

## Step 8.2 — The setting that makes or breaks it

**Minimum Custom Format Score defaults to 0.** Leave it there and every one of
those negative scores becomes a rejection — the exact starvation Step 8.1 set
out to avoid. It has to go below the most negative score in use:

```
Minimum Custom Format Score   -100
Upgrade Until Custom Format Score   -100
```

The second one is deliberately equal to the first. It means any file already on
disk counts as having met the cutoff, so no format-driven upgrade is chased and
nothing already downloaded gets replaced.

Verify with the parse endpoint rather than trusting the regex by eye:

```bash
KEY=$(grep -oP '(?<=<ApiKey>)[^<]+' ~/homelab/sonarr/config/config.xml)
curl -s -H "X-Api-Key: $KEY" --get --data-urlencode \
  'title=Jujutsu Kaisen S02E01 1080p WEB-DL x265 DUAL AAC-Group' \
  http://localhost:8989/api/v3/parse | python3 -m json.tool | grep -A3 customFormats
```

Every codec must come back **allowed**, just ranked. If anything reads as
rejected, the minimum score is still too high.

## Step 8.3 — What this does and does not fix

It applies to **future grabs only**. The files already on disk stay exactly as
they are, so the stutter continues on everything downloaded before this.

To also convert the existing library, raise *Upgrade Until Custom Format Score*
to `15` and run a season search — Sonarr will then treat every x265 file as
below cutoff and look for an x264 replacement. Think before doing this: it is a
re-download of most of the library, and H.264 runs roughly 1.7× the size of
x265 for the same quality. Check free space first.

## Step 8.4 — Fix the client instead, for what is already downloaded

Nothing server-side helps a file that is already HEVC. The client has to decode
it locally:

- **Jellyfin Media Player** (`winget install Jellyfin.JellyfinMediaPlayer`) —
  bundles libmpv, so it plays HEVC, MKV and ASS subtitles itself with no
  Windows codec involved. Free, and the better player for anime.
- **Safari / iOS / Apple TV** — HEVC decodes in hardware, direct play.
- **Edge or Chrome on Windows** — needs the paid *HEVC Video Extensions* from
  the Store (~€1). The free "from Device Manufacturer" variant is OEM-gated and
  refuses to install on self-built and AMD machines.

Extensions that claim to add HEVC to a browser (h265ify and friends) do not
ship a decoder — they only change what the browser *reports* supporting. Since
Jellyfin picks direct play vs transcode from exactly that report, they can turn
a working transcode into a black screen.

## Step 8.5 — One group per resolution, or quality outranks codec

Scoring alone was not enough, and it took two bad grabs to see why. **Sonarr
compares quality first and custom format score only between releases of equal
quality.** In a profile that ranks HDTV-1080p < WEB-1080p < Bluray-1080p, a
Blu-ray always beats a WEB release, whatever codec either carries:

- Attack on Titan season 1 was on disk as HDTV-1080p x265. Sonarr "upgraded" it
  to a Blu-ray AV1 pack (score −25) over H.264 WEB packs (+15), because Blu-ray
  outranks HDTV. The AV1 pack then stalled at 86% with no complete copy in the
  swarm.
- Chainsaw Man got a "Bluray x264 CUSTOM MULTi" pack that never delivered its
  metadata, over the SubsPlease batch with 63 seeders, because Blu-ray outranks
  the HDTV label SubsPlease releases parse as.

The fix is to make every source of one resolution equal, so the score decides:
in the profile, merge HDTV-1080p, WEBRip-1080p, WEBDL-1080p and Bluray-1080p
into **one group** (Settings → Profiles → the profile → drag them together, or
`PUT /api/v3/qualityprofile/<id>` with a group item), do the same for 720p, and
set the cutoff to the 1080p group. Within a group the order becomes H.264 (+15),
then releases that name no codec (0), then HEVC (−20), then AV1 (−25).

Two consequences, both intended:

- a file of any 1080p source meets the cutoff, so nothing already on disk is
  replaced just because a Blu-ray appears;
- source no longer matters within a resolution. A Blu-ray and a broadcast rip of
  the same codec rank the same, and Sonarr's other rules break the tie.

Verified by searching one episode: Sonarr's result order for 1080p put every
H.264 release first, HDTV and WEB alike, then SubsPlease (no codec named), then
HEVC and AV1.

**State on this server.** Applied to Sonarr's profile "HD" (the one in use),
with the original saved first. Sonarr and Radarr now each hold a single
profile, renamed **"1080p – plays everywhere"**. The others (SD, HD 1080p, DVD,
CAM and a hand-made "HD + untagged (no upgrades)") were used by nothing, or by
one film each, and showed up as a confusing list in every request dialog. The
two films were moved to the remaining profile first. After a rename, Seerr needs
its default profile name updated and its Sonarr/Radarr caches flushed
(Settings → Jobs & Cache), or it keeps offering the old list. Radarr's profiles still rank sources, but its
minimum custom format score is `0` rather than the `−100` from Step 8.2, so
HEVC and AV1 films are refused outright rather than ranked low. That is stricter
than this phase intends, and it is left as is until a film goes missing for it.

---

[← Phase 7: Route qBittorrent through a VPN](07-qbittorrent-vpn.md) · [All phases](README.md) · [Phase 9: Catch a torrent that is not what it claims to be →](09-torrent-guard.md)
