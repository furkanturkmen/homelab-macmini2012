# Setup guide

This guide takes you from "I have an old computer" to "I have a working homelab" in about 2-3 hours. No prior Linux experience assumed.

Work through the phases in order. Phases 0–4 give you the working stack; everything after that adds one thing each and can be done when you want it.

## Two ways to reach it from outside

Phases 5 and 10 are not a sequence — they are **two answers to the same
question**, and most people only need the first.

| | [Phase 5 — mesh VPN](05-netbird.md) | [Phase 10 — relay VPS](10-public-relay.md) |
|---|---|---|
| Costs | nothing | a small VPS, ~€5/month, and a domain |
| Viewers must | install an app and be invited | open a link, nothing installed |
| Good for | you, your own devices, anyone you can ask to install something | family and friends who will not install a VPN |
| Admin pages (*arr, Portainer, Pi-hole) | reachable | deliberately **not** — those never go on the internet |
| Your ISP sees | an encrypted mesh | one encrypted flow to the VPS |

**Start with Phase 5.** It is free, takes ten minutes and covers every case
where the people involved will install an app. Add Phase 10 only when you hit
the wall it exists for: a parent or a friend who will never set up a VPN, or a
TV whose app store has no VPN client.

They run side by side — adding Phase 10 does not replace Netbird, and the
guide never assumes you did it. Anything that depends on the relay says so at
the top ([Step 6.7](06-push-notifications.md#step-67--optional-reach-ntfy-without-the-vpn)
is the only one outside Phase 10 itself). Phases 11, 12 and 13 work either way.

If you would rather not depend on a hosted mesh at all, [Step 10.9](10-public-relay.md)
is the same idea built entirely from your own machines: a WireGuard server at
home, with the VPS forwarding packets it cannot read.

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
| 13 | [Offsite backups](13-backups.md) | Everything irreplaceable copied nightly to Backblaze B2, encrypted, through the VPN |

## Reference

- [Storage](storage.md): the SSD and the data disk, and what lives where
- [Release rules](release-rules.md): how a request becomes the right download
- [Subtitles](subtitles.md): Bazarr's provider and the settings that matter
- [Getting help](getting-help.md): troubleshooting and useful commands
- [Later / stretch goals](../TODO.md)
