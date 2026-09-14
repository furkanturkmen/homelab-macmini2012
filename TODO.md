# Homelab Setup — Step-by-Step

This guide takes you from "I have an old computer" to "I have a working homelab" in about 2-3 hours. No prior Linux experience assumed.

**What you need before starting:**

- The Mac Mini 2012 (or any old computer with 8GB+ RAM)
- A Windows PC (or Mac, or another Linux computer) — the "workstation" you'll use to prepare things
- A USB stick, 8 GB or larger (its contents will be erased)
- An Ethernet cable to plug the Mac Mini into your router
- A USB keyboard (wired, not Bluetooth — Bluetooth doesn't work in the installer)
- A monitor and HDMI cable (for the first install only)
- Your home wifi router's admin login (to reserve an IP address later)
- About 2-3 hours of free time

---

## Phase 0 — Check the drive first (optional, but do it now if at all)

Most Late 2012 Mac Minis shipped with a **5400 rpm 2.5" hard drive**. If yours still has one, swap it for an SSD *before* you install Ubuntu. Doing it afterwards means reinstalling everything from scratch.

An SSD is the single biggest speed difference you can make on this machine — far more than RAM or CPU. Container startup, Nextcloud, the *arr apps and the Jellyfin library scan are all limited by random reads that a spinning disk is bad at.

**Already have an SSD?** If the machine already runs Linux, check with:

```bash
lsblk -d -o NAME,MODEL,SIZE,ROTA
```

`ROTA=0` means solid state — skip this phase. `ROTA=1` means it is a spinning disk. On macOS: **About This Mac → System Report → Storage**, look at "Medium Type".

### What to buy

- **2.5" SATA SSD**, 500 GB or 1 TB. Crucial MX500 or Samsung 870 EVO are the safe picks.
- **T6 Torx screwdriver** — internal screws
- **T8 Torx screwdriver** — drive bracket
- **Plastic spudger or an old credit card** — to pop the case open

The Mac Mini's port is SATA III (6 Gb/s), so any modern 2.5" SATA SSD runs at full speed. There is no NVMe slot on this model — that arrived with the 2014 Mac Mini.

### Doing the swap

- Power the Mac Mini off and unplug it
- Follow the iFixit guide: search **"Mac Mini Late 2012 Hard Drive Replacement"**
- Budget 30–45 minutes if you are careful. The bottom cover twists off — no glue, no adhesive
- While the machine is open, this is also the moment to replace the CPU thermal paste if you ever plan to

Then continue with Phase 1 as normal.

---

## Phase 1 — Install Ubuntu on the Mac Mini

This wipes the Mac Mini completely and installs Ubuntu Linux.

### Step 1.1 — Download the Ubuntu installer

On your Windows PC:

- Go to https://ubuntu.com/download/server
- Click the green **"Download Ubuntu Server 26.04 LTS"** button
- You get a file ending in `.iso`. It's about 2.6 GB. Save it to your Downloads folder.

An `.iso` file is a complete copy of an installer disc. You'll write it to the USB stick next.

### Step 1.2 — Write the ISO to your USB stick

- Go to https://rufus.ie and download **Rufus** (a free tool for making bootable USB sticks)
- Plug your USB stick into your Windows PC
- Open Rufus
- **Device:** pick your USB stick from the dropdown (double-check — the wrong one erases the wrong drive!)
- **Boot selection:** click "SELECT" and choose the Ubuntu `.iso` you just downloaded
- **Partition scheme:** GPT
- **Target system:** UEFI
- Leave everything else at defaults
- Click **START**. If it asks about "ISO or DD mode," pick **ISO mode**. If it warns "all data will be destroyed," click OK.
- Wait 5-10 minutes for it to finish

Your USB stick is now a bootable Ubuntu installer.

### Step 1.3 — Boot the Mac Mini from the USB

- Plug the following into the Mac Mini:
  - HDMI cable → monitor
  - USB keyboard (wired)
  - Ethernet cable → your router
  - The USB stick you just made
  - Power cable
- Turn on the Mac Mini and **immediately hold the `Option` (⌥) key** on the keyboard
- Keep holding until you see a screen with boot options (Apple's boot picker)
- You should see the USB stick as a yellow "EFI Boot" icon. Use arrow keys to select it, press Enter.

If nothing happens or the Mac Mini boots into macOS anyway: unplug the USB, power off, try again with the Option key held from the exact moment you press power.

> ⚠️ **Ethernet must be plugged in before boot.** The Mac Mini 2012's Broadcom BCM4331 wifi chip has no in-installer driver — booting without Ethernet triggers a kernel panic as the installer tries to init the network. Do not skip the cable.

### Step 1.4 — Install Ubuntu

The Ubuntu installer starts. It's mostly menus. Press Enter to accept defaults unless noted:

- **Language:** English
- **Keyboard layout:** pick yours (US, UK, etc.)
- **Type of install:** Ubuntu Server (not "minimized")
- **Additional options / Search for third-party drivers:** ✅ **Yes** — this is a scan step, not a guaranteed install. On the Mac Mini 2012 the installer typically reports *"No applicable third-party drivers are available locally or online"* — that's expected and fine. The Broadcom BCM4331 wifi driver is *not* in this DB; it's a regular apt package (`bcmwl-kernel-source`) you can install later only if you want wifi. Since Ethernet is required anyway, most users never need it.
- **Network:** should auto-detect your Ethernet and show a DHCP-assigned IP (e.g. `192.168.1.42/24`). **Change nothing** — just select Done. Do not try to set a static IP here; static assignment is done at the router in §1.6 (cleaner and survives OS reinstalls). **Write down the IP and MAC address shown now** — you'll need both for the router reservation later.
- **Proxy:** leave blank
- **Mirror:** leave default
- **Storage:** pick "Use an entire disk" and select the Mac Mini's internal drive. Leave "Set up this disk as an LVM group" ✅ **checked**. Leave "Encrypt LVM with LUKS" ❌ **unchecked** (headless server = no monitor for boot password on every reboot). **THIS ERASES THE MAC MINI COMPLETELY.**
- **⚠️ Fix the LVM root size before continuing.** Ubuntu's default LVM layout only allocates ~100 GB to the root volume (`ubuntu-lv`) even if your disk is 500 GB — leaving ~370 GB stranded in the volume group. Docker + Nextcloud + Jellyfin will fill 100 GB fast. Fix now: in the FILE SYSTEM SUMMARY, arrow down to `ubuntu-lv` under USED DEVICES → Enter → **Edit** → clear the Size field or set it to the max shown (e.g. `473G`) → **Save**. Confirm the `/` mount now shows the full disk size. Then **Done**.
- **Confirm the destructive action:** yes, continue
- **Profile setup:**
  - Your name: your name
  - Server's name (hostname): `homelab` (this is what shows up on your network)
  - Username: pick a short lowercase name, no spaces (e.g. `furkan`)
  - Password: strong, but memorable — you'll type it a lot
- **Ubuntu Pro:** pick "Skip for now". Free for personal use (5 machines, 10-year security patches), but signup mid-install breaks flow. Attach later with `sudo pro attach <token>`.
- **SSH setup:** ✅ **Check "Install OpenSSH server"** — this is critical, you need it to log in remotely. Also click **Import SSH identity → from GitHub** and enter your GitHub username — your public keys get added to `~/.ssh/authorized_keys` so you can SSH in without a password. Leave "Allow password authentication over SSH" ✅ checked as fallback until you've confirmed key login works. (Public keys are public — literally at `github.com/<username>.keys` — nothing sensitive.)
- **Featured server snaps:** don't check anything. Skip. Especially do NOT check `nextcloud` — the snap would conflict with the docker-compose Nextcloud you'll run later.
- Wait for install to finish (10-20 minutes)
- When it says "Install complete!", pick **Reboot Now**
- When it says "Please remove the installation medium," pull out the USB stick and press Enter

Ubuntu boots for the first time. You see a login prompt like:

```
homelab login: _
```

Type your username, Enter, type your password (nothing shows as you type — normal), Enter. You're in.

### Step 1.5 — Find the Mac Mini's IP address

At the login prompt (after logging in), type:

```
ip a
```

Look for a section starting with `enp` or `eth` (the Ethernet connection). Find the line with `inet 192.168.x.x` or `inet 10.x.x.x`. That number is the Mac Mini's IP address on your network. **Write it down.** Example: `192.168.1.42`.

### Step 1.6 — Reserve the IP address in your router

If you don't do this, your Mac Mini's IP could change tomorrow and everything breaks.

- Open a browser on your phone/laptop
- Go to your router's admin page (usually `http://192.168.1.1` or `http://192.168.0.1` — check the sticker on the router)
- Log in (default password often on the sticker too)
- Find a section called "DHCP Reservation," "Static Leases," "Address Reservation," or similar
- Add a reservation for the Mac Mini's MAC address (also shown by `ip a` next to `link/ether`) → assign it its current IP forever

Now the Mac Mini always has the same IP.

---

## Phase 2 — Connect from your Windows PC (SSH)

You're done with the monitor and keyboard on the Mac Mini. Everything from here is done remotely.

### Step 2.1 — SSH into the Mac Mini

On your Windows PC, open **PowerShell** (press Windows key, type "powershell", Enter).

Type:

```
ssh yourusername@192.168.1.42
```

Replace `yourusername` with the username you picked and `192.168.1.42` with the actual IP.

First time only, it asks:

```
Are you sure you want to continue connecting (yes/no)?
```

Type `yes`, Enter. Then enter your password. You're now controlling the Mac Mini from your Windows PC. Any command you type happens on the Mac Mini.

### Step 2.2 — Unplug the Mac Mini's monitor and keyboard

You don't need them anymore. The Mac Mini can live in a closet with just power and Ethernet.

---

## Phase 3 — Install Docker

Docker is what runs all your services in their little boxes.

### Step 3.1 — Update Ubuntu

Still in the SSH session:

```
sudo apt update && sudo apt upgrade -y
```

`sudo` means "run as admin" — it asks for your password the first time. `apt` is Ubuntu's app store, run from the command line. This updates all installed system software. Takes a few minutes.

### Step 3.2 — Install Docker

```
curl -fsSL https://get.docker.com | sh
```

This downloads the official Docker install script and runs it. Takes a couple minutes.

### Step 3.3 — Let your user run Docker without `sudo`

```
sudo usermod -aG docker $USER
```

Then **log out and back in** (type `exit`, then SSH again) so this takes effect.

Test it works:

```
docker run hello-world
```

You should see a friendly message. If yes, Docker is installed correctly.

---

## Phase 4 — Deploy the homelab stack

### Step 4.1 — Get the recipe file onto the Mac Mini

Two ways. Pick one:

**Way A: clone this repo directly on the Mac Mini** (easier)

```
sudo apt install -y git
git clone https://github.com/furkanturkmen/homelab-macmini2012.git ~/homelab
cd ~/homelab
```

**Way B: copy from your Windows PC** (if you edited it locally)

In a new PowerShell window on Windows:

```
scp C:\Users\Furkan\homelab\docker-compose.yml yourusername@192.168.1.42:~/homelab/
```

You'll need to create `~/homelab` on the Mac Mini first (`mkdir ~/homelab`).

### Step 4.2 — Create your `.env` file

The compose file has zero real secrets in it — every password and per-host value is a `${VAR}` placeholder that gets filled in from a separate file called `.env`. That file is **gitignored** so your secrets never leave the Mac Mini.

Copy the template and edit it:

```
cp .env.example .env
nano .env
```

`nano` is a simple text editor. Arrow keys to move, Ctrl+O to save, Ctrl+X to exit.

**Set each variable:**

- `HOST_LAN_IP=192.168.1.42` → the Mac Mini's LAN IP from §1.5. Used by Pi-hole (port binding) and Nextcloud (trusted domain).
- `TZ=Europe/Amsterdam` → your timezone if different (see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
- `PUID=1000` and `PGID=1000` → run `id -u` and `id -g` on the Mac Mini to check yours (usually 1000 for the first user). The *arr containers use these to write files as your user.
- `PIHOLE_PASSWORD=` → strong password for Pi-hole admin. Note: **Pi-hole v6 renamed the env var** — the old `WEBPASSWORD` name is silently ignored and Pi-hole invents a random password shown only in `docker logs pihole`. If you copy old tutorials that still say `WEBPASSWORD`, you'll get locked out. The compose here uses the correct `FTLCONF_webserver_api_password`. Also — the env var only initializes the password on **first boot**; if you already ran the container once and want to change it, editing `.env` + `docker compose up -d pihole` won't help (password lives in `./pihole/etc/pihole/pihole-FTL.db` from first init). Reset from inside the container instead: `docker exec -it pihole pihole setpassword`.
- `MARIADB_ROOT_PASSWORD=` and `MARIADB_PASSWORD=` → strong passwords for the database. `MARIADB_PASSWORD` is referenced twice (in `nextcloud-db` and `nextcloud`) so they always match.

**A note on media folders and DNS listening mode (both stay in `docker-compose.yml`, no editing needed):**

- `FTLCONF_dns_listeningMode: "all"` on Pi-hole — required when Pi-hole runs in Docker with bridge networking. Without it Pi-hole rejects LAN queries with `dnsmasq: ignoring query from non-local network 192.168.x.x` because Docker's NAT makes clients look non-local.
- `/mnt/media:/media` mounted into Jellyfin + all *arr containers — leave as-is. The folder doesn't have to exist yet; Jellyfin will still start. When you're ready to add media, create typed subfolders on the host so Jellyfin can use the right metadata scraper per library:
  ```
  sudo mkdir -p /mnt/media/{movies,tv,music,anime}
  sudo chown -R $USER:$USER /mnt/media
  ```
  Then in Jellyfin's UI point separate libraries at `/media/movies` (TMDB scraper), `/media/tv` (TVDB), `/media/music` (MusicBrainz), and optionally `/media/anime` (set content type to Shows, then enable AniDB provider in library settings — better anime metadata than TVDB).

### Step 4.3 — Handle the DNS conflict

Ubuntu runs its own tiny DNS service (`systemd-resolved`) on port 53. Pi-hole needs port 53. If you skip this step, Pi-hole crashes on start with "address already in use." Turn Ubuntu's off:

```
sudo systemctl disable --now systemd-resolved
sudo systemctl disable --now systemd-resolved-varlink.socket systemd-resolved-monitor.socket
sudo rm -f /etc/resolv.conf
echo "nameserver 1.1.1.1" | sudo tee /etc/resolv.conf
```

Why the second command: Ubuntu 26.04's `systemd-resolved` is socket-activated — two extra sockets will silently restart it the moment anything asks for DNS, undoing your work. You must disable those sockets too, or resolved rises from the dead.

Verify port 53 is actually free and DNS still works from Ubuntu itself:

```
sudo ss -tulnp | grep ':53 '
ping -c 2 google.com
```

Expected: `ss` prints **nothing** (port free). `ping` still gets replies (routed via Cloudflare `1.1.1.1` now). Only then move on.

### Step 4.4 — Start everything

```
cd ~/homelab
docker compose up -d
```

`-d` means "run in the background." Docker downloads all the container images (several GB, takes 5-15 min the first time). When done, everything is running.

Check what's running:

```
docker compose ps
```

Every service should say "Up" or "running." Note: "Up" only means the container is running — not that the app inside has finished booting. Two slow starters to expect:

- **Nextcloud** — first boot runs DB migrations + generates config; the web UI isn't reachable for 2-5 minutes after "Up." Don't refresh mid-install.

### Step 4.5 — First-run setup for each service

Order matters here — do them in this sequence, not the order they appear in the compose file. Reasons noted per service. Substitute your actual Mac Mini IP for `192.168.1.42` below (or, if you added a Windows hosts-file entry, use `homelab`).

**1. Portainer — `http://homelab:9000` (do first — has a 5-minute setup timeout)**

Create admin username + password immediately. If you wait more than ~5 minutes after the container started, Portainer locks the setup for security. Recovery: `docker compose restart portainer`, grab the setup token from `docker logs portainer 2>&1 | grep setup_token`, paste it into the UI, then create the admin.

**2. Nginx Proxy Manager — `http://homelab:81` (do second — default creds are a security hole)**

Default login: `admin@example.com` / `changeme`. NPM forces a change on first login — set a real email (for Let's Encrypt certs later) and a strong password. The default account is updated in place, no cleanup needed.

**3. Nextcloud — `http://homelab:8081` (first load takes 30-60s, install takes 2-5min more)**

Create admin account. Nextcloud then runs DB migrations + generates config — **don't close the tab or refresh mid-install**, interruption corrupts state. When it lands on "Recommended apps", pick **Skip** (add Calendar/Contacts/Mail/etc. individually later; skip Nextcloud Office/Collabora entirely — it eats 400+ MB idle).

If Nextcloud rejects some later request with HTTP 400 (`Access through untrusted domain`), it's the trusted-domains check. Env only seeds on first boot; add missing entries via CLI:
```
docker exec -u www-data nextcloud php occ config:system:set trusted_domains 1 --value=192.168.1.42:8081
docker exec -u www-data nextcloud php occ config:system:set trusted_domains 2 --value=homelab
docker exec -u www-data nextcloud php occ config:system:set trusted_domains 3 --value=homelab:8081
```
Include a `IP:PORT` variant — Uptime Kuma and other tools send `Host: 192.168.1.42:8081`, which doesn't match a bare `192.168.1.42` entry.

**4. Pi-hole — `http://homelab:8080/admin`**

Password = the `FTLCONF_webserver_api_password` you set in compose. If the compose env doesn't work (locked out with a random-looking password), see the Pi-hole notes in §4.2 — v6 changed the env var and password only inits on first boot, so a rename after first boot won't take. Reset with `docker exec -it pihole pihole setpassword`.

**5. Uptime Kuma — `http://homelab:3001` (do after 1-4 so URLs + passwords are final)**

Create admin. Then add HTTP monitors — use the **LAN IP** (`http://192.168.1.42:PORT`), not the `homelab` hostname. Uptime Kuma runs inside a container with no hosts-file entry; `homelab` won't resolve inside it. LAN IP also tests real reachability the way a browser does, not just container-to-container health.

Suggested monitors:
| Name | URL |
|------|-----|
| Pi-hole | `http://192.168.1.42:8080/admin` |
| Portainer | `http://192.168.1.42:9000` |
| Nextcloud | `http://192.168.1.42:8081` |
| Jellyfin | `http://192.168.1.42:8096` |
| NPM | `http://192.168.1.42:81` |

Skip Watchtower — no UI.

Two more that the HTTP list misses. Pi-hole's web page can load while its DNS
engine is dead, which is exactly what the household notices, so also add a
**DNS** monitor (Add New Monitor → Monitor Type: DNS):

| Name | Hostname | Resolver Server | Port |
|------|----------|-----------------|------|
| Pi-hole · DNS | `example.com` | `192.168.1.42` | `53` |
| Pi-hole · encrypted upstream | `example.com` | `192.168.1.42` | `5053` (only after Phase 11) |

Uptime Kuma does not alert anyone until a notification is set up. Once ntfy
runs (Phase 6), connect it; see *Uptime Kuma alerts* in Phase 6.

**6. Jellyfin — `http://homelab:8096`**

Wizard: language → admin account → **Add Media Library** for each type you want. Create the host folders first if you haven't:
```
sudo mkdir -p /mnt/media/{movies,tv,music,anime}
sudo chown -R $USER:$USER /mnt/media
```

Add libraries inside Jellyfin pointing at `/media/movies` (content type Movies, TMDB scraper), `/media/tv` (Shows, TMDB), `/media/music` (Music, MusicBrainz + TheAudioDB), and `/media/anime` (Shows, Japan country). Then install anime plugins after the wizard: **Dashboard → Plugins → Catalog → Metadata → AniDB + AniList → Restart Jellyfin → edit Anime library → enable AniDB (top), AniList, TMDB fallback**.

Hardware acceleration **does** work on this machine, but only for H.264 — see the VA-API setup step further down. The HD 4000 has no HEVC, VP9 or AV1 decoder, so those still transcode on the CPU. Direct-play clients (Jellyfin Media Player, Infuse, Kodi, Swiftfin) avoid transcoding entirely and remain the lightest option; the browser player almost always triggers a transcode.

**7. Prowlarr — `http://homelab:9696` (do BEFORE Radarr/Sonarr — feeds them)**

Prowlarr is the one place you configure indexers (torrent trackers, Usenet). It then syncs them to Radarr + Sonarr automatically, so you don't add the same indexer 3 times.

Set an admin password (Settings → General → Authentication = Forms, save, then Basic auth prompts). Add a couple of indexers (Indexers → Add → search e.g. `1337x`, `rarbg-mirror`, `nyaa` for anime). If an indexer is behind Cloudflare, tick **FlareSolverr** and set the URL to `http://flaresolverr:8191`. We'll wire Radarr + Sonarr into Prowlarr in their steps.

**8. qBittorrent — `http://homelab:8083`**

Default login: `admin` / `adminadmin`. **Change it immediately** (Tools → Options → Web UI). Then set:

- Downloads → Default Save Path: `/media/downloads` (create it in advance: `mkdir -p /mnt/media/downloads`)
- Connection → Listening port: `6881` (already mapped in compose)
- BitTorrent → Enable DHT + PeX + LSD

**9. Radarr — `http://homelab:7878` (movies)**

- Settings → General → Authentication = Forms, set admin password
- Settings → Media Management → Movie Naming: **Rename Movies ON**. Movie Folder Format: `{Movie CleanTitle} ({Release Year})` — plain parens, **no curly braces around the parens** (subtle default pitfall that produces folder names like `Movie ({2024})`)
- Settings → Media Management → Add Root Folder → `/media/movies`
- Settings → Download Clients → Add → qBittorrent → Host: `qbittorrent`, Port: `8083`, credentials from above, Category: `radarr`
- Settings → Indexers → **Sync from Prowlarr instead**: go to Prowlarr → Settings → Apps → Add → Radarr → Prowlarr Server: `http://prowlarr:9696`, Radarr Server: `http://radarr:7878`, API key from Radarr → Settings → General → API Key. Save. Prowlarr pushes indexers to Radarr automatically.

**10. Sonarr — `http://homelab:8989` (TV + anime)**

Same pattern as Radarr:

- Auth: Forms + password
- Media Management → Rename Episodes ON, Episode Naming defaults are fine
- Add Root Folder `/media/tv` AND `/media/anime` (two separate roots)
- Download Client: qBittorrent (Category: `sonarr`)
- Wire into Prowlarr: Prowlarr → Settings → Apps → Add → Sonarr → API key from Sonarr → Settings → General → API Key

For anime: create a separate Quality Profile named "Anime" that prefers 1080p x264/x265; when adding an anime series, pick that profile + root folder `/media/anime`. Sonarr handles episode-per-file OR absolute-numbered (`SxxEyy` vs `Exxxx`) both.

**11. Bazarr — `http://homelab:6767` (subtitles)**

Settings → General → Authentication = Forms, set password. Then wire Bazarr to your library and providers:

- Settings → Sonarr → Address `sonarr`, Port `8989`, API key from Sonarr → Test → Save
- Settings → Radarr → Address `radarr`, Port `7878`, API key from Radarr → Test → Save
- Settings → Providers → add OpenSubtitles.com (free account) + Subscene fallback; set your preferred languages under Settings → Languages
- Settings → Subtitles → enable **Use audio track as reference for sync** (uses ffsubsync to auto-time subs to the file's audio — huge quality win)

Bazarr now scans every movie/episode Radarr + Sonarr know about, fetches missing subs, and syncs them.

**12. Jellyseerr — `http://homelab:5055` (request UI)**

Wizard walks you through:

- **Media server**: pick **Jellyfin**
- **Jellyfin config**: URL `http://jellyfin:8096`, email + password of your Jellyfin admin account. Click **Sync Libraries** and tick the libraries you want requestable.
- **Radarr**: Hostname `radarr`, Port `7878`, API key from Radarr, Quality Profile `HD-1080p`, Root Folder `/media/movies`, Minimum Availability `Released`.
- **Sonarr**: Hostname `sonarr`, Port `8989`, API key from Sonarr, Quality Profile + Root Folders for both `/media/tv` and (optionally) a separate anime root at `/media/anime`.

Jellyseerr auto-syncs your Jellyfin user list — friends log in with the same Jellyfin credentials. Settings → Users → default permissions controls who can request without approval.

**13. Homarr — `http://homelab:7575` (dashboard; do last, it reads every other service)**

Homarr needs `HOMARR_SECRET_KEY` in `.env`: exactly 64 hex characters, from
`openssl rand -hex 32`. It encrypts every API key you give
Homarr, so **losing it makes all saved integrations unreadable**. Keep it with
your other secrets.

Onboarding:

- **Analytics: turn it off.** Left on, Homarr reports usage to PostHog. The
  crawling/indexing toggles don't matter for a LAN-only dashboard.
- **Base URL: choose *Host:Port* and enter the LAN IP** (`192.168.1.42`).
  Homarr then pre-fills each integration with the right port and talks to the
  service directly, not through NPM and DNS.

Integrations that exist for this stack, and the traps in each:

| Integration | URL | Credential | Trap |
|-------------|-----|------------|------|
| Sonarr / Radarr / Prowlarr | `:8989` / `:7878` / `:9696` | API key (Settings → General) | — |
| Bazarr | `:6767` | API key (Settings → General) | — |
| Jellyfin | `:8096` | a new API key named `Homarr` (Dashboard → API Keys) | reuse none, so it can be revoked alone |
| Seerr | `:5055` | Seerr API key | the image is `seerr-team/seerr`: use the **Seerr** tile, the Jellyseerr tile only if that fails |
| qBittorrent | **`:8083`** | WebUI login | the wizard guesses `:8080`, which is Pi-hole: `404 … /api/v2/auth/login`. qBittorrent lives inside gluetun |
| Nextcloud | **`http://…:8081`** | an **app password**, not your login | the wizard guesses `:443`; nothing here speaks TLS |
| Pi-hole | `:8080` | the web password, or a v6 app password (Settings → Web interface / API) | the wizard may try `:80` |
| ntfy | `:8095` | — | — |
| Uptime Kuma | `:3001` | status page **slug only** (e.g. `homelab`), plus an API key | pasting the whole status-page URL into the slug field fails |

Services with no integration (Portainer, NPM) get a plain **app tile**. Tick
*Use different URL for ping* and ping the container name
(`http://portainer:9000`, `http://npm:81`): Homarr shares the Docker network,
so the check never leaves the host.

*Tools → Docker* stays empty on purpose. It needs `/var/run/docker.sock`, and
socket access is root on the host for anything that can reach Homarr's login.
Portainer already covers that view.

`./homarr` is gitignored. Its database holds the login's password hash and
sessions, and it was once pushed to the public repo before that entry existed.
Forgot the Homarr password? `docker exec homarr homarr reset-password -u <user>`
prints a new one.

### Step 4.6 — Point your router's DNS at Pi-hole

- Router admin page → DNS settings
- Set the primary DNS to the Mac Mini's IP (`192.168.1.42`)
- **Leave the secondary empty**, or set it to Pi-hole as well. A public
  secondary such as `1.1.1.1` lets devices skip Pi-hole (ads come back at
  random), and after Phase 11 it would also send lookups past the encryption
- Save, reboot the router

Now every device on your wifi uses Pi-hole automatically. Ads gone.

---

### Step 4.7 — Enable hardware transcoding (VA-API)

The HD 4000 has a working H.264 encoder and decoder (Intel Quick Sync). Jellyfin can use it, which cuts transcode CPU load dramatically. Measured on this exact machine, transcoding a 1080p H.264 High file down to 1080p @ 4 Mbps:

| Path | Speed |
|------|-------|
| Hardware (VAAPI) | **177 fps — 7.4x realtime** |
| Software (libx264 `veryfast`) | 62 fps — 2.6x realtime |

Roughly 2.8x faster, and it leaves the CPU free for Nextcloud, the *arr apps and downloads.

**What it can and cannot do.** The Ivy Bridge GPU supports H.264, MPEG-2 and VC-1 in hardware. It has **no** HEVC/H.265, VP9 or AV1 decoder — those fall back to the CPU and are slow above 1080p. HDR tone-mapping is not supported at all. If most of your library is x265, hardware acceleration will not help you much.

**You do not need to install anything on Ubuntu.** The `jellyfin/jellyfin` image ships its own VA-API drivers (`i965_drv_video.so`) inside `/usr/lib/jellyfin-ffmpeg/lib/dri/`. No `apt install` on the host is required. The container just needs access to the GPU device.

#### 1. Find your `render` group ID

```bash
getent group render video
```

Output looks like `render:x:991:` and `video:x:44:`. Note both numbers — the render GID differs between machines.

#### 2. Give the Jellyfin container the GPU

In `docker-compose.yml`, add `devices:` and `group_add:` to the `jellyfin` service:

```yaml
  jellyfin:
    container_name: jellyfin
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports:
      - "8096:8096"
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "44"    # video group
      - "991"   # render group — use YOUR number from step 1
    volumes:
      - ./jellyfin/config:/config
      - ./jellyfin/cache:/cache
      - /mnt/media:/media
    environment:
      TZ: "${TZ}"
```

Apply it:

```bash
docker compose up -d jellyfin
```

#### 3. Verify the GPU is visible inside the container

```bash
docker exec jellyfin /usr/lib/jellyfin-ffmpeg/vainfo
```

You should see it try the newer `iHD` driver, **fail**, then fall back to `i965` and succeed — that is normal and correct on Ivy Bridge:

```
libva error: .../iHD_drv_video.so init failed
libva info: Trying to open .../i965_drv_video.so
vainfo: Driver version: Intel i965 driver for Intel(R) Ivybridge Mobile - 2.4.0.pre1
      VAProfileH264High               : VAEntrypointVLD
      VAProfileH264High               : VAEntrypointEncSlice
```

`VAEntrypointVLD` on an H.264 profile means hardware **decode** works. `VAEntrypointEncSlice` means hardware **encode** works. If you instead get `vaInitialize failed`, the container cannot reach the device — recheck the render GID from step 1.

#### 4. Turn it on in Jellyfin

**Dashboard → Playback → Transcoding**:

- **Hardware acceleration:** `Video Acceleration API (VAAPI)`
- **VA-API Device:** `/dev/dri/renderD128`
- **Enable hardware decoding for:** tick **H264**, **MPEG2**, **VC1** only. Leave HEVC, VP9, AV1, HEVC 10bit and VP9 10bit **unticked** — the hardware cannot do them, and ticking them causes playback to fail rather than fall back cleanly.
- **Allow encoding in HEVC format:** **off**
- **Enable Tone mapping / VPP Tone mapping:** **off** (needs hardware this GPU does not have)
- **Enable hardware encoding:** **on**

Save, then play something that forces a transcode (lower the quality in the web player) and confirm it works.

#### 5. Confirm it is actually using the GPU

While a transcode is running:

```bash
sudo apt install intel-gpu-tools
sudo intel_gpu_top
```

The **Video** engine row should show activity. If it sits at 0% while the CPU is pinned, Jellyfin is still transcoding in software — check the Jellyfin playback log for the ffmpeg command line and look for `h264_vaapi`.

---

## Phase 5 — Remote access with Netbird

Netbird is a free WireGuard-based mesh VPN. Lets you reach the Mac Mini from your phone at a cafe, laptop at work, etc. — without opening ports on your router.

> **Why Netbird instead of Tailscale?** Both work. Tailscale was tried first here and dropped because of an iOS 26 bug where split-DNS wasn't applied on cellular. Netbird's split-DNS worked immediately on all platforms. Both are excellent — pick either, this guide covers Netbird.

### Step 5.1 — Install Netbird on the Mac Mini

```
curl -fsSL https://pkgs.netbird.io/install.sh | sh
sudo netbird up
```

It prints a URL. Open it in a browser, sign in (free personal account with Google/GitHub/Microsoft). The Mac Mini joins your Netbird "network" as a peer.

### Step 5.2 — Install Netbird on your other devices

- Phone: install the Netbird app from App Store / Play Store, sign in with the same account
- Laptop: download from https://netbird.io/download

Now all your devices see each other. Reach the Mac Mini using its Netbird IP (visible in the app) — e.g. `http://100.71.232.136:8096` for Jellyfin.

### Step 5.3 — Add a Network Route so peers can reach LAN IPs

By default Netbird only lets peers reach each other by their Netbird IPs. To reach `192.168.1.42:8096` (or any other LAN device) from your phone off-LAN:

- Netbird admin panel (https://app.netbird.io) → **Networks** → **Add Network** → Name: `homelab-lan`
- **Add Resource** → **Subnet** → CIDR: `192.168.1.0/22` (or whatever covers your LAN — check `ip -4 addr show` on the Mac Mini)
- Assign the routing peer: **homelab** (the Mac Mini), toggle **Masquerade** ON
- Save

Now phones on 4G can reach `192.168.1.42:PORT` as if they were on your wifi.

### Step 5.4 — Add split-DNS for `*.yourdomain.internal`

If you set up Pi-hole with local hostnames like `jellyfin.yourdomain.internal`:

- Netbird admin → **DNS** → **Add Nameserver Group**
- Name: `pihole`, Nameserver: your Mac Mini's Netbird IP + port 53, Match Domains: `yourdomain.internal`, `yourdomain.lan`
- Assign to all peers

Now off-LAN devices resolve `*.yourdomain.internal` via Pi-hole through the tunnel.

> **Known cellular limitation (Vodafone NL CGNAT).** iPhones on Vodafone cellular stay on a Netbird relay (not direct P2P) because the carrier's CGNAT blocks direct WireGuard even with UPnP + explicit port-forward. Home wifi is direct + full speed. Cellular streaming is capped by shared relay bandwidth. Workaround: in the Jellyfin iOS app, Quality → Max Cellular Bitrate = 3 Mbps. Real fix: Cloudflare Tunnel with a real domain, so streaming goes over Cloudflare's edge instead of the Netbird relay.

---

## Phase 6 — Push notifications when a download finishes

Get a push on your phone the moment Radarr or Sonarr imports something, plus
Seerr request events. Runs entirely on your own server; nothing is exposed to
the internet.

### Why ntfy and not the *arr apps' own notifiers

Radarr and Sonarr can post to Discord, Telegram and friends directly, but all
of those mean handing a third party your library activity. ntfy is a tiny
self-hosted push server with an iOS and Android app, and Seerr speaks it
natively.

### The one iOS catch

An iPhone cannot hold a background connection, so a self-hosted ntfy cannot
reach it on its own. The server config sets:

```
NTFY_UPSTREAM_BASE_URL: "https://ntfy.sh"
```

That forwards a **wake-up ping** through ntfy.sh so APNS can reach the phone.
Only a hash of the topic leaves your network — the message body is still
fetched from your own server. Without this, notifications only arrive while
the app is open.

Android does not need it.

### Step 6.1 — Start ntfy

Already in `docker-compose.yml`. Add three values to your `.env`:

```bash
# the topic name doubles as a shared secret - generate, do not pick
head -c 12 /dev/urandom | base64 | tr -dc 'a-z0-9' | head -c 16
head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20
```

```
NTFY_TOPIC=<first command's output, prefixed however you like>
NTFY_USER=homelab
NTFY_PASSWORD=<second command's output>
```

```bash
cd ~/homelab && docker compose up -d ntfy
```

### Step 6.2 — Lock the topic down

```bash
set -a; . ./.env; set +a
docker exec -e NTFY_PASSWORD="$NTFY_PASSWORD" ntfy ntfy user add --role=user "$NTFY_USER"
docker exec ntfy ntfy access "$NTFY_USER" "$NTFY_TOPIC" rw
docker exec ntfy ntfy access '*' "$NTFY_TOPIC" write-only
```

The last line is deliberate. Radarr, Sonarr and Seerr publish **without**
credentials, which keeps their configs free of secrets, but reading requires a
login — so nobody who stumbles on the topic can see your activity. The topic
name is the write secret, which is why it must be random.

Verify:

```bash
curl -s -o /dev/null -w "publish %{http_code}\n" -d test "http://localhost:8095/$NTFY_TOPIC"   # 200
curl -s -o /dev/null -w "read    %{http_code}\n" "http://localhost:8095/$NTFY_TOPIC/json?poll=1" # 403
```

### Step 6.3 — Radarr and Sonarr

Both run a small script on import. It lives in the app's own config directory,
which is gitignored, and reaches ntfy over the compose network rather than the
LAN — see `radarr/config/ntfy.sh` and `sonarr/config/ntfy.sh` on the server.

Wire it up in each app: **Settings → Connect → + → Custom Script**

- **Path:** `/config/ntfy.sh`
- Tick **On Import** and **On Upgrade**, leave the rest off
- **Test**, then Save

Custom Script rather than the Webhook connection on purpose: webhook posts raw
JSON, which arrives as a wall of braces. The script formats a readable line
using the `radarr_*` / `sonarr_*` environment variables the app sets.

### Step 6.4 — Seerr

**Settings → Notifications → ntfy**

- **Server URL:** `http://ntfy` (container name; no port needed)
- **Topic:** your `NTFY_TOPIC`
- Leave username and password empty — anonymous publish is allowed

Enable **Request Approved**, **Request Declined** and **Request Failed** only.

Deliberately leave **Media Available** off: Radarr and Sonarr already fire on
import, so enabling it here double-notifies every single download.

While you are in Seerr, check **Settings → General → Application URL** is set.
Empty means every notification it sends has a dead link in it.

### Uptime Kuma alerts (same topic)

Uptime Kuma shows red and green on its own page but alerts nobody until a
notification exists. Settings → Notifications → **Setup Notification**:

- **Notification Type:** ntfy
- **Server URL:** `http://ntfy`. Kuma is on the same Docker network, so the
  container name works and nothing leaves the host
- **Topic:** your `NTFY_TOPIC`
- **Priority:** 4. Kuma raises *down* alerts one step on its own
- **Authentication:** none. The topic is write-only for anonymous clients
  (Step 6.2), so no ntfy password ends up in Kuma's database
- Tick **Default enabled** and **Apply on all existing monitors**, then **Test**

### Step 6.5 — The phone

> **Native notifications inside your own iOS app need a paid Apple Developer
> account.** Apple gates the `aps-environment` entitlement behind Developer
> Program membership, and every background push to an iOS app goes through
> APNS. A free personal team cannot build with it, which is why the ntfy app
> exists: they paid for the entitlement so you do not have to. `jellylab-push`
> is built and working server-side either way, ready for the day you join.

1. Install **ntfy** from the App Store or Play Store
2. Settings → **Manage users** → add your server URL, `NTFY_USER`, `NTFY_PASSWORD`
3. **Subscribe to topic** → tick *Use another server* → enter the server URL and topic

Off-LAN this needs Netbird up, since the server is only reachable inside your
network. The wake-up still arrives via ntfy.sh, but fetching the message body
needs a route to the mini.

### What you end up with

| Event | Source | Example |
|-------|--------|---------|
| Movie imported | Radarr | `Movie added — Dune Part Two (2024), Bluray-1080p` |
| Episode imported | Sonarr | `Episode added — Frieren S01E12, WEBDL-1080p` |
| Quality upgrade | either | same, reading `upgraded` |
| Request approved / declined / failed | Seerr | request title |

---

### Step 6.6 — Native notifications in your own app (optional, needs a paid Apple account)

`jellylab-push` subscribes to the ntfy topic and forwards each event to Expo
Push, so notifications land in the jellylab app itself instead of the ntfy app.
It is running and tested end to end. It is also **parked**, for a reason worth
recording:

> Apple only issues the `aps-environment` entitlement to a **paid Developer
> Program** membership. Every background push to an iOS app goes through APNS,
> APNS requires that entitlement, and a free personal team cannot have it.
> `xcodebuild` refuses outright:
>
> ```
> Personal development teams do not support the Push Notifications capability
> Entitlements file defines "aps-environment" which is not registered
> ```
>
> This is exactly why the ntfy app exists: they hold the entitlement so you do
> not have to buy one. Nothing in this repo can work around it.

Because the app must still build on a free team, `jellylab` carries a local
config plugin (`plugins/withoutPushEntitlement.js`) that removes the
entitlement after `expo-notifications` adds it. Dropping the package from
`app.json` plugins is not enough — it applies its own plugin whenever
installed — and uninstalling it breaks the Metro bundle, since the `require`
is resolved statically.

**To turn it on later:** join the Developer Program, delete that plugin from
`app.json`, run `npx expo prebuild --clean`, rebuild. Then in the app:
Profile → Notifications → the `jellylab-push` address and
`PUSH_REGISTER_SECRET` → Test connection → toggle on. No code changes.

#### How the bridge works

```
Radarr ─┐
Sonarr ─┼─▶ ntfy ─▶ jellylab-push ─▶ Expo Push ─▶ APNS ─▶ app
Seerr  ─┘
```

It subscribes to ntfy rather than taking webhooks directly, so the Radarr,
Sonarr and Seerr connections from Steps 6.3 and 6.4 stay untouched, and any
source added later reaches the app just by publishing to the same topic. ntfy
also keeps a browsable history that push notifications do not.

No npm dependencies: Node's global `fetch` covers both the ntfy stream and the
Expo API, so it runs on a stock `node:22-alpine` with `jellylab-push/index.mjs`
mounted in. Nothing to build, nothing to keep patched.

Health check, which needs no auth:

```bash
curl http://<ip>:8099/health     # {"ok":true,"devices":0}
```

`devices` is how many phones have registered. It stays 0 until the entitlement
exists.

---

## Phase 7 — Route qBittorrent through a VPN

Without this, qBittorrent announces your home IP to every tracker and peer you
connect to. This puts torrent traffic — and only torrent traffic — inside a
WireGuard tunnel. Jellyfin, Nextcloud, the *arr apps and Netbird keep using the
normal connection.

### Why a container and not a system VPN

`gluetun` holds the tunnel, and qBittorrent joins its network namespace rather
than having one of its own:

```yaml
qbittorrent:
  network_mode: "service:gluetun"
```

That gives a real kill switch. gluetun sets the firewall's OUTPUT policy to
DROP and permits only `tun0`, the VPN endpoint itself, and the private ranges
needed for WebUI replies:

```
-P OUTPUT DROP
-A OUTPUT -o tun0 -j ACCEPT
-A OUTPUT -d <endpoint> -p udp --dport 51820 -j ACCEPT
```

If the tunnel drops, qBittorrent has no interface left to leak through. That is
stronger than binding qBittorrent to an interface and hoping, which fails open.

### Step 7.1 — Pick a provider

Port forwarding is the thing that matters. Without it you cannot accept
incoming connections, and your ratio suffers.

| Provider | Port forwarding | Note |
|----------|-----------------|------|
| ProtonVPN | yes, on paid | rotates on reconnect |
| AirVPN | yes | static, set once |
| Mullvad | no | otherwise excellent |
| PIA | yes | owned by Kape, formerly an adware company |

This setup uses ProtonVPN (Plus or Unlimited — port forwarding is not on Free).

### Step 7.2 — Generate the WireGuard config

Proton account → Downloads → WireGuard configuration:

- **Name: something unique** — see the warning below
- **Platform:** Router
- **NAT-PMP (Port Forwarding): ON** — easy to miss, and forwarding silently
  does nothing without it
- **Server:** a **P2P**-marked server (the `P` badge) in a country you want

> ⚠️ **Creating a config that reuses an existing name replaces that certificate.**
> Generating a second config called `conf-home` silently invalidates the first.
> WireGuard rejects a bad peer **without any error** — the tunnel connects, the
> interface comes up, and no traffic passes. This is indistinguishable from a
> misconfiguration and is worth ruling out first if nothing flows.

Open the downloaded `.conf`. You need four values:

```
PrivateKey = ...          -> WIREGUARD_PRIVATE_KEY
Address    = 10.2.0.2/32  -> WIREGUARD_ADDRESSES
PublicKey  = ...          -> WIREGUARD_PUBLIC_KEY   (from [Peer])
Endpoint   = 1.2.3.4:51820 -> VPN_ENDPOINT_IP / VPN_ENDPOINT_PORT
```

Put them in `.env`, which is gitignored:

```
WIREGUARD_PRIVATE_KEY=...
WIREGUARD_ADDRESSES=10.2.0.2/32
WIREGUARD_PUBLIC_KEY=...
VPN_ENDPOINT_IP=...
VPN_ENDPOINT_PORT=51820
```

### Step 7.3 — Three settings that are not obvious

All three are already in `docker-compose.yml`. They are recorded here because
each one presents as a completely different problem.

**`VPN_SERVICE_PROVIDER: "custom"`, not `"protonvpn"`.** With the provider
preset, gluetun supplies the peer public key and endpoint from its own bundled
server list. When that disagrees with your certificate the handshake is
rejected silently, and you get a tunnel that connects and carries nothing.
Taking all four values from the `.conf` removes the guesswork.

**`DOT: "off"` with `DNS_ADDRESS: "10.2.0.1"`.** gluetun defaults to
DNS-over-TLS via Cloudflare. Proton only permits DNS to their own resolver
inside the tunnel and resets anything else, so every lookup fails and the
healthcheck restart-loops over a link that is actually fine. `10.2.0.1` is the
`DNS =` line from Proton's config.

**`VPN_PORT_FORWARDING_UP_COMMAND`.** Proton hands out a new forwarded port on
every reconnect. Without pushing it into qBittorrent, it keeps announcing a
port that no longer forwards and quietly stops accepting incoming peers —
downloads still work, seeding dies. `gluetun/update-qbit-port.sh` sets it over
qBittorrent's API on each change.

That script reaches qBittorrent on `127.0.0.1` because they share a namespace,
which is also why it needs no credentials: qBittorrent is configured to skip
auth for localhost, and inside a shared namespace nothing else can be
localhost.

> qBittorrent rewrites `qBittorrent.conf` when it shuts down, so edit that file
> only while the container is **stopped**. Changes made while it is running are
> silently discarded on the next restart.

### Step 7.4 — Repoint Radarr and Sonarr

qBittorrent no longer has a network of its own, so `qbittorrent:8083` stops
resolving. In both apps: **Settings → Download Clients → qBittorrent → Host**
becomes `gluetun`. Test, then Save.

### Step 7.5 — Verify, do not assume

A tunnel that starts is not a tunnel that works. Check the exit IP from
**inside** the container:

```bash
docker exec qbittorrent sh -c 'wget -qO- https://ifconfig.me/ip'   # VPN address
curl -s https://ifconfig.me/ip                                      # your own, for contrast
```

Two different answers means it is working. The same answer twice means
qBittorrent is not in the namespace.

Then confirm the kill switch really exists:

```bash
docker exec gluetun iptables -S OUTPUT | head -3
```

`-P OUTPUT DROP` on the first line is the whole point. Without it there is no
kill switch, whatever else looks healthy.

---

## Phase 8 — Stop the server transcoding: prefer H.264 at grab time

Symptom: an episode plays for a while, then jumps back a few seconds and
replays them. Subtitles drift out of sync with the audio, several seconds
adrift by the middle of an episode. Both get worse the longer you watch.

### What is actually happening

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

### How much of the library this affects

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

### Step 8.1 — Score H.264 up, HEVC and AV1 down

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

### Step 8.2 — The setting that makes or breaks it

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

### Step 8.3 — What this does and does not fix

It applies to **future grabs only**. The files already on disk stay exactly as
they are, so the stutter continues on everything downloaded before this.

To also convert the existing library, raise *Upgrade Until Custom Format Score*
to `15` and run a season search — Sonarr will then treat every x265 file as
below cutoff and look for an x264 replacement. Think before doing this: it is a
re-download of most of the library, and H.264 runs roughly 1.7× the size of
x265 for the same quality. Check free space first.

### Step 8.4 — Fix the client instead, for what is already downloaded

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

---

## Phase 9 — Catch a torrent that is not what it claims to be

Sonarr was filling gaps in a series and grabbed this:

```
House.of.the.Dragon.S03E05.ITA.ENG.1080p.AMZN.WEB-DL.DDP5.1.H.264 MeM.GP.mkv
```

Inside was one file: `0088F5556SE1B9348AXW1EVFFDABCA25D3XXQB03R.exe`, 837 MB,
padded to the size of a video.

```bash
file /mnt/media/downloads/*.exe
# PE32+ executable for MS Windows 5.02 (GUI), x86-64 (stripped to external PDB)
```

It reached 100% and started seeding before anyone looked. On a Linux host a
Windows binary cannot run, so nothing was infected — but the box was
redistributing malware, and the file was one copy away from a Windows machine.

### Why nothing upstream can stop this

Sonarr and Prowlarr only ever see a release *title*. That title was completely
plausible; there is no naming rule that rejects it without also rejecting real
grabs. The tells are only suggestive - it ends in `.mkv`, which real release
names do not, it claims two audio languages, and it has no release group - and
1337x legitimately uses filenames as titles, so a `\.mkv$` rule would throw
away good releases too.

The first moment the truth is knowable is when the torrent's metadata resolves
and the client can list the files inside. That is the only place worth checking.

### Step 9.1 — Demote the indexer that served it

```bash
PK=$(grep -oP '(?<=<ApiKey>)[^<]+' ~/homelab/prowlarr/config/config.xml)
curl -s -H "X-Api-Key: $PK" http://localhost:9696/api/v1/indexer \
  | python3 -c "import sys,json; [print(i['priority'], i['name']) for i in json.load(sys.stdin)]"
```

1337x was on priority 10 — joint-highest, so it was tried first for everything.
It is on 45 now: kept, but only reached when nothing else has the release. This
is the second public indexer to do this; LimeTorrents was disabled in Phase 4
for the same reason.

Check that the change actually arrived. Prowlarr pushes indexer settings to
Sonarr and Radarr on its own schedule, and only when the application's Sync
Level is **Full Sync** — on *Add and Remove Only* it will never update an
indexer that already exists downstream, so the new priority silently stays in
Prowlarr:

```bash
curl -s -H "X-Api-Key: $PK" http://localhost:9696/api/v1/applications \
  | python3 -c "import sys,json; [print(a['name'], a['syncLevel']) for a in json.load(sys.stdin)]"
curl -s -X POST -H "X-Api-Key: $PK" http://localhost:9696/api/v1/command \
  -d '{"name":"ApplicationIndexerSync"}' -H 'Content-Type: application/json'
```

### Step 9.2 — The guard

`~/homelab-scripts/torrent-guard.py`, every minute from cron. It lists the files
inside every torrent qBittorrent holds and applies one narrow test:

| finding | in an *arr category | action |
|---|---|---|
| executable extension (`.exe`, `.scr`, `.bat`, `.msi`, `.lnk`, …) | yes | stop, delete with files, ntfy at urgent |
| no video extension at all | yes | ntfy only, once per torrent |
| anything | no (hand-added) | left alone |

Only the first case deletes. "No media file" is reported and never acted on,
because scene releases legitimately ship as split `.rar` volumes with no video
extension anywhere, and a false positive there destroys something real.
Hand-added torrents are exempt entirely — deleting someone's deliberate
download because it contains an installer would be its own kind of bug.

Every minute, not every five: metadata resolves within seconds of a grab, and
this payload finished in about two minutes at 48 MB/s. A slower poll arrives
after the seeding has already happened.

### Step 9.3 — Prove it before trusting it

A guard that deletes things has to be tested somewhere that is not your library.
`torrent-guard.py --dry-run` prints verdicts and touches nothing. Better, feed
it synthetic file lists and check both directions — that it removes the payload
*and* leaves real releases alone:

```
tonight's malware                        expected=REMOVE  got=REMOVE
real episode                             expected=ok      got=ok
video plus a bundled installer           expected=REMOVE  got=REMOVE
scene split archive, no video extension  expected=FLAG    got=FLAG
exe in a hand-added torrent              expected=ok      got=ok
```

### Step 9.4 — Clean up after one that got through

```bash
# stop it first - qBittorrent 5.x renamed pause to stop, and pause silently
# does nothing on this version
H=<hash>
docker exec gluetun wget -qO- --post-data="hashes=$H" http://127.0.0.1:8083/api/v2/torrents/stop
docker exec gluetun wget -qO- --post-data="hashes=$H&deleteFiles=true" http://127.0.0.1:8083/api/v2/torrents/delete
```

Then blocklist it in Sonarr, or it will be grabbed again on the next search.
Find the grab in history and mark it failed:

```bash
SK=$(grep -oP '(?<=<ApiKey>)[^<]+' ~/homelab/sonarr/config/config.xml)
curl -s -H "X-Api-Key: $SK" 'http://localhost:8989/api/v3/history?pageSize=40&sortKey=date&sortDirection=descending' \
  | python3 -c "import sys,json; [print(h['id'], h['sourceTitle']) for h in json.load(sys.stdin)['records'] if h['eventType']=='grabbed']"
curl -s -X POST -H "X-Api-Key: $SK" http://localhost:8989/api/v3/history/failed/<id>
```

---

## Phase 10 — Optional: public links for friends, through a relay VPS

**Skip this phase if Netbird (Phase 5) does what you need.** Netbird stays the
way you and anyone you install it for reach the whole homelab. This phase adds
something Netbird cannot: a normal `https://` address that family and friends
open in a browser or the Jellyfin app, with nothing to install. The two run
side by side.

> **Status:** Steps 10.1–10.5 are built and verified. Certificates and the
> public npm proxy hosts are still being set up and will be written up here
> once they work.

### Why a relay VPS and not the alternatives

| Option | What your ISP sees | Catch |
|--------|--------------------|-------|
| Netbird only (Phase 5) | an encrypted mesh | every viewer needs the Netbird app |
| Open port 443 at home | every visitor's IP, the hostname, how much you stream | your home IP is public in DNS |
| Cloudflare Tunnel | traffic to Cloudflare | Cloudflare decrypts everything, and its terms do not allow streaming video |
| **Relay VPS** | **one WireGuard flow to the VPS** | a small monthly cost |

The VPS never runs Jellyfin and never holds a certificate. It reads the
requested hostname from each TLS handshake and passes the still-encrypted
connection down a WireGuard tunnel that the homelab opened outwards. Nothing is
forwarded on the home router.

```
friend ──https──> VPS :443 ──WireGuard──> wg-relay ──> relay-forward ──> npm ──> jellyfin
                  (reads SNI only)         (home, outbound tunnel)
at home: Pi-hole answers the same name with the LAN IP, so home traffic stays home
```

The bottleneck is not the VPS: the smallest plan relays far more than one old
iGPU can transcode. Pick by price, not specs.

### Step 10.1 — Rent the VPS

Requirements: **KVM** virtualisation (container-based VPSes often cannot load
WireGuard), a **dedicated IPv4**, and Ubuntu LTS. The cheapest tier of most EU
hosts is enough.

This setup uses **STRATO VPS Linux S** (1 vCore, 2 GB, 60 GB NVMe, KVM,
dedicated IPv4, unlimited traffic, about €4/month in September 2026).
OVHcloud VPS-1, netcup and Hetzner work the same way. Compare the renewal price,
not the first-months promotion.

At checkout:

- **Order as a private customer.** At STRATO a consumer can cancel monthly
  after the first term; a business customer has to cancel before each yearly
  renewal.
- **Skip the SSL and backup add-ons.** The certificates are issued at home by
  npm (Let's Encrypt), and the VPS only holds a few config files that this
  phase recreates in minutes.
- **Untick optional marketing consent.** It shares personal data with ad
  partners, which defeats the point of the exercise.
- Read the provider's **acceptable-use terms**. Relaying your own service to
  people who have accounts on it is ordinary hosting. The clauses to check are
  the ones on anonymisation services, on handing the server to anonymous third
  parties, and on copyright complaints, which let a host suspend a server.

In the install form pick the **plain Ubuntu LTS image**, not the Plesk or app
variants. The web-console password field may accept letters and digits only;
a 24-character random one is strong regardless. After any reboot the web
console shows `login:`. That's normal, there is no need to log in there.

The VPS provider sees what your ISP would otherwise have seen: visitors' IPs,
the hostname and how much data flows. It does not see what anyone watches,
because TLS ends at home.

Log in with a key only. If the provider's install form takes a public key,
paste it there.

> ⚠️ **A web form can silently corrupt a pasted key.** One provider's form
> inserted a space in the middle of the key, and the result was a plain
> `Permission denied (publickey)` with no other hint. If that happens and your
> keys are on GitHub, log in once through the provider's web console and run
> `ssh-import-id gh:<your-github-user>`. It fetches the keys directly.

### Step 10.2 — Harden the VPS and install the pieces

```bash
apt update && apt upgrade -y
apt install -y wireguard-tools nginx libnginx-mod-stream ufw
rm /etc/nginx/sites-enabled/default

ufw default deny incoming
ufw allow 22/tcp
ufw allow 80/tcp       # certificate checks only - see Step 10.4
ufw allow 443/tcp
ufw allow 51820/udp
ufw enable
```

Confirm `sshd -T | grep passwordauthentication` prints `no`, then reboot once
so the updates take effect.

### Step 10.3 — The tunnel

**VPS side:** generate a key and create `/etc/wireguard/wg0.conf` from
[`relay/vps-wg0.conf.example`](relay/vps-wg0.conf.example), then
`systemctl enable --now wg-quick@wg0`.

**Home side:** no WireGuard install on the host is needed. The `wg-relay`
container holds the tunnel, and two tiny `socat` containers share its network
namespace (the same pattern as qBittorrent inside gluetun) to pass ports 443
and 80 on to npm.

1. Generate the home key and write `wg-relay/wg_confs/wg0.conf` from
   [`relay/home-wg0.conf.example`](relay/home-wg0.conf.example). `wg-relay/`
   is gitignored, so the private key never reaches the repo.
2. Enable the optional services in `.env`:
   ```
   COMPOSE_PROFILES=relay
   ```
   Without that line `docker compose up -d` leaves all three containers out,
   which is what someone running only Netbird wants.
3. `docker compose up -d`
4. Add the home public key as a peer in the VPS config, then check:
   ```bash
   wg show wg0            # on the VPS: "latest handshake: N seconds ago"
   ping -c3 10.77.0.2     # the home end answers
   ```

`wg-relay` sits on a Docker network of its own (`relay`, `172.31.77.0/24` in
`docker-compose.yml`), and npm joins that network as well as the default one.
This is not tidiness; Step 10.5 depends on it. Tunnel visitors must reach npm
from an address outside the default Docker network, or Jellyfin cannot tell
them apart from the services that run next to it.

### Step 10.4 — Forward only the public names

Two nginx configs on the VPS:

- [`relay/stream-relay.conf.example`](relay/stream-relay.conf.example):
  port 443. It passes TLS through by hostname and drops everything not on the
  list.
- [`relay/acme-relay.conf.example`](relay/acme-relay.conf.example): port 80.
  It forwards only `/.well-known/acme-challenge/`, so npm can obtain
  certificates, and redirects everything else to HTTPS.

Check from a machine outside your network:

```bash
openssl s_client -connect <VPS_IP>:443 -servername jellyfin.yourdomain.tld   # reaches npm
openssl s_client -connect <VPS_IP>:443 -servername anything.example          # dropped
curl -H "Host: sonarr.yourdomain.internal" http://<VPS_IP>/                  # no answer
```

Before npm has a certificate for the name, the first command ends in
`tlsv1 unrecognized name`. That alert comes from npm at home, which proves the
whole path works.

The Host-header test matters most. npm serves its internal admin hosts on port
80, and the relay must never let an outside request reach them.

### Step 10.5 — Tell Jellyfin who is local

npm hands Jellyfin the visitor's address in `X-Forwarded-For`. Jellyfin only
believes that from a proxy it knows, and decides "local or remote" from the
result. Remote is what applies the remote bitrate cap and what an account
restricted to home sign-in is refused on.

Dashboard → Networking (or `POST /System/Configuration/network` with an API
key, which applies without a restart):

- **Known proxies:** `npm` (the container name; Jellyfin resolves it)
- **LAN networks:** your home subnet, e.g. `192.168.1.0/24`, **and** the default
  Docker network, e.g. `172.18.0.0/16`
  (`docker network inspect homelab_default` shows it)

Both parts of that second setting are needed, for opposite reasons:

- Leave the Docker network out and every container counts as remote.
  **Jellyfin enforces remote access on every request, not only at sign-in**,
  so jellylab-push and Seerr can then no longer act for an account that may
  only sign in from home. An administrator account restricted that way is
  locked out of every tool that runs in Docker.
- Put the tunnel on the default network instead of its own `relay` network
  (Step 10.3), and friends arriving through the VPS would count as local and
  skip the bitrate cap.

Check each path with Jellyfin's own answer (`IsInNetwork`):

```bash
K='Authorization: MediaBrowser Token="<jellyfin api key>"'
curl -s -H "$K" http://192.168.1.42:8096/System/Endpoint                  # LAN direct: true
curl -s -H "$K" -H "Host: jellyfin.yourdomain.internal" http://192.168.1.42/System/Endpoint   # through npm: true
docker run --rm --network homelab_default curlimages/curl -s -H "$K" http://jellyfin:8096/System/Endpoint   # containers: true
docker run --rm --network homelab_relay curlimages/curl -s -H "$K" -H "Host: jellyfin.yourdomain.internal" http://npm/System/Endpoint   # tunnel: false
```

To keep an administrator account off the relay entirely, turn off **Allow
remote connections** for it and use an ordinary account for watching. The
administrator still works at home and from every container.

---

## Phase 11 — Encrypt Pi-hole's upstream DNS

Pi-hole answers your whole network, but for everything it doesn't block or
hold locally it asks an upstream resolver, by default in **plain text** on
port 53. Your ISP can read every one of those lookups: each domain every device
in the house looks up, all day. This phase is worth doing whether or not you
use Phase 10.

```
device ──> Pi-hole (blocklists, local records) ──> dnscrypt-proxy ──HTTPS──> Quad9
```

`dnscrypt-proxy` sends the queries over HTTPS on port 443, which looks like any
other web traffic. The resolver is Quad9: a Swiss non-profit, no query logging,
DNSSEC validation, and known malware domains blocked.

What it does **not** hide: the name of each site in the HTTPS handshake (SNI),
and devices that ignore the router's DNS and use a hard-coded one; many Google
TV and Chromecast devices use `8.8.8.8` directly. Hiding those means sending all
traffic through a VPN, which is a different project.

### Step 11.1 — Start dnscrypt-proxy

The service and its config, [`dnscrypt-proxy/dnscrypt-proxy.toml`](dnscrypt-proxy/dnscrypt-proxy.toml),
are in the repo. It listens on the LAN IP, port `5053`.

```bash
docker compose up -d dnscrypt-proxy
docker logs dnscrypt-proxy   # wait for: "Server with the lowest initial latency"
```

> ⚠️ **Never let dnscrypt-proxy use the system resolver.** On this host the
> system path can lead back to Pi-hole, which forwards to dnscrypt-proxy again:
> a loop. A loop of that shape filled `/dev/shm` and took DNS down for the whole
> network before. The config sets `ignore_system_dns = true` and uses fixed
> bootstrap addresses only to find Quad9 itself.

### Step 11.2 — Test it before Pi-hole depends on it

```bash
dig +short example.com @192.168.1.42 -p 5053                 # an address
dig dnssec-failed.org @192.168.1.42 -p 5053 | grep status    # SERVFAIL: DNSSEC works
docker exec pihole dig +short example.com @192.168.1.42 -p 5053   # reachable from Pi-hole
```

And ask Quad9 whether it's the one answering:

```bash
ip=$(dig +short on.quad9.net @192.168.1.42 -p 5053 | tail -1)
curl -s --resolve on.quad9.net:443:$ip https://on.quad9.net | grep -o "<title>[^<]*"
# <title>Yes, you ARE using quad9.
```

### Step 11.3 — Point Pi-hole at it

The upstream is runtime config in `pihole.toml`, which is gitignored, so it is
set by command rather than in compose. Pi-hole doesn't need a restart.

```bash
docker exec pihole pihole-FTL --config dns.upstreams '["192.168.1.42#5053"]'
```

Run the `on.quad9.net` check again, this time against Pi-hole
(`@192.168.1.42`, no port). Confirm an ad domain still returns `0.0.0.0` and a
local record still resolves.

Rollback, if anything misbehaves:

```bash
docker exec pihole pihole-FTL --config dns.upstreams '["8.8.8.8","8.8.4.4"]'
```

### Step 11.4 — Watch it

dnscrypt-proxy is now a single point of failure for the household's DNS. Two
safeguards:

- Like Pi-hole, it carries `com.centurylinklabs.watchtower.enable: "false"`, so
  a 4 AM image update can't take the network offline unattended.
- The two Uptime Kuma DNS monitors from Step 4.5 (ports `53` and `5053`),
  with the ntfy alerts from Phase 6. The `5053` monitor goes red the moment the
  container stops, even while Pi-hole is still answering from its cache.

---

## Phase 12 — Optional: per-user content filters (seerr-guard)

For households where some people should not see some titles. A person's filter
is a list of TMDB keywords (say, the adult keywords). Anything carrying one of
them disappears for that person in **both** Seerr and Jellyfin, in every app.
Nobody else notices anything.

Without any filters set up, seerr-guard is a transparent proxy and this phase
can be skipped.

```
browser / JellyLab app / Homarr / npm ──> seerr-guard :5055 ──> Seerr (stock, no published port)
jellylab-push ──> Seerr directly (API key) ──> Jellyfin BlockedTags, per person
                  both read jellylab-push-data/content-filters.json
```

### What a filtered person gets

- Hidden titles are gone from every list: discover, trending, search (including
  a person's "known for"), recommendations, collections and cast pages.
- A hidden title's page, its page data and its API answer **404**, even when the
  URL is typed in by hand.
- A request or watchlist add for a hidden title is refused.
- Nothing personal is ever cached: API answers and pages go out without ETag or
  Last-Modified and marked `no-store`, and a device's revalidation headers are
  not forwarded. Without that, a phone or browser used earlier by an unfiltered
  person revalidated its cached copy, Seerr answered 304, and the filtered
  person saw the unfiltered results. The canary checks this case too.
- In Jellyfin, `jellylab-push` stamps each title with `jellylab:kw:<keyword>`
  tags and puts each person's markers in their **BlockedTags**. Jellyfin then
  hides those titles in every client.

Decisions come from the keywords Seerr's own detail endpoint returns (cached for
30 days), so no TMDB key of its own is needed.

**It fails closed.** A title that has not been checked yet, a store file that
exists but cannot be parsed, or a caller Seerr cannot identify all mean
*hidden* for anyone who might be filtered. A missing store file means no filters
at all.

### Why not Seerr's own blocklist

Stock Seerr has a keyword blocklist, but it is global. A blocklisted title is
refused **to everyone**, on the server, so it cannot express "hidden for these
two people". An earlier version of this stack patched that into a fork of
Seerr, which then had to be rebased and rebuilt by hand on every release.
seerr-guard does the same job in front of stock Seerr, which updates like any
other image.

### Step 12.1 — Services

Already in `docker-compose.yml`:

- `jellyseerr` runs `ghcr.io/seerr-team/seerr:v3` and publishes **no port**.
  Anything that could reach Seerr directly would get around the filter.
- `seerr-guard` publishes `5055` in its place, so bookmarks, Homarr and the
  app keep working unchanged.

Add to `.env` (generate with `openssl rand -hex 24`):

```
FILTER_STORE_SECRET=...
```

In npm, point the Seerr proxy host at **`seerr-guard:5055`**, not
`jellyseerr:5055`. An npm host left on Seerr itself is a way around the filter.

### Step 12.2 — Set filters

Open `http://<mac-mini-ip>:8099/filters/admin` on the home network (the page and
its API refuse other networks, the mesh VPN included). Sign in with a Jellyfin
administrator, pick a person, and add keywords or turn on "hide adult content".
Seerr applies a change straight away; Jellyfin within minutes, or immediately
after the next sync.

The JellyLab app's own "Hide adult content" switch keeps working: seerr-guard
answers the fork's `blockedTags` / `hideAdult` settings fields from the store.

### Step 12.3 — The canary

A Seerr account with no permissions, filtered on one keyword. Uptime Kuma checks
through it that the filter still works, so a Seerr update that breaks it shows
up as an alert rather than as a child seeing something.

1. Create a local Seerr user (Users → Create Local User). New users get the
   default permissions (Request), so then set them to none:
   `PUT /api/v1/user/<id>` with `{"permissions": 0}`. With no request permission,
   even a broken guard cannot turn the canary's request check into a real
   request.
2. Add a `canary` block to `content-filters.json`: the user id, one keyword, a
   movie that the keyword's discover list really contains, and a clean movie.
   ```json
   "canary": { "seerrUserId": 7, "blockedTags": [256466], "hiddenTitle": "movie:1307118", "cleanTitle": "movie:603", "keywordId": 256466 }
   ```
3. Uptime Kuma: a **Keyword** monitor on `http://seerr-guard:5055/__guard/canary`
   expecting `ok`, every 30 minutes, with the ntfy notification. That URL
   answers only inside the Docker network.

### Step 12.4 — Updates

- The `v3` image tag follows 3.x releases only. Watchtower installs them
  overnight, and a 4.0 never arrives on its own.
- If an update changes what the guard relies on (a route, the `keywords` field),
  the canary monitor goes red.
- To move to a new major version, change the tag deliberately and watch the
  canary.

### The Seerr owner account

Seerr's API key always acts as **user #1**, the account created at first setup.
jellylab-push, seerr-guard, Homarr and the scripts all use the API key, so user
#1 must stay an administrator. Make it the administrator Jellyfin account, not
the account someone watches with.

If the everyday account got there first, swap which Jellyfin account each Seerr
user is linked to rather than demoting #1. Move that person's own requests
(`media_request.requestedById`) and their `user_settings` row along with them,
and end both users' sessions. Do it with Seerr stopped and a database backup
taken first.

### Coming from the Seerr fork

1. Back up `jellyseerr/config` and `jellylab-push-data`.
2. `scripts/export-fork-filters.py --out jellylab-push-data/content-filters.json --check`
   copies each person's filter out of the fork's database. `--check` compares
   the copy with what Jellyfin enforces now.
3. Stop Seerr, then run
   `scripts/seerr-clear-tag-blocklist.py --config jellyseerr/config --apply --seerr-is-stopped`.
   It removes the crawler's blocklist entries without touching requests.
   **Never use stock Seerr's own blocklist clean-up for this:** it deletes
   Media rows, and those cascade to their requests.
4. Switch the image, start `seerr-guard`, and repoint npm. Then run a full
   Jellyfin library scan in Seerr, so titles the crawler had marked
   blocklisted get their availability back.

### Verify

```bash
# is a title hidden for Seerr user 4? (inside the Docker network)
docker run --rm --network homelab_default curlimages/curl -s "http://seerr-guard:5055/__guard/decide?user=4&keys=movie:1307118,movie:603"
docker run --rm --network homelab_default curlimages/curl -s http://seerr-guard:5055/__guard/canary   # ok
curl -s http://<mac-mini-ip>:5055/__guard/health      # the LAN reaches the guard, not Seerr
docker logs seerr-guard | grep "404\|filter"         # one line per hidden title or filtered list
```

Tests: `node --test seerr-guard/test/filter.test.mjs seerr-guard/test/guard.test.mjs`
and `node --test jellylab-push/test/filters.test.mjs jellylab-push/test/routes.test.mjs`.

### Rollback

Stop `seerr-guard`, and give `jellyseerr` its `5055:5055` port back. Point npm
at `jellyseerr:5055` again. Filtering in Seerr stops; Jellyfin keeps hiding
what it already hid.

---

## Later / stretch goals

Once the basics work, add these one at a time:

- **Public links for friends** — done with a relay VPS instead of Cloudflare Tunnel, whose terms do not allow streaming video. See Phase 10. Optional: Netbird alone is a complete setup.
- **Vaultwarden** — self-hosted Bitwarden (password manager). Tiny, always worth running.
- **Offsite backups** — Duplicati or restic to Backblaze B2 (~€0.005/GB/mo). Covers Nextcloud data + your `~/homelab/` compose config folder. Without this a single drive failure loses everything.
- **Immich** — self-hosted Google Photos replacement, with AI face recognition
- **Home Assistant** — smart home hub (works with lights, sensors, cameras from many brands)
- **Paperless-ngx** — scan documents, OCR them, searchable archive
- **A second machine** — once you outgrow the Mac Mini, get a used Dell OptiPlex or Lenovo ThinkCentre ($100-200), install Proxmox, run VMs

---

## Getting help

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
