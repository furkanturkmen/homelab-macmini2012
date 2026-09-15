# Phase 4 — Deploy the homelab stack

## Step 4.1 — Get the recipe file onto the Mac Mini

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

## Step 4.2 — Create your `.env` file

The compose file has zero real secrets in it — every password and per-host value is a `${VAR}` placeholder that gets filled in from a separate file called `.env`. That file is **gitignored** so your secrets never leave the Mac Mini.

Copy the template and edit it:

```
cp .env.example .env
nano .env
```

`nano` is a simple text editor. Arrow keys to move, Ctrl+O to save, Ctrl+X to exit.

**Set each variable:**

- `HOST_LAN_IP=192.168.1.42` → the Mac Mini's LAN IP from [Step 1.5](01-install-ubuntu.md#step-15--find-the-mac-minis-ip-address). Used by Pi-hole (port binding) and Nextcloud (trusted domain).
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

## Step 4.3 — Handle the DNS conflict

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

## Step 4.4 — Start everything

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

Once it is up, open a browser on any device on your home network:

| Service | URL (replace `<ip>` with your Mac Mini IP) |
|---------|---------|
| Homarr (start page) | `http://<ip>:7575` |
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
| Seerr (through seerr-guard) | `http://<ip>:5055` |
| ntfy | `http://<ip>:8095` |
| jellylab-push (health) | `http://<ip>:8099/health` |

Find the Mac Mini's IP by SSH'ing in and running `ip -4 addr show`. Look for the number that starts with `192.168.` or `10.`.

Once NPM is set up you can also reach each service by hostname: `http://jellyfin.yourdomain.internal`, `http://nextcloud.yourdomain.internal`, etc.

## Step 4.5 — First-run setup for each service

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

Password = the `FTLCONF_webserver_api_password` you set in compose. If the compose env doesn't work (locked out with a random-looking password), see the Pi-hole notes in Step 4.2 — v6 changed the env var and password only inits on first boot, so a rename after first boot won't take. Reset with `docker exec -it pihole pihole setpassword`.

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
| Pi-hole · encrypted upstream | `example.com` | `192.168.1.42` | `5053` (only after [Phase 11](11-encrypted-dns.md)) |

Uptime Kuma does not alert anyone until a notification is set up. Once ntfy
runs ([Phase 6](06-push-notifications.md)), connect it; see *Uptime Kuma alerts* in [Phase 6](06-push-notifications.md).

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

## Step 4.6 — Point your router's DNS at Pi-hole

- Router admin page → DNS settings
- Set the primary DNS to the Mac Mini's IP (`192.168.1.42`)
- **Leave the secondary empty**, or set it to Pi-hole as well. A public
  secondary such as `1.1.1.1` lets devices skip Pi-hole (ads come back at
  random), and after [Phase 11](11-encrypted-dns.md) it would also send lookups past the encryption
- Save, reboot the router

Now every device on your wifi uses Pi-hole automatically. Ads gone.

---

## Step 4.7 — Enable hardware transcoding (VA-API)

The HD 4000 has a working H.264 encoder and decoder (Intel Quick Sync). Jellyfin can use it, which cuts transcode CPU load dramatically. Measured on this exact machine, transcoding a 1080p H.264 High file down to 1080p @ 4 Mbps:

| Path | Speed |
|------|-------|
| Hardware (VAAPI) | **177 fps — 7.4x realtime** |
| Software (libx264 `veryfast`) | 62 fps — 2.6x realtime |

Roughly 2.8x faster, and it leaves the CPU free for Nextcloud, the *arr apps and downloads.

**What it can and cannot do.** The Ivy Bridge GPU supports H.264, MPEG-2 and VC-1 in hardware. It has **no** HEVC/H.265, VP9 or AV1 decoder — those fall back to the CPU and are slow above 1080p. HDR tone-mapping is not supported at all. If most of your library is x265, hardware acceleration will not help you much.

**You do not need to install anything on Ubuntu.** The `jellyfin/jellyfin` image ships its own VA-API drivers (`i965_drv_video.so`) inside `/usr/lib/jellyfin-ffmpeg/lib/dri/`. No `apt install` on the host is required. The container just needs access to the GPU device.

### 1. Find your `render` group ID

```bash
getent group render video
```

Output looks like `render:x:991:` and `video:x:44:`. Note both numbers — the render GID differs between machines.

### 2. Give the Jellyfin container the GPU

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

### 3. Verify the GPU is visible inside the container

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

### 4. Turn it on in Jellyfin

**Dashboard → Playback → Transcoding**:

- **Hardware acceleration:** `Video Acceleration API (VAAPI)`
- **VA-API Device:** `/dev/dri/renderD128`
- **Enable hardware decoding for:** tick **H264**, **MPEG2**, **VC1** only. Leave HEVC, VP9, AV1, HEVC 10bit and VP9 10bit **unticked** — the hardware cannot do them, and ticking them causes playback to fail rather than fall back cleanly.
- **Allow encoding in HEVC format:** **off**
- **Enable Tone mapping / VPP Tone mapping:** **off** (needs hardware this GPU does not have)
- **Enable hardware encoding:** **on**

Save, then play something that forces a transcode (lower the quality in the web player) and confirm it works.

### 5. Confirm it is actually using the GPU

While a transcode is running:

```bash
sudo apt install intel-gpu-tools
sudo intel_gpu_top
```

The **Video** engine row should show activity. If it sits at 0% while the CPU is pinned, Jellyfin is still transcoding in software — check the Jellyfin playback log for the ffmpeg command line and look for `h264_vaapi`.

---

[← Phase 3: Install Docker](03-docker.md) · [All phases](README.md) · [Phase 5: Remote access with Netbird →](05-netbird.md)
