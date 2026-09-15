# Phase 11 — Encrypt Pi-hole's upstream DNS

Pi-hole answers your whole network, but for everything it doesn't block or
hold locally it asks an upstream resolver, by default in **plain text** on
port 53. Your ISP can read every one of those lookups: each domain every device
in the house looks up, all day. This phase is worth doing whether or not you
use [Phase 10](10-public-relay.md).

```
device ──> Pi-hole (blocklists, local records) ──> dnscrypt-proxy ──HTTPS──> Quad9
```

`dnscrypt-proxy` sends the queries over HTTPS on port 443, which looks like any
other web traffic. The resolver is Quad9: a Swiss non-profit, no query logging,
DNSSEC validation, and known malware domains blocked.

What it does **not** hide: the name of each site in the HTTPS handshake (SNI),
and devices that ignore the router's DNS and use a hard-coded one; many Google
TV and Chromecast devices use `8.8.8.8` directly. Hiding those means sending all
traffic through a VPN, which is a different project.

## Step 11.1 — Start dnscrypt-proxy

The service and its config, [`dnscrypt-proxy/dnscrypt-proxy.toml`](../dnscrypt-proxy/dnscrypt-proxy.toml),
are in the repo. It listens on the LAN IP, port `5053`.

```bash
docker compose up -d dnscrypt-proxy
docker logs dnscrypt-proxy   # wait for: "Server with the lowest initial latency"
```

> ⚠️ **Never let dnscrypt-proxy use the system resolver.** On this host the
> system path can lead back to Pi-hole, which forwards to dnscrypt-proxy again:
> a loop. A loop of that shape filled `/dev/shm` and took DNS down for the whole
> network before. The config sets `ignore_system_dns = true` and uses fixed
> bootstrap addresses only to find Quad9 itself.

## Step 11.2 — Test it before Pi-hole depends on it

```bash
dig +short example.com @192.168.1.42 -p 5053                 # an address
dig dnssec-failed.org @192.168.1.42 -p 5053 | grep status    # SERVFAIL: DNSSEC works
docker exec pihole dig +short example.com @192.168.1.42 -p 5053   # reachable from Pi-hole
```

And ask Quad9 whether it's the one answering:

```bash
ip=$(dig +short on.quad9.net @192.168.1.42 -p 5053 | tail -1)
curl -s --resolve on.quad9.net:443:$ip https://on.quad9.net | grep -o "<title>[^<]*"
# <title>Yes, you ARE using quad9.
```

## Step 11.3 — Point Pi-hole at it

The upstream is runtime config in `pihole.toml`, which is gitignored, so it is
set by command rather than in compose. Pi-hole doesn't need a restart.

```bash
docker exec pihole pihole-FTL --config dns.upstreams '["192.168.1.42#5053"]'
```

Run the `on.quad9.net` check again, this time against Pi-hole
(`@192.168.1.42`, no port). Confirm an ad domain still returns `0.0.0.0` and a
local record still resolves.

Rollback, if anything misbehaves:

```bash
docker exec pihole pihole-FTL --config dns.upstreams '["8.8.8.8","8.8.4.4"]'
```

## Step 11.4 — Watch it

dnscrypt-proxy is now a single point of failure for the household's DNS. Two
safeguards:

- Like Pi-hole, it carries `com.centurylinklabs.watchtower.enable: "false"`, so
  a 4 AM image update can't take the network offline unattended.
- The two Uptime Kuma DNS monitors from [Step 4.5](04-deploy-the-stack.md#step-45--first-run-setup-for-each-service) (ports `53` and `5053`),
  with the ntfy alerts from [Phase 6](06-push-notifications.md). The `5053` monitor goes red the moment the
  container stops, even while Pi-hole is still answering from its cache.

---

[← Phase 10: Optional: public links for friends, through a relay VPS](10-public-relay.md) · [All phases](README.md) · [Phase 12: Optional: per-user content filters (seerr-guard) →](12-content-filters.md)
