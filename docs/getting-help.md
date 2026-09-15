# Getting help

- **Docker won't start something:** `docker logs <container_name>` shows why
- **Can't SSH in:** check the Mac Mini's IP hasn't changed (check router)
- **Service won't respond in browser:** check `docker compose ps` — is it running? Check firewall on the Mac Mini (`sudo ufw status`)
- **Is the Mac Mini busy or idle?** The SSH login banner already shows load average, temperature, memory, and disk in one glance. For more detail:
  - `htop` — live per-core CPU + per-process view (`q` to quit)
  - `docker stats --no-stream` — CPU + RAM per container, identifies the hog
  - `grep MHz /proc/cpuinfo` — current CPU frequency (Ivy Bridge idles ~1200 MHz, boosts to ~3300 MHz under load; stuck-high = permanently busy)
  - `sensors` (after `sudo apt install lm-sensors && sudo sensors-detect --auto`) — per-core temperatures
  - `uptime` — 1min / 5min / 15min load history
  - Baseline for this stack at idle: ~25% RAM, load 0.3-0.6, CPU freq ~1200-1600 MHz, temp 55-62°C
- **Does the Mac Mini need a monitor to stay on?** No. Ubuntu Server runs headless; no display attached is the intended state. It only powers off on unplug, `shutdown`, thermal cutoff, or kernel panic. The `homelab login:` prompt on a connected screen is the normal state too; nothing waits for you to log in there.
- **The Mac Mini answers ping but nothing else, and the whole house "has no
  internet"?** It has probably crashed and not come back. Pi-hole is the only
  DNS server the router hands out, so every device loses name lookups with it.
  That happened on 2026-09-15:
  - **What it looked like:** ping answered in under a millisecond, but SSH,
    Jellyfin, Pi-hole and every other port refused connections. The public
    relay names were down, because their tunnel runs on the same machine.
  - **What the screen showed:** a kernel oops ("Corrupted page table",
    "Oops: Bad pagetable") in qBittorrent's memory, then kdump saving a crash
    dump to `/var/crash`, then kdump itself hanging for 35 minutes waiting for
    the USB data disk instead of rebooting. A reserved bit set in a page table
    entry usually points at a flipped bit in RAM (this machine has no ECC), less
    often at a kernel bug. Test the memory with memtest86+ before blaming
    software.
  - **Getting the house online meanwhile:** set the router's DHCP DNS to a
    public resolver (e.g. `9.9.9.9`) until the Mac Mini is back, then back to
    Pi-hole.
  - **Getting in:** only the console works. Connect a monitor and keyboard; a
    power cycle (Ctrl+Alt+Delete, or holding the power button) brings it back
    once the dump is saved.
  - **Finding the cause afterwards:** the dmesg of the crash is kept by
    systemd-pstore in `/var/lib/systemd/pstore/`, and by kdump (if installed)
    in `/var/crash/<date>/dmesg.*`. Both are root-only.
  - **So it restarts by itself next time:**
    [`scripts/reboot-on-crash.sh`](../scripts/reboot-on-crash.sh), run once
    with `sudo`. It sets `kernel.panic = 10` (reboot 10 seconds after a crash;
    the default `0` hangs forever), `kernel.panic_on_oops` and
    `kernel.softlockup_panic`, and removes kdump, whose capture step is what
    hung (pstore still keeps the crash log, and the 512 MB kdump reserved comes
    back). It also tests the hardware watchdog: on this Mac Mini the firmware
    has it disabled ("unable to reset NO_REBOOT flag"), so there is no
    watchdog to lean on.
  - **The day before**, the same crash dump showed the kernel OOM-killing
    Sonarr at 9.5 GB, at the exact minute gluetun started to hang. Every
    service now has a `mem_limit` in `docker-compose.yml` for that reason.
- **Adding a service of your own?** If its data directory lives inside
  `~/homelab`, add it to `.gitignore` **in the same commit**. The repo is
  public, and a missing entry once published Homarr's database.
- **Forgot the Nextcloud password?**
  `ssh -t homelab docker exec -it -u www-data nextcloud php occ user:resetpassword <user>`.
  It needs both `-t` and `-it`, or the prompt reads an empty password. The
  password policy rejects anything found in the Have I Been Pwned breach list.
  With no email on the account, "forgot password" in the web UI can't work.
- **Need a Nextcloud app password without logging in?**
  `docker exec -u www-data nextcloud php occ user:auth-tokens:add <user>` prints
  one. It's a limited token, which is fine for dashboards.
- **Adding a Pi-hole local DNS record without the UI:** `POST /api/auth` with
  the web password returns a session id; then
  `PUT /api/config/dns/hosts/<ip>%20<name>` with header `X-FTL-SID: <sid>`.
  Pi-hole listens on the LAN IP, so test with `dig <name> @192.168.1.42`, not
  `@127.0.0.1`.
- **General Linux help:** https://askubuntu.com
- **General homelab help:** https://reddit.com/r/selfhosted or https://reddit.com/r/homelab
- **Pi-hole:** https://discourse.pi-hole.net
- **Nextcloud:** https://help.nextcloud.com

---

[All phases](README.md)
