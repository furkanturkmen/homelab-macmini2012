# homelab-macmini2012

Turning an old Mac Mini into a personal server for files, media, and network tools — a "homelab." This repo has all the configuration you need to build the same thing.

---

## What is a homelab?

A homelab is just a computer at home that runs services for you instead of paying big companies for them. Think:

- **Your own Google Drive** (Nextcloud) — files sync across devices, no monthly fee
- **Your own Netflix** (Jellyfin + Radarr + Sonarr) — stream movies and shows, request new ones from a friendly UI
- **Network-wide ad blocker** (Pi-hole) — blocks ads on every device on your wifi
- **Remote access from anywhere** (Netbird) — reach your server from your phone anywhere in the world, over an encrypted mesh VPN

You get privacy, save money over time, and learn a ton.

---

## What is this project?

A single Mac Mini from 2012 running a stack of 20 services. Everything is defined in `docker-compose.yml`. You install one thing (Docker), tell it "read this file," and it downloads and runs every service automatically.

Total setup time from a fresh computer: **about 2-3 hours**.

---

## The hardware

- **Mac mini (Late 2012)** — Apple model A1347, [identifier Macmini6,2](https://support.apple.com/en-us/111926)
- **Intel Core i7-3615QM** — 2.3 GHz, 4 cores, 8 threads, 6 MB L3 cache (Ivy Bridge)
- **Intel HD Graphics 4000** — integrated GPU. Does H.264 hardware transcoding via VA-API (Quick Sync). No HEVC, VP9 or AV1 support.
  This is a hard limit of the silicon, not a setting, and it decides what the library should hold: an HEVC or AV1 file has to be
  decoded in software before it can be re-encoded for a client, which this CPU cannot sustain in realtime. See [TODO.md](TODO.md)
  Phase 8 for how the *arr apps are told to prefer H.264, and what that looks like when they are not.
- **16 GB DDR3-1600 RAM** — maximum this model supports, cannot upgrade
- **Crucial MX100 512 GB SATA SSD** — the boot disk. If your Mac Mini is still on its stock 5400 rpm HDD, swapping in an SSD is the single biggest speed difference you can make on this machine — do it before installing Ubuntu, not after.
- **Gigabit Ethernet** — always used (Broadcom wifi and Bluetooth skipped, driver support on Linux is poor)

---

## The operating system

**Ubuntu Server 26.04 LTS** — free, popular, well-documented Linux system with no desktop (no windows, no mouse). You control it entirely by typing commands, either from the Mac Mini's keyboard OR remotely from another computer over the network (called "SSH").

The Mac Mini's original macOS gets completely erased. That is on purpose.

---

## What is Docker?

Docker runs applications in isolated boxes called "containers." Each service (Jellyfin, Nextcloud, etc.) lives in its own container so they can't mess up each other or your system. If you don't like a service, delete the container — nothing left behind.

**`docker-compose.yml`** is a recipe file that describes every container: which app, which port to open, which folder to save data to. One command (`docker compose up -d`) reads the recipe and starts everything.

---

## Services running on this homelab

Each service listens on a "port" (like a channel number on the server). You reach them either by IP + port (`http://<mac-mini-ip>:<port>`) or via a friendly hostname through Nginx Proxy Manager (`http://<service>.yourdomain.internal`) once DNS is set up.

> **`yourdomain` is a placeholder.** Pick any name you like and use it consistently in Pi-hole and NPM — `home.internal`, `lab.internal`, whatever. Nothing in `docker-compose.yml` depends on it; it only exists in the Pi-hole DNS records and the NPM proxy hosts you create by hand.

### Network
- **Pi-hole** — network-wide ad blocker + local DNS. Serves records for `*.yourdomain.internal`. Port `8080` for admin.
- **Nginx Proxy Manager (NPM)** — reverse proxy that turns `jellyfin.yourdomain.internal` into `http://jellyfin:8096` behind the scenes. Port `81` for admin.
- **Netbird** — free WireGuard-based mesh VPN. Reach your homelab from anywhere. Installed on the host, not in Docker.
- **gluetun** — WireGuard tunnel that qBittorrent runs inside, so torrent traffic leaves via ProtonVPN instead of your home connection. Everything else keeps the normal route.
- **ntfy** — self-hosted push notifications. Radarr/Sonarr ping it on import, Seerr on request events. Port `8095`.
- **jellylab-push** — bridges ntfy events into native notifications for the companion iOS app. Port `8099`. Built and working, but parked: Apple only grants the push entitlement to paid Developer Program accounts.

### Admin
- **Portainer** — web UI showing every container, click to start/stop/restart. Port `9000`.
- **Uptime Kuma** — checks each service every minute, alerts you if one dies. Port `3001`.
- **Watchtower** — quietly updates containers to their latest version every night at 4 AM. No web UI.

### Files
- **Nextcloud** — your own Google Drive / iCloud replacement. Files, calendar, contacts, sync between phone and laptop. Port `8081`.
- **MariaDB** + **Redis** — database and cache Nextcloud depends on. No UI, run in the background.

### Media (Jellyfin + *arr pipeline)
- **Jellyfin** — media server. Streams movies, TV, anime to any device. Port `8096`.
- **Radarr** — movie library manager. Tracks what you have + fetches missing releases. Port `7878`.
- **Sonarr** — same but for TV and anime. Port `8989`.
- **Bazarr** — auto-downloads subtitles + syncs them to the audio track. Port `6767`.
- **Prowlarr** — one place to configure indexers (torrent trackers, Usenet). Feeds Radarr + Sonarr. Port `9696`.
- **qBittorrent** — download client that Radarr/Sonarr hand jobs to. Port `8083`.
- **FlareSolverr** — proxy that solves Cloudflare challenges for indexers that require it. Port `8191`.
- **Jellyseerr** — request UI for friends/family. They log in with their Jellyfin account, search for a title, click Request → Radarr/Sonarr grabs it → shows up in Jellyfin. Port `5055`.

---

## Full stack table

| Category | Service | Port | What it does |
|----------|---------|------|--------------|
| Network | Pi-hole | 8080 | Ad blocker + local DNS |
| Network | Nginx Proxy Manager | 80 / 443 / 81 | Reverse proxy + HTTPS |
| Network | Netbird (on host) | — | Mesh VPN for remote access |
| Network | gluetun | 8083 / 6881 | VPN tunnel qBittorrent runs inside |
| Network | ntfy | 8095 | Self-hosted push notifications |
| Network | jellylab-push | 8099 | ntfy to iOS app push bridge |
| Admin | Portainer | 9000 / 9443 | Docker web UI |
| Admin | Uptime Kuma | 3001 | Service monitor |
| Admin | Watchtower | — | Auto-updater |
| Files | Nextcloud | 8081 | Cloud drive |
| Files | MariaDB | — | Nextcloud database |
| Files | Redis | — | Nextcloud cache |
| Media | Jellyfin | 8096 | Media streaming |
| Media | Radarr | 7878 | Movie manager |
| Media | Sonarr | 8989 | TV / anime manager |
| Media | Bazarr | 6767 | Subtitle auto-download |
| Media | Prowlarr | 9696 | Indexer aggregator |
| Media | qBittorrent | (via gluetun) | Torrent client, no network of its own |
| Media | FlareSolverr | 8191 | Cloudflare challenge solver |
| Media | Jellyseerr | 5055 | Request UI |

---

## How to set this up on your own machine

**Full step-by-step walkthrough is in [TODO.md](TODO.md).** Read it top to bottom, do each checkbox.

Quick summary if you already know what you're doing:

```bash
# 1. Install Ubuntu Server 26.04 on your machine
# 2. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in

# 3. Clone this repo
git clone https://github.com/furkanturkmen/homelab-macmini2012.git
cd homelab-macmini2012

# 4. Create your .env from the template — never commit real secrets
cp .env.example .env
nano .env    # set HOST_LAN_IP, timezone, passwords

# 5. Start everything
docker compose up -d
```

The `.env` file is **gitignored** — your real passwords never leave your machine. The compose file only references `${VAR}` placeholders that get filled in from `.env` at runtime.

---

## After it's running

Open a web browser on any device on your home network and visit:

| Service | URL (replace `<ip>` with your Mac Mini IP) |
|---------|---------|
| Pi-hole admin | `http://<ip>:8080/admin` |
| Portainer | `http://<ip>:9000` |
| Uptime Kuma | `http://<ip>:3001` |
| NPM admin | `http://<ip>:81` |
| Nextcloud | `http://<ip>:8081` |
| Jellyfin | `http://<ip>:8096` |
| Radarr | `http://<ip>:7878` |
| Sonarr | `http://<ip>:8989` |
| Bazarr | `http://<ip>:6767` |
| Prowlarr | `http://<ip>:9696` |
| qBittorrent | `http://<ip>:8083` |
| Jellyseerr | `http://<ip>:5055` |
| ntfy | `http://<ip>:8095` |
| jellylab-push (health) | `http://<ip>:8099/health` |

Find the Mac Mini's IP by SSH'ing in and running `ip -4 addr show`. Look for the number that starts with `192.168.` or `10.`.

Once NPM is set up you can also reach each service by hostname: `http://jellyfin.yourdomain.internal`, `http://nextcloud.yourdomain.internal`, etc.

---

## Things to know before you start

- **The Mac Mini becomes headless** — no monitor, no keyboard once set up. You control it from your laptop via SSH.
- **Broadcom wifi and Bluetooth don't work well on Linux** for this model. Use Ethernet only.
- **Hardware transcoding works, but H.264 only.** The HD 4000 does H.264 decode + encode in hardware via VA-API. Measured on this machine: **177 fps (7.4x realtime)** for a 1080p H.264 transcode, versus 62 fps (2.6x) on the CPU. HEVC/H.265, VP9 and AV1 have no hardware path and fall back to the CPU, which struggles above 1080p. HDR tone-mapping is not possible. Setup steps in [TODO.md](TODO.md).
- **16 GB RAM is the ceiling.** With everything idle it sits around 2 GB used — plenty of headroom for normal use.
- **HTTPS on `*.yourdomain.internal` is not possible** — `.internal` is a reserved private TLD, so no public CA can issue a certificate for it. Either stay on plain HTTP inside the LAN, or move your internal hostnames onto a subdomain of a domain you actually own (`jellyfin.home.example.com`) and let NPM issue certs through the Cloudflare **DNS-01** challenge. DNS-01 validates over DNS records instead of an HTTP request, so it works for names that only resolve on your LAN, with nothing exposed to the internet.
- **Runtime data is excluded** from this repo via `.gitignore`. Each service writes its own data locally on your machine (photos in Nextcloud, media library in Jellyfin, etc.). Only the recipe files are tracked here.

---

## Roadmap

Rough phases in [TODO.md](TODO.md):

0. Optional: swap the stock 5400 rpm HDD for an SSD — do this before installing anything
1. Install Ubuntu Server on Mac Mini
2. Set up SSH access and install Docker
3. Deploy the stack via docker-compose
4. Run first-run wizards for each service (Portainer, NPM, Nextcloud, Jellyfin, *arr, Jellyseerr), then enable VA-API hardware transcoding for Jellyfin
5. Point your router's DNS at Pi-hole for LAN-wide ad blocking
6. Install Netbird for remote access
7. Push notifications on import via ntfy (Radarr/Sonarr/Seerr) — see [TODO.md](TODO.md) Phase 6
8. Route qBittorrent through a VPN with a real kill switch — Phase 7
9. Score H.264 above HEVC/AV1 in Sonarr and Radarr, so the server stops transcoding what it cannot hardware-decode — Phase 8
10. Later: Cloudflare Tunnel for public sharing, Vaultwarden (password manager), offsite backups (Duplicati → Backblaze)

---

## License

Personal project. Use it, fork it, learn from it. No warranty.
