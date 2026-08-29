#!/usr/bin/env bash
#
# Prepare a new disk as a data disk. See docs/storage.md.
#
#   sudo scripts/setup-data-disk.sh --used
#
# Everything destructive is behind a check. It refuses if the device is not the
# drive it expects, if anything is mounted from it, or if SMART says the surface
# is degrading - and it asks before it writes.
#
# It copies no media. That is the next step, on purpose: the originals stay on
# the SSD until the new disk has been watched from.
set -euo pipefail

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

# An argument, not an environment variable: sudo resets the environment by
# default, so `sudo USED=1 script` arrives with USED unset and the script
# refuses a drive you had already told it about.
USED=0
for arg in "$@"; do
  case "$arg" in
    --used) USED=1 ;;
    *) red "unknown argument: $arg"; exit 1 ;;
  esac
done

DEV="${DEV:-/dev/sdb}"
PART="${DEV}1"
EXPECT_MODEL="${EXPECT_MODEL:-WD101EMAZ}"  # the disk it refuses to touch anything but
MOUNT="${MOUNT:-/mnt/newmedia}"
LABEL="media"

[ "$(id -u)" -eq 0 ] || { red "run with sudo"; exit 1; }

bold "1. the disk"

# Told apart by model and transport, not by name: sdb is only sdb until
# something else is plugged in first.
model=$(lsblk -dn -o MODEL "$DEV" 2>/dev/null | tr -d ' ' || true)
tran=$(lsblk -dn -o TRAN "$DEV" 2>/dev/null | tr -d ' ' || true)
size=$(lsblk -dn -o SIZE "$DEV" 2>/dev/null | tr -d ' ' || true)
echo "   $DEV  $size  $model  $tran"

case "$model" in
  *"$EXPECT_MODEL"*) ;;
  *) red "   expected a $EXPECT_MODEL, found '$model' - refusing"; exit 1;;
esac
[ "$tran" = "usb" ] || { red "   $DEV is not the USB disk - refusing"; exit 1; }

if lsblk -n -o MOUNTPOINT "$DEV" | grep -q .; then
  red "   something is mounted from $DEV - refusing"
  lsblk -o NAME,SIZE,MOUNTPOINT "$DEV"
  exit 1
fi
green "   ok - right disk, nothing mounted from it"

bold "2. health"

smart=$(smartctl -d sat -H -A "$DEV" 2>/dev/null || true)
if [ -z "$smart" ]; then
  red "   SMART unreadable through the USB bridge."
  red "   Cannot judge the drive blind - stopping rather than guessing."
  exit 1
fi

attr() { echo "$smart" | awk -v n="$1" '$2 == n { print $10; exit }'; }
hours=$(attr Power_On_Hours)
realloc=$(attr Reallocated_Sector_Ct)
pending=$(attr Current_Pending_Sector)
offline=$(attr Offline_Uncorrectable)
health=$(echo "$smart" | grep -i 'test result' | sed 's/.*: *//')

printf '   overall        %s\n' "${health:-unknown}"
printf '   power on       %s hours\n' "${hours:-?}"
printf '   reallocated    %s\n' "${realloc:-?}"
printf '   pending        %s\n' "${pending:-?}"
printf '   uncorrectable  %s\n' "${offline:-?}"

fail=0
[ "${health:-}" = "PASSED" ] || { red "   overall health is not PASSED"; fail=1; }

# Hours are context, not a verdict. A drive bought used has them by definition,
# and four thousand is a fraction of what a helium drive is rated for.
if [ -n "${hours:-}" ] && [ "$hours" -gt 100 ] 2>/dev/null; then
  if [ "$USED" = "1" ]; then
    echo "   ($hours hours - expected on a used drive, allowed)"
  else
    red "   $hours power-on hours - this is not a new drive"
    red "   if you bought it used, re-run with:  sudo $0 --used"
    fail=1
  fi
fi

# The two that predict failure: sectors already retired, and sectors that failed
# a read and are queued to be. Non-zero on either means the surface is going,
# and no price makes that worth 238GB of media.
if [ -n "${realloc:-}" ] && [ "$realloc" -gt 0 ] 2>/dev/null; then
  red "   $realloc reallocated sectors - the surface is degrading, refusing"; fail=1
fi
if [ -n "${pending:-}" ] && [ "$pending" -gt 0 ] 2>/dev/null; then
  red "   $pending pending sectors - the surface is degrading, refusing"; fail=1
fi

# Offline_Uncorrectable is weaker evidence: one, with nothing pending and
# nothing reallocated, is usually a single transient read - a knock, a power
# blip - not rot. Worth knowing, not worth refusing over.
if [ -n "${offline:-}" ] && [ "$offline" -gt 0 ] 2>/dev/null; then
  if [ "$offline" -gt 5 ] 2>/dev/null; then
    red "   $offline uncorrectable sectors - too many, refusing"; fail=1
  else
    echo "   ($offline uncorrectable, nothing pending or reallocated - reads as"
    echo "    a one-off. Writing the disk will force it to retire or clear it;"
    echo "    check these three numbers again after the copy.)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  red ""
  red "   Stopping. Nothing has been written."
  exit 1
fi
green "   ok - nothing here predicts failure"

bold "3. a quick read test"
# Not a surface scan - proof the platters and the USB bridge sustain a sensible
# rate before trusting hours of copying to them.
speed=$(hdparm -t --direct "$DEV" 2>/dev/null | grep -oE '[0-9.]+ MB/sec' | tail -1 || true)
echo "   ${speed:-unknown}"
echo "   (under about 80 MB/sec would suggest USB 2 or a bad cable)"

bold "4. what happens next"
cat <<EOF

   ERASES $DEV entirely - the factory NTFS partition and WD's bundled
   software. It then:

     - writes a fresh GPT label and one ext4 partition across the whole disk
     - reserves 0% for root rather than ext4's default 5%, which on 9.1TB
       would set aside about 465GB for nothing
     - mounts it at $MOUNT, and adds it to /etc/fstab by UUID with nofail so
       a device rename cannot break it and the machine still boots without it

   No media is copied and nothing under /mnt/media is touched.

EOF

read -r -p "   type YES to go ahead: " answer
[ "$answer" = "YES" ] || { echo "   nothing done"; exit 0; }

bold "5. formatting"
wipefs -a "$DEV" >/dev/null
parted "$DEV" --script mklabel gpt mkpart primary ext4 0% 100%
# Settle, or mkfs races the kernel's re-read of the partition table.
partprobe "$DEV" 2>/dev/null || true
sleep 3
mkfs.ext4 -q -m 0 -L "$LABEL" "$PART"
green "   done"

bold "6. mounting"
uuid=$(blkid -s UUID -o value "$PART")
mkdir -p "$MOUNT"

# By UUID, because /dev/sdb is a name the kernel hands out in the order things
# are found - plug a stick in before a reboot and it belongs to something else.
# nofail: without it a missing USB disk drops the machine to an emergency prompt
# at boot, over ssh, with nobody at the keyboard.
if ! grep -q "$uuid" /etc/fstab; then
  printf 'UUID=%s  %s  ext4  defaults,nofail,x-systemd.device-timeout=30  0  2\n' \
    "$uuid" "$MOUNT" >> /etc/fstab
fi
systemctl daemon-reload 2>/dev/null || true
mount "$MOUNT"
chown furkan:furkan "$MOUNT"

green "   mounted:"
df -h "$MOUNT" | tail -1 | sed 's/^/   /'
echo
green "Ready. UUID=$uuid"
echo "Nothing has been copied yet."
