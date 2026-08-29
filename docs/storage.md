# Storage

Two disks, and the division is the point.

| | | |
|---|---|---|
| **SSD** | `/dev/sda`, 477GB Crucial | the OS, and everything under `~/homelab/` — every container's config and database |
| **HDD** | `/dev/sdb`, 10TB WD Elements over USB 3, mounted at `/mnt/storage` | all bulk data |

**The rule: a service runs from the SSD, its data lives on the HDD.**

Jellyfin's `library.db`, Sonarr's, Radarr's, pihole's — these do constant small
random writes, which is what an SSD is for. A 20GB episode read start to finish
does not care what it is stored on.

```
/mnt/storage/
├── media/          bind-mounted into six containers as /media
│   └── anime  movies  tv  music  downloads
├── documents/      nextcloud's data directory
└── backups/
```

## Why nothing had to be reconfigured

Containers bind-mount a **path**, and the path *inside* the container never
changed:

```
jellyfin etc.   /mnt/storage/media      -> /media
nextcloud       /mnt/storage/documents  -> /var/www/html/data
```

So Jellyfin kept its libraries, watch history and artwork with no re-scan, and
Nextcloud's `config.php` (`datadirectory => /var/www/html/data`) and every file
path in its database stayed correct. Only the host side of each mount moved.

Jellyseerr is not in this list: it talks HTTP to the other services and never
touches the filesystem.

## The disk

`WDC WD101EMAZ-11G7DA0` — a helium **CMR** drive, which matters: SMR drives
collapse to double-digit MB/s once their cache fills, and this one held
100-140MB/s across a 253GB copy without degrading.

Bought second-hand. At setup it read 4,222 power-on hours, 0 reallocated,
0 pending, **1 offline-uncorrectable**. Writing 253GB across it caused no
reallocations, so that 1 is a historical one-off rather than a spreading fault.

`Offline_Uncorrectable` only updates during an offline surface scan, so it does
not clear by itself:

```bash
sudo smartctl -d sat -t long /dev/sdb      # ~18 hours, runs inside the drive
sudo smartctl -d sat -l selftest /dev/sdb  # the result
```

Worth checking occasionally, on a used drive:

```bash
sudo smartctl -d sat -A /dev/sdb | grep -E 'Reallocated|Pending|Uncorrectable'
```

Reallocated or pending climbing over time is the signal to replace it. A stable
count is ageing, not failure.

## Four things that will bite anyone repeating this

**Hardlinks.** Sonarr and Radarr hardlink from `downloads/` into the library, so
a film in both places is one lump of data under two names — 226 files here. Any
copy needs `rsync -aH`, or it silently makes real duplicates: more space used,
and deleting the torrent afterwards frees nothing.

**Sparse files.** qBittorrent pre-allocates a torrent and fills it in, so a
part-finished download is all of its size and only some of its blocks. Without
`--sparse`, rsync writes the holes out as real zeros — that is why the
destination came out ~15GB larger than the source, and it is not a fault.

**Services write while you copy.** The first pass took an hour with everything
still running. Anything written after rsync walked past a directory is missing,
so it needs a second pass *after* stopping the containers.

**`nofail` in fstab.** Mount by UUID, because `/dev/sdb` is a name the kernel
hands out in the order it finds things. And `nofail`, or a missing USB disk
drops the machine to an emergency prompt at boot — over ssh, with nobody at the
keyboard.

```
UUID=c5de3438-...  /mnt/storage  ext4  defaults,nofail,x-systemd.device-timeout=30  0  2
```

`mkfs.ext4 -m 0`, too: the default reserves 5% for root, which on 9.1TB is 465GB
set aside for nothing. That reserve exists so a full disk cannot stop root
logging in, which is irrelevant on a disk the system does not boot from.

## Scripts

`scripts/setup-data-disk.sh` prepares a new disk: identifies it by model rather
than by `/dev/sdX`, refuses if SMART shows reallocated or pending sectors,
formats, and mounts it by UUID.

`scripts/copy-to-data-disk.sh` copies a tree onto it with the flags above, under
tmux so an ssh drop does not take it with it, and compares file counts and
hardlink counts afterwards.

The one-shot scripts that performed this migration are not kept — they are
recorded here instead, which is the part worth having.
