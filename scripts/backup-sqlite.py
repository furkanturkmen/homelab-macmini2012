#!/usr/bin/env python3
"""Take consistent copies of the live SQLite databases.

Runs inside a throwaway container as root, because most of these files belong
to root and are held open by a running service. Copying such a file with `cp`
can capture a half-written page and produce a database that only fails when
you try to restore it - the worst possible time to find out. SQLite's backup
API takes a proper snapshot of a live database instead.

Usage: backup-sqlite.py <source-root> <destination-dir>
"""
import os
import sqlite3
import sys

# Source paths are relative to the homelab directory; names must stay unique.
DATABASES = {
    "jellyfin.db": "jellyfin/config/data/jellyfin.db",
    "kuma.db": "uptime-kuma/data/kuma.db",
    "jellyseerr.db": "jellyseerr/config/db/db.sqlite3",
    "npm.db": "npm/data/database.sqlite",
    "homarr.db": "homarr/appdata/db/db.sqlite",
    "sonarr.db": "sonarr/config/sonarr.db",
    "radarr.db": "radarr/config/radarr.db",
    "prowlarr.db": "prowlarr/config/prowlarr.db",
    "bazarr.db": "bazarr/config/db/bazarr.db",
    "ntfy-user.db": "ntfy/lib/user.db",
}

src_root, dest_dir = sys.argv[1], sys.argv[2]
os.makedirs(dest_dir, exist_ok=True)

failed = []
warnings = []
for name, rel in DATABASES.items():
    src = os.path.join(src_root, rel)
    dest = os.path.join(dest_dir, name)
    if not os.path.exists(src):
        print(f"  SKIP {name}: {rel} does not exist")
        continue
    try:
        # immutable=1 would skip locking but also risk a torn read; a normal
        # read-only connection plus the backup API is the safe combination.
        source = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=60)
        target = sqlite3.connect(dest)
        with target:
            source.backup(target)
        target.close()
        source.close()
        size = os.path.getsize(dest)
        # A snapshot that cannot be read back is not a snapshot. A damaged one
        # is still worth uploading - it restores further than nothing does -
        # so this warns rather than aborting, and the caller raises the alarm.
        check = sqlite3.connect(dest).execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            warnings.append(f"{name}: {check}")
            print(f"  WARN {name}  {size / 1e6:.1f} MB - integrity_check: {check}")
        else:
            print(f"  ok   {name}  {size / 1e6:.1f} MB")
    except Exception as e:  # noqa: BLE001
        failed.append(f"{name}: {e}")
        print(f"  FAIL {name}: {e}")

if warnings:
    # Read by backup.sh, which turns it into a push notification.
    with open(os.path.join(dest_dir, "INTEGRITY-WARNINGS.txt"), "w") as f:
        f.write("\n".join(warnings) + "\n")
    print("\ndamaged but backed up: " + "; ".join(warnings))
    print("repair with: REINDEX <table>  (service stopped), then re-check")

if failed:
    # Could not copy at all - that is a real failure, nothing usable was made.
    print("\ncould not snapshot: " + "; ".join(failed))
    sys.exit(1)

print("\nall databases snapshotted" + (" (with warnings)" if warnings else " and verified"))
