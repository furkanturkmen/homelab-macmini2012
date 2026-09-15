# Later / stretch goals

The setup guide lives in [`docs/`](docs/README.md). This file is what could come
after it. Once the basics work, add these one at a time:

- **Offsite backups** — Duplicati or restic to Backblaze B2 (~€0.005/GB/mo). Covers Nextcloud data + your `~/homelab/` compose config folder. Without this a single drive failure loses everything.
- **Vaultwarden** — self-hosted Bitwarden (password manager). Tiny, always worth running.
- **Immich** — self-hosted Google Photos replacement, with AI face recognition
- **Home Assistant** — smart home hub (works with lights, sensors, cameras from many brands)
- **Paperless-ngx** — scan documents, OCR them, searchable archive
- **A second machine** — once you outgrow the Mac Mini, get a used Dell OptiPlex or Lenovo ThinkCentre ($100-200), install Proxmox, run VMs

Done and moved into the guide: public links for friends, through a relay VPS
instead of Cloudflare Tunnel, whose terms do not allow streaming video
([Phase 10](docs/10-public-relay.md)). Optional: Netbird alone is a complete setup.
