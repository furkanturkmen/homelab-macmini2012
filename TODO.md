# Later / stretch goals

The setup guide lives in [`docs/`](docs/README.md). This file is what could come
after it. Once the basics work, add these one at a time:

- **Vaultwarden** — self-hosted Bitwarden (password manager). Tiny. Worth it if you do not already use a hosted password manager; if you do, weigh it against becoming the person responsible for your own password vault's uptime and backups.
- **Immich** — self-hosted Google Photos replacement, with AI face recognition
- **Home Assistant** — smart home hub (works with lights, sensors, cameras from many brands)
- **Paperless-ngx** — scan documents, OCR them, searchable archive
- **A second machine** — once you outgrow the Mac Mini, get a used Dell OptiPlex or Lenovo ThinkCentre ($100-200), install Proxmox, run VMs

## Configuring what is already running

Not new services — settings in the ones already here.

- **Pi-hole per-client groups.** The content filters in
  [Phase 12](docs/12-content-filters.md) cover Jellyfin and Seerr — the *media*.
  The open web is filtered identically for everyone in the house. Pi-hole
  supports client groups, so the children's devices can carry stricter
  blocklists than yours. Needs the devices identified first (Pi-hole lists them
  under Clients once they have made a query), then a group per policy. The
  natural complement to the per-user media filters, and currently missing.

Done and moved into the guide:

- **Jellyfin per-user streaming limits.** Every non-admin account except the
  owner's may run 2 streams at once (Dashboard → Users → edit → Maximum number
  of simultaneous user sessions). No remote bitrate cap on purpose: a cap
  forces a transcode of every file above it, and transcoding is exactly what
  an HD 4000 cannot afford.
- **Seerr request quotas.** 10 movies and 5 series a week for the children,
  20 and 10 for other adults, unlimited for the owner (Users → edit →
  quotas). `enableSpecialEpisodes` off: specials are badly named at every
  indexer and sat "searching" forever.
- **Uptime Kuma history retention.** 60 days instead of 180 (Settings →
  Monitor History). After three months the database held 1.6 million
  heartbeats and 245 MB, all of it in the nightly backup.

- **Public links for friends**, through a relay VPS instead of Cloudflare
  Tunnel, whose terms do not allow streaming video
  ([Phase 10](docs/10-public-relay.md)). Optional: Netbird alone is a complete
  setup.
- **Offsite backups** — restic to Backblaze B2, encrypted before they leave the
  house and sent through the VPN, with a restore test and an alert for the
  backup that quietly stops happening ([Phase 13](docs/13-backups.md)).
