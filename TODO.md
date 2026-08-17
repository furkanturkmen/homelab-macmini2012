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
- **Additional options / Search for third-party drivers:** ✅ **Yes** — pulls the proprietary Broadcom BCM4331 wifi firmware and HD 4000 quirks. Harmless if unused, useful later.
- **Network:** should auto-detect your Ethernet and show a DHCP-assigned IP (e.g. `192.168.1.42/22`). **Change nothing** — just select Done. Do not try to set a static IP here; static assignment is done at the router in §1.6 (cleaner and survives OS reinstalls). **Write down the IP and MAC address shown now** — you'll need both for the router reservation later.
- **Proxy:** leave blank
- **Mirror:** leave default
- **Storage:** pick "Use an entire disk" and select the Mac Mini's internal drive. **THIS ERASES THE MAC MINI COMPLETELY.**
- **Confirm the destructive action:** yes, continue
- **Profile setup:**
  - Your name: your name
  - Server's name (hostname): `homelab` (this is what shows up on your network)
  - Username: pick a short lowercase name, no spaces (e.g. `furkan`)
  - Password: strong, but memorable — you'll type it a lot
- **SSH setup:** ✅ **Check "Install OpenSSH server"** — this is critical, you need it to log in remotely
- **Featured server snaps:** don't check anything. Skip.
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

### Step 4.2 — Edit the recipe

Still on the Mac Mini, open the file:

```
nano ~/homelab/docker-compose.yml
```

`nano` is a simple text editor. Arrow keys to move, Ctrl+O to save, Ctrl+X to exit.

**Find and change:**

- `WEBPASSWORD: "changeme"` → strong password for Pi-hole admin
- `FTLCONF_LOCAL_IPV4: "192.168.1.10"` → your actual Mac Mini IP
- `TZ: "Europe/Istanbul"` (appears multiple times) → your timezone if different (see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
- `MARIADB_ROOT_PASSWORD` and `MARIADB_PASSWORD` → strong passwords for the database
- `/mnt/media` → your actual movie/show folder path (or leave for now and add media later)
- `NEXTCLOUD_TRUSTED_DOMAINS` → the IP you'll use to reach Nextcloud

### Step 4.3 — Handle the DNS conflict

Ubuntu runs its own tiny DNS service on port 53. Pi-hole needs port 53. Turn Ubuntu's off:

```
sudo systemctl disable --now systemd-resolved
sudo rm /etc/resolv.conf
echo "nameserver 1.1.1.1" | sudo tee /etc/resolv.conf
```

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

Every service should say "Up" or "running."

### Step 4.5 — Visit each service

Open a browser on your Windows PC (or phone on same wifi):

- Pi-hole: `http://192.168.1.42:8080/admin`
- Portainer: `http://192.168.1.42:9000` — create an admin account first visit
- Nextcloud: `http://192.168.1.42:8081` — create admin, set up your first account
- Jellyfin: `http://192.168.1.42:8096` — walk through wizard, point at `/media`
- Uptime Kuma: `http://192.168.1.42:3001` — create admin, add monitors for each service
- Nginx Proxy Manager: `http://192.168.1.42:81` — default login `admin@example.com` / `changeme`, change immediately

Replace `192.168.1.42` with your Mac Mini's actual IP.

### Step 4.6 — Point your router's DNS at Pi-hole

- Router admin page → DNS settings
- Set the primary DNS to the Mac Mini's IP (`192.168.1.42`)
- Optionally set secondary to `1.1.1.1` (Cloudflare fallback)
- Save, reboot the router

Now every device on your wifi uses Pi-hole automatically. Ads gone.

---

## Phase 5 — Remote access with Tailscale

Tailscale lets you reach the Mac Mini from your phone at a cafe, laptop at work, etc. Without opening ports on your router.

### Step 5.1 — Install Tailscale on the Mac Mini

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

It prints a URL. Open it on your phone/laptop, sign in (free personal account with Google/Microsoft/GitHub).

### Step 5.2 — Install Tailscale on your other devices

- Phone: install the Tailscale app from App Store / Play Store, sign in same account
- Laptop: download from https://tailscale.com/download

Now all your devices see each other on a private virtual network. Reach the Mac Mini using its Tailscale IP (visible in the app).

---

---

## Phase 7 — Upgrade the HDD to an SSD

The single biggest speed boost you can make. Do this once you're comfortable and have $50-80.

### Step 7.1 — Buy the parts

- **2.5" SATA SSD**, 500 GB or 1 TB. Recommended: Crucial MX500 or Samsung 870 EVO.
- **T6 Torx screwdriver** — for internal screws
- **T8 Torx screwdriver** — for the drive bracket
- **Plastic spudger or old credit card** — to pop the case open

### Step 7.2 — Swap the drive

- Power off the Mac Mini
- Follow the iFixit guide: search for "Mac Mini Late 2012 Hard Drive Replacement"
- Takes about 30-45 minutes if you're careful

### Step 7.3 — Reinstall Ubuntu on the SSD

- Repeat Phase 1 with the new SSD in place
- Once Ubuntu is running, repeat Phases 2-4 (Docker + git clone + docker compose up)

---

## Later / stretch goals

Once the basics work, add these one at a time:

- **Immich** — self-hosted Google Photos replacement, with AI face recognition
- **Vaultwarden** — self-hosted Bitwarden (password manager). Tiny, always worth running.
- **Home Assistant** — smart home hub (works with lights, sensors, cameras from many brands)
- **The *arr stack** — Sonarr (TV shows), Radarr (movies), Prowlarr (indexer aggregator), qBittorrent, Jellyseerr (request UI) — automates finding and downloading media
- **Paperless-ngx** — scan documents, OCR them, searchable archive
- **A second machine** — once you outgrow the Mac Mini, get a used Dell OptiPlex or Lenovo ThinkCentre ($100-200), install Proxmox, run VMs

---

## Getting help

- **Docker won't start something:** `docker logs <container_name>` shows why
- **Can't SSH in:** check the Mac Mini's IP hasn't changed (check router)
- **Service won't respond in browser:** check `docker compose ps` — is it running? Check firewall on the Mac Mini (`sudo ufw status`)
- **General Linux help:** https://askubuntu.com
- **General homelab help:** https://reddit.com/r/selfhosted or https://reddit.com/r/homelab
- **Pi-hole:** https://discourse.pi-hole.net
- **Nextcloud:** https://help.nextcloud.com
