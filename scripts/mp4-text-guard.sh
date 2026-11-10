#!/usr/bin/env bash
# Move text tracks out of MP4s, into sidecar .srt files.
#
# Safari plays an MP4 with its own player, finds any text track inside it and
# may switch one on by itself - drawn in its own box, next to the subtitle
# Jellyfin draws, and out of reach of Jellyfin's subtitle menu. A file with no
# text tracks inside cannot do that. The languages are kept, as sidecars
# Jellyfin lists like any other external subtitle.
#
# Covers tx3g/mov_text subtitles and QuickTime chapter-text tracks (data
# streams). MKV is left alone: no browser plays it directly. Video and audio
# are copied, never re-encoded. Runs from cron; DRY_RUN=1 only reports.
set -uo pipefail

HOMELAB_DIR="${HOMELAB_DIR:-$HOME/homelab}"
STATE_DIR="${HOMELAB_STATE_DIR:-$HOME/homelab-scripts}"
# as the host sees it: MEDIA_ROOT from the environment, else from .env
MEDIA_HOST="${MEDIA_ROOT:-$(sed -n 's/^MEDIA_ROOT=//p' "$HOMELAB_DIR/.env" | tr -d '"'\'' ')}"
[ -n "$MEDIA_HOST" ] || { echo "MEDIA_ROOT is not set: add it to $HOMELAB_DIR/.env" >&2; exit 1; }
MEDIA_CT=/media                   # as the jellyfin container sees it
LOG="$STATE_DIR/mp4-text-guard.log"
FF=/usr/lib/jellyfin-ffmpeg
DRY_RUN=${DRY_RUN:-0}
# hidden and outside every library folder, so no app scans it
KEEP="$MEDIA_HOST/.mp4-text-guard-originals"
KEEP_DAYS=14

log() { printf '%s  %s\n' "$(date '+%F %T')" "$1" | tee -a "$LOG"; }
ct()  { docker exec jellyfin "$@"; }

exec 9>"$STATE_DIR/.mp4-text-guard.lock"
flock -n 9 || exit 0

# Sidecar names use the two-letter codes Bazarr writes, so an existing
# Bazarr .nl.srt is recognised rather than duplicated as .dut.srt.
two() {
  case "$1" in
    eng) echo en;; dut|nld) echo nl;; tur) echo tr;; spa) echo es;; fre|fra) echo fr;;
    ger|deu) echo de;; por) echo pt;; ita) echo it;; jpn) echo ja;; ara) echo ar;;
    rus) echo ru;; chi|zho) echo zh;; kor) echo ko;; pol) echo pl;;
    ''|und) echo und;; *) echo "$1";;
  esac
}

# -mmin +10: leave files alone while an import may still be writing them.
find "$MEDIA_HOST" \( -path "$MEDIA_HOST/downloads" -o -path "$KEEP" \) -prune -o -type f -name '*.mp4' -mmin +10 -print |
while IFS= read -r host; do
  rel=${host#"$MEDIA_HOST"/}
  f="$MEDIA_CT/$rel"
  streams=$(ct "$FF/ffprobe" -v fatal -show_entries stream=index,codec_type:stream_tags=language,title,name \
            -of csv=p=0 "$f" </dev/null) || { log "ERROR probe failed: $rel"; continue; }
  text=$(awk -F, '$2=="subtitle" || $2=="data"' <<<"$streams")
  [ -z "$text" ] && continue

  if [ "$DRY_RUN" = 1 ]; then
    log "WOULD fix $rel: $(tr '\n' ' ' <<<"$text")"
    continue
  fi

  size_gb=$(( $(stat -c %s "$host") / 1024**3 + 1 ))
  free_gb=$(df --output=avail -BG "$MEDIA_HOST" | tail -1 | tr -dc '0-9')
  if [ "$free_gb" -lt $(( size_gb * 2 + 20 )) ]; then
    log "SKIP $rel: ${free_gb}GB free, needs room for a ${size_gb}GB copy"
    continue
  fi

  base_host=${host%.mp4}; base_ct=${f%.mp4}
  while IFS=, read -r idx type lang label; do
    [ "$type" = subtitle ] || continue
    code=$(two "$lang")
    out="$base_ct.$code.srt"
    # A second track in the same language (Brazilian and European Portuguese)
    # gets a title token, which Jellyfin shows as "<token> - Portuguese". The
    # track's own label is the useful one; "BTM" is just a placement name.
    if [ -e "$base_host.$code.srt" ]; then
      token=$(sed -E 's/\bBTM\b//g; s/[^A-Za-z0-9-]+/ /g; s/^ +| +$//g; s/ +/-/g' <<<"$label")
      out="$base_ct.${token:-track$idx}.$code.srt"
    fi
    if [ -e "$MEDIA_HOST/${out#"$MEDIA_CT"/}" ]; then
      log "keep existing $(basename "$out")"
      continue
    fi
    if ct "$FF/ffmpeg" -nostdin -v error -i "$f" -map "0:$idx" -c:s srt "$out" </dev/null; then
      ct chown 1000:1000 "$out"
      log "sidecar $(basename "$out")"
    else
      log "ERROR extracting track $idx from $rel"
      ct rm -f "$out"
    fi
  done <<<"$text"

  # .tmp, not .mp4, so neither Jellyfin nor the arr apps pick up the half-written copy
  tmp_ct="$(dirname "$f")/.$(basename "$f").tmp"
  tmp_host="$MEDIA_HOST/${tmp_ct#"$MEDIA_CT"/}"
  if ! ct "$FF/ffmpeg" -nostdin -v error -y -i "$f" -map 0 -map -0:s -map -0:d \
        -map_chapters -1 -c copy -movflags +faststart -f mp4 "$tmp_ct" </dev/null; then
    log "ERROR remux failed, original kept: $rel"
    ct rm -f "$tmp_ct"; continue
  fi

  # same length and no text left, or the original stays
  d_old=$(ct "$FF/ffprobe" -v fatal -show_entries format=duration -of csv=p=0 "$f" </dev/null)
  d_new=$(ct "$FF/ffprobe" -v fatal -show_entries format=duration -of csv=p=0 "$tmp_ct" </dev/null)
  left=$(ct "$FF/ffprobe" -v fatal -show_entries stream=codec_type -of csv=p=0 "$tmp_ct" </dev/null |
         grep -c -E '^(subtitle|data)$')
  if ! awk -v a="$d_old" -v b="$d_new" 'BEGIN{d=a-b; exit !(a>0 && d<1 && d>-1)}' || [ "$left" != 0 ]; then
    log "ERROR check failed (duration $d_old -> $d_new, text left $left), original kept: $rel"
    ct rm -f "$tmp_ct"; continue
  fi

  links=$(stat -c %h "$host")
  ct chown 1000:1000 "$tmp_ct"
  touch -r "$host" "$tmp_host"
  # the original is moved aside, not deleted: same filesystem, so instant,
  # and undoing a fix is one mv back
  mkdir -p "$KEEP/$(dirname "$rel")"
  mv "$host" "$KEEP/$rel" && mv "$tmp_host" "$host"
  log "fixed $rel, original in $KEEP$([ "$links" -gt 1 ] && echo " (was hardlinked: the seeding copy keeps its own blocks until it is removed)")"
done

# originals are kept KEEP_DAYS, long enough for someone to notice a bad fix.
# -ctime, not -mtime: mv keeps the film's old mtime (months back), but the
# rename itself sets ctime - the moment it was set aside.
find "$KEEP" -type f -ctime +"$KEEP_DAYS" -print -delete 2>/dev/null | while IFS= read -r gone; do
  log "dropped kept original ${gone#"$KEEP"/}"
done
find "$KEEP" -mindepth 1 -type d -empty -delete 2>/dev/null
