# Later / stretch goals

The setup guide lives in [`docs/`](docs/README.md). This file is what could come
after it. Once the basics work, add these one at a time:

- **Vaultwarden** — self-hosted Bitwarden (password manager). Tiny. Worth it if you do not already use a hosted password manager; if you do, weigh it against becoming the person responsible for your own password vault's uptime and backups.
- **Immich** — self-hosted Google Photos replacement, with AI face recognition
- **Home Assistant** — smart home hub (works with lights, sensors, cameras from many brands)
- **Paperless-ngx** — scan documents, OCR them, searchable archive
- **A second machine** — once you outgrow the Mac Mini, get a used Dell OptiPlex or Lenovo ThinkCentre ($100-200), install Proxmox, run VMs

Done and moved into the guide:

- **Public links for friends**, through a relay VPS instead of Cloudflare
  Tunnel, whose terms do not allow streaming video
  ([Phase 10](docs/10-public-relay.md)). Optional: Netbird alone is a complete
  setup.
- **Offsite backups** — restic to Backblaze B2, encrypted before they leave the
  house and sent through the VPN, with a restore test and an alert for the
  backup that quietly stops happening ([Phase 13](docs/13-backups.md)).
