# Homelab TODO

Mac Mini 2012 (i7, 16GB DDR3, HDD → SSD later) running Ubuntu Server + Docker.

## Phase 1 — Get Ubuntu running

- [ ] Download Ubuntu Server 24.04 LTS ISO (ubuntu.com/download/server)
- [ ] Make bootable USB with Rufus (rufus.ie), 32GB stick, GPT
- [ ] Boot Mac Mini from USB (hold Option key, pick EFI Boot)
- [ ] Install Ubuntu: erase disk, hostname `homelab`, enable OpenSSH, skip snaps
- [ ] Find IP (`ip a`), set DHCP reservation in router
- [ ] SSH from Windows: `ssh user@<ip>`
- [ ] Unplug monitor + keyboard, headless from now on

## Phase 2 — Docker

- [ ] `sudo apt update && sudo apt upgrade -y`
- [ ] Install Docker: `curl -fsSL https://get.docker.com | sh`
- [ ] Add user to docker group: `sudo usermod -aG docker $USER` (logout/login)
- [ ] Create `~/homelab` on Mac Mini
- [ ] `scp docker-compose.yml` from Windows to Mac Mini
- [ ] Edit compose: passwords, `FTLCONF_LOCAL_IPV4`, timezone, media path
- [ ] `docker compose up -d`
- [ ] Check each: Pi-hole, Portainer, Nextcloud, Jellyfin, NPM, Uptime Kuma
- [ ] Set router DNS → Mac Mini IP (Pi-hole takes over)

## Phase 3 — Remote access

- [ ] Install Tailscale on host (not container)
- [ ] Add phone + laptop to Tailnet
- [ ] Test SSH over Tailscale

## Phase 4 — Games

- [ ] Bring up 7 Days to Die container
- [ ] Port-forward on router OR use Playit.gg
- [ ] Test with friend

## Phase 5 — Hardware upgrades

- [ ] 2.5" SATA SSD (Crucial MX500 500GB/1TB)
- [ ] T6 + T8 Torx screwdrivers
- [ ] Follow iFixit "Mac Mini Late 2012 SSD" guide
- [ ] Fresh Ubuntu install on SSD OR clone HDD → SSD

## Later / stretch

- [ ] Immich for photos
- [ ] Vaultwarden (Bitwarden self-host, tiny)
- [ ] Home Assistant
- [ ] *arr stack (Sonarr, Radarr, Prowlarr, qBittorrent, Jellyseerr)
- [ ] Second box → Proxmox for VMs
