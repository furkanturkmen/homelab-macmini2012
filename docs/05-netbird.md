# Phase 5 — Remote access with Netbird

Netbird is a free WireGuard-based mesh VPN. Lets you reach the Mac Mini from your phone at a cafe, laptop at work, etc. — without opening ports on your router.

> **Why Netbird instead of Tailscale?** Both work. Tailscale was tried first here and dropped because of an iOS 26 bug where split-DNS wasn't applied on cellular. Netbird's split-DNS worked immediately on all platforms. Both are excellent — pick either, this guide covers Netbird.

> **This is one of two ways in, and the one to start with.** It is free and
> covers everything as long as each person will install the app. When that
> stops being true — a relative who never will, or a TV with no VPN client —
> [Phase 10](10-public-relay.md) adds plain `https://` links through a relay
> VPS, for viewing only. The two run side by side; nothing later in this guide
> assumes you did Phase 10.

## Step 5.1 — Install Netbird on the Mac Mini

```
curl -fsSL https://pkgs.netbird.io/install.sh | sh
sudo netbird up
```

It prints a URL. Open it in a browser, sign in (free personal account with Google/GitHub/Microsoft). The Mac Mini joins your Netbird "network" as a peer.

## Step 5.2 — Install Netbird on your other devices

- Phone: install the Netbird app from App Store / Play Store, sign in with the same account
- Laptop: download from https://netbird.io/download

Now all your devices see each other. Reach the Mac Mini using its Netbird IP (visible in the app) — e.g. `http://100.71.232.136:8096` for Jellyfin.

## Step 5.3 — Add a Network Route so peers can reach LAN IPs

By default Netbird only lets peers reach each other by their Netbird IPs. To reach `192.168.1.42:8096` (or any other LAN device) from your phone off-LAN:

- Netbird admin panel (https://app.netbird.io) → **Networks** → **Add Network** → Name: `homelab-lan`
- **Add Resource** → **Subnet** → CIDR: `192.168.1.0/22` (or whatever covers your LAN — check `ip -4 addr show` on the Mac Mini)
- Assign the routing peer: **homelab** (the Mac Mini), toggle **Masquerade** ON
- Save

Now phones on 4G can reach `192.168.1.42:PORT` as if they were on your wifi.

## Step 5.4 — Add split-DNS for `*.yourdomain.internal`

If you set up Pi-hole with local hostnames like `jellyfin.yourdomain.internal`:

- Netbird admin → **DNS** → **Add Nameserver Group**
- Name: `pihole`, Nameserver: your Mac Mini's Netbird IP + port 53, Match Domains: `yourdomain.internal`, `yourdomain.lan`
- Assign to all peers

Now off-LAN devices resolve `*.yourdomain.internal` via Pi-hole through the tunnel.

> **Known cellular limitation (Vodafone NL CGNAT).** iPhones on Vodafone cellular stay on a Netbird relay (not direct P2P) because the carrier's CGNAT blocks direct WireGuard even with UPnP + explicit port-forward. Home wifi is direct + full speed. Cellular streaming is capped by shared relay bandwidth. Workaround: in the Jellyfin iOS app, Quality → Max Cellular Bitrate = 3 Mbps. Real fix: Cloudflare Tunnel with a real domain, so streaming goes over Cloudflare's edge instead of the Netbird relay.

---

[← Phase 4: Deploy the homelab stack](04-deploy-the-stack.md) · [All phases](README.md) · [Phase 6: Push notifications when a download finishes →](06-push-notifications.md)
