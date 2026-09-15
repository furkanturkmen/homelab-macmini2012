# Setup guide

This guide takes you from "I have an old computer" to "I have a working homelab" in about 2-3 hours. No prior Linux experience assumed.

Work through the phases in order. Phases 0–4 give you the working stack; everything after that adds one thing each and can be done when you want it.

**What you need before starting:**

- The Mac Mini 2012 (or any old computer with 8GB+ RAM)
- A Windows PC (or Mac, or another Linux computer) — the "workstation" you'll use to prepare things
- A USB stick, 8 GB or larger (its contents will be erased)
- An Ethernet cable to plug the Mac Mini into your router
- A USB keyboard (wired, not Bluetooth — Bluetooth doesn't work in the installer)
- A monitor and HDMI cable (for the first install only)
- Your home wifi router's admin login (to reserve an IP address later)
- About 2-3 hours of free time

## Phases

| Phase | | What you end up with |
|-------|---|----------------------|
| 0 | [Check the drive first](00-ssd.md) | *Optional.* An SSD instead of the stock hard drive, before anything is installed |
| 1 | [Install Ubuntu](01-install-ubuntu.md) | Ubuntu Server on the Mac Mini, with a fixed IP address |
| 2 | [SSH](02-ssh.md) | Control from your PC; the Mac Mini runs headless |
| 3 | [Install Docker](03-docker.md) | Docker, usable without `sudo` |
| 4 | [Deploy the stack](04-deploy-the-stack.md) | Every service running and set up, Pi-hole as the network's DNS, hardware transcoding |
| 5 | [Remote access with Netbird](05-netbird.md) | The whole homelab from anywhere, over a mesh VPN |
| 6 | [Push notifications](06-push-notifications.md) | A phone notification when a download finishes, and Uptime Kuma alerts |
| 7 | [qBittorrent through a VPN](07-qbittorrent-vpn.md) | Torrent traffic through a VPN with a kill switch |
| 8 | [Prefer H.264](08-prefer-h264.md) | Downloads the old iGPU can transcode in hardware |
| 9 | [Torrent guard](09-torrent-guard.md) | Fake releases (executables with a film's name) caught and their indexer demoted |
| 10 | [Public links through a relay VPS](10-public-relay.md) | *Optional.* `https://` links for family and friends with nothing to install, hidden from your ISP |
| 11 | [Encrypted DNS](11-encrypted-dns.md) | Pi-hole's lookups encrypted, so your ISP cannot read them |
| 12 | [Per-user content filters](12-content-filters.md) | *Optional.* Titles hidden per person in Seerr and Jellyfin |

## Reference

- [Storage](storage.md): the SSD and the data disk, and what lives where
- [Release rules](release-rules.md): how a request becomes the right download
- [Subtitles](subtitles.md): Bazarr's provider and the settings that matter
- [Getting help](getting-help.md): troubleshooting and useful commands
- [Later / stretch goals](../TODO.md)
