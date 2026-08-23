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

### Step 4.6 — Point your router's DNS at Pi-hole

- Router admin page → DNS settings
- Set the primary DNS to the Mac Mini's IP (`192.168.1.42`)
- Optionally set secondary to `1.1.1.1` (Cloudflare fallback)
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

## Later / stretch goals

Once the basics work, add these one at a time:

- **Cloudflare Tunnel** — buy a domain (~€10/yr, Cloudflare Registrar is zero-hassle), point a subdomain (`jellyfin.yourdomain.com`) at your homelab through Cloudflare's edge. Solves the cellular relay bandwidth cap in §5, gives you a real HTTPS cert, and lets friends/family reach Jellyfin/Jellyseerr with no VPN client at all.
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
- **General Linux help:** https://askubuntu.com
- **General homelab help:** https://reddit.com/r/selfhosted or https://reddit.com/r/homelab
- **Pi-hole:** https://discourse.pi-hole.net
- **Nextcloud:** https://help.nextcloud.com
