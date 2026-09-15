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
- **Does the Mac Mini need a monitor to stay on?** No. Ubuntu Server runs headless; no display attached is the intended state. It only powers off on unplug, `shutdown`, thermal cutoff, or kernel panic.
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
