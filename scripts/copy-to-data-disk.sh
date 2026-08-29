#!/usr/bin/env bash
#
# Copy a tree onto the data disk. Adds nothing, deletes nothing. See docs/storage.md.
#
#   scripts/copy-to-data-disk.sh          start it (detaches, survives the ssh dropping)
#   scripts/copy-to-data-disk.sh watch    follow the progress
#   scripts/copy-to-data-disk.sh check    compare the two trees when it is done
#
# Runs under tmux on purpose. It is half an hour of copying and an ssh session
# that closes takes an ordinary background job with it.
set -uo pipefail

SRC="${SRC:-/mnt/media}"
DST="${DST:-/mnt/newmedia}"
SESSION=mediacopy
LOG="${LOG:-$HOME/media-copy.log}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

case "${1:-start}" in

  start)
    [ -d "$SRC" ] || { red "$SRC is not there"; exit 1; }
    mountpoint -q "$DST" || { red "$DST is not a mount - is the disk still attached?"; exit 1; }

    if tmux has-session -t "$SESSION" 2>/dev/null; then
      red "already running - '$0 watch' to follow it"
      exit 1
    fi

    # -a  keeps permissions, timestamps, symlinks and ownership
    # -H  keeps hardlinks. Sonarr and Radarr hardlink from downloads into the
    #     library, so a film in both places is one lump of data in one place.
    #     Without this the copy makes two real files, costs 15GB more, and
    #     deleting the torrent afterwards stops freeing any space.
    # --partial   a file interrupted halfway is resumed rather than restarted
    # --info=progress2  one running total rather than a line per file
    #
    # No --delete anywhere. Nothing on the source is ever touched.
    tmux new-session -d -s "$SESSION" \
      "rsync -aH --partial --info=progress2 '$SRC/' '$DST/' 2>&1 | tee '$LOG'; echo; echo 'EXIT '\$?; sleep infinity"

    green "copying $SRC -> $DST"
    echo "  watch:  $0 watch     (ctrl-b then d to leave it running)"
    echo "  log:    tail -f $LOG"
    echo
    echo "Nothing under $SRC is modified or deleted."
    ;;

  watch)
    tmux attach -t "$SESSION" 2>/dev/null || { red "not running"; exit 1; }
    ;;

  check)
    # Sizes, then counts. du on both trees is the honest comparison: it counts
    # what is really on the disk, so if hardlinks were lost the destination
    # comes out visibly bigger and that is the thing worth catching.
    echo "source:"
    du -sh "$SRC" 2>/dev/null | sed 's/^/   /'
    find "$SRC" -type f 2>/dev/null | wc -l | sed 's/^/   files: /'
    find "$SRC" -type f -links +1 2>/dev/null | wc -l | sed 's/^/   hardlinked: /'
    echo "destination:"
    du -sh "$DST" 2>/dev/null | sed 's/^/   /'
    find "$DST" -type f 2>/dev/null | wc -l | sed 's/^/   files: /'
    find "$DST" -type f -links +1 2>/dev/null | wc -l | sed 's/^/   hardlinked: /'
    echo
    echo "the two file counts should match, and so should the hardlink counts."
    echo "a destination noticeably larger than the source means hardlinks were lost."
    ;;

  stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && green "stopped" || red "not running"
    echo "Nothing is lost - --partial means starting again resumes."
    ;;

  *)
    echo "usage: $0 [start|watch|check|stop]" >&2
    exit 1
    ;;
esac
