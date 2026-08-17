# homelab-macmini2012

Turning an old Mac Mini into a personal server for files, media, and network tools — a "homelab." This repo has all the configuration you need to build the same thing.

---

## What is a homelab?

A homelab is just a computer at home that runs services for you instead of paying big companies for them. Think:

- **Your own Google Drive** (Nextcloud) — files sync across devices, no monthly fee
- **Your own Netflix** (Jellyfin) — stream movies and shows you own, on any device
- **Network-wide ad blocker** (Pi-hole) — blocks ads on every device on your wifi
- **Remote access from anywhere** (Tailscale) — reach your server from your phone anywhere in the world

You get privacy, save money over time, and learn a ton.

---

## What is this project?

A single Mac Mini from 2012 running a stack of these services. Everything is defined in a file called `docker-compose.yml`. You install one thing (Docker), tell it "read this file," and it downloads and runs every service automatically.

Total setup time from a fresh computer: **about 2-3 hours**.

---

## The hardware

- **Mac Mini (Late 2012)** — that silver box Apple sold for a decade
- **Intel Core i7** — 2 cores, 4 threads (feels like 4 slow cores)
- **16 GB RAM** — the maximum this model supports, cannot upgrade
- **HDD** (mechanical hard drive) — slow, planned upgrade to SSD later
- **Ethernet cable required** — the built-in wifi doesn't play well with Linux

---

## The operating system

**Ubuntu Server 24.04 LTS** — free, popular, well-documented Linux system with no desktop (no windows, no mouse). You control it entirely by typing commands, either from the Mac Mini's keyboard OR remotely from another computer over the network (called "SSH").

The Mac Mini's original macOS gets completely erased. That is on purpose.

---

## What is Docker?

Docker runs applications in isolated boxes called "containers." Each service (Jellyfin, Nextcloud, etc.) lives in its own container so they can't mess up each other or your system. If you don't like a service, delete the container — nothing left behind.

**`docker-compose.yml`** is a recipe file that describes every container: which app, which port to open, which folder to save data to. One command (`docker compose up -d`) reads the recipe and starts everything.

---

## Services running on this homelab

Each service listens on a "port" (like a channel number on the server). You open a web browser and go to `http://<mac-mini-ip>:<port>` to use it.

### Files
- **Nextcloud** — your own Google Drive / iCloud replacement. Files, calendar, contacts, sync between phone and laptop. Port `8081`.
- **MariaDB** — the database Nextcloud uses to store info. Runs in the background.
- **Redis** — a fast in-memory cache that speeds up Nextcloud. Runs in the background.

### Media
- **Jellyfin** — your own Netflix. Point it at your movie/show folder and stream to any device. Port `8096`.

### Network
- **Pi-hole** — network-wide ad blocker. Runs a DNS server that refuses to answer requests for ad domains. Port `8080` for its admin page.
- **Nginx Proxy Manager (NPM)** — makes pretty URLs like `cloud.mydomain.com` instead of `192.168.1.10:8081`, and adds free HTTPS. Port `81` for its admin page.
- **Tailscale** — free VPN that lets you reach the Mac Mini from anywhere (phone at cafe, laptop at work). Installed directly on Ubuntu, not in Docker.

### Admin (tools to manage everything)
- **Portainer** — web page showing every container, click to start/stop/restart. Port `9000`.
- **Uptime Kuma** — checks each service every minute, alerts you if one dies. Port `3001`.
- **Watchtower** — quietly updates containers to their latest version every night at 4 AM. No web page.

---

## Full stack table

| Category | Service | Port | What it does |
|----------|---------|------|--------------|
| Files | Nextcloud | 8081 | Cloud drive |
| Files | MariaDB | — | Nextcloud database |
| Files | Redis | — | Nextcloud cache |
| Media | Jellyfin | 8096 | Media streaming |
| Network | Pi-hole | 8080 | Ad blocker + DNS |
| Network | Nginx Proxy Manager | 80 / 443 / 81 | Reverse proxy + HTTPS |
| Network | Tailscale (on host) | — | Remote access VPN |
| Admin | Portainer | 9000 / 9443 | Docker web UI |
| Admin | Uptime Kuma | 3001 | Service monitor |
| Admin | Watchtower | — | Auto-updater |

---

## How to set this up on your own machine

**Full step-by-step walkthrough is in [TODO.md](TODO.md).** Read it top to bottom, do each checkbox.

Quick summary if you already know what you're doing:

```bash
# 1. Install Ubuntu Server 24.04 on your machine
# 2. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in

# 3. Clone this repo
git clone https://github.com/furkanturkmen/homelab-macmini2012.git
cd homelab-macmini2012

# 4. Edit docker-compose.yml — change passwords, IP address, timezone
nano docker-compose.yml

# 5. Start everything
docker compose up -d
```

---

## After it's running

Open a web browser on any device on your home network and visit:

| Service | URL (replace `<ip>` with Mac Mini IP) |
|---------|---------|
| Pi-hole admin | `http://<ip>:8080/admin` |
| Portainer | `http://<ip>:9000` |
| Uptime Kuma | `http://<ip>:3001` |
| NPM admin | `http://<ip>:81` |
| Nextcloud | `http://<ip>:8081` |
| Jellyfin | `http://<ip>:8096` |

To find the Mac Mini's IP, SSH in and run `ip a`. Look for the number that starts with `192.168.` or `10.`.

---

## Things to know before you start

- **The Mac Mini becomes headless** — no monitor, no keyboard once set up. You control it from your laptop via SSH.
- **Broadcom wifi and Bluetooth don't work well on Linux** for this model. Use Ethernet only.
- **The Intel HD 4000 GPU is too weak** to convert video formats on-the-fly for Jellyfin. Play files in their original format only.
- **16 GB RAM is the ceiling.** Don't try to run every service at maximum load at once — pick a few main ones.
- **The HDD is slow.** SSD upgrade planned — big performance jump when it happens.
- **Runtime data is excluded** from this repo via `.gitignore`. Each service writes its own data locally on your machine (photos in Nextcloud, media library in Jellyfin, etc.). Only the recipe files are tracked here.

---

## Roadmap

Rough phases in [TODO.md](TODO.md):

1. Install Ubuntu Server on Mac Mini
2. Set up SSH access and install Docker
3. Deploy the stack via docker-compose
4. Set up Tailscale for remote access6. Upgrade HDD to SSD for a speed boost
7. Later: add photo hosting (Immich), password manager (Vaultwarden), smart home (Home Assistant)

---

## License

Personal project. Use it, fork it, learn from it. No warranty.
