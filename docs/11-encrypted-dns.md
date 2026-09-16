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

## Step 11.4 — The server itself is probably still leaking

Everything above covers *devices on the network*. It does not necessarily cover
**the machine running all of this**, and that machine is the one doing most of
the talking: Sonarr and Radarr asking their metadata services, Jellyfin's
plugins, Seerr, Watchtower, every image pull.

Containers don't read `/etc/resolv.conf` themselves. Docker gives them
`127.0.0.11`, an embedded resolver that forwards to whatever the **host** has.
So the host's resolver decides for all of them, and on this host it had been
pointed at the mesh VPN (Phase 5), whose nameserver rule matched only
`homelab.internal` and `homelab.lan`. Everything else was forwarded to the
resolver from before the VPN was installed — `1.1.1.1`, in plain text.

That is invisible unless you look for it. **Do not test this with `dig`**: a
`dig @…` proves only that the server you named can answer. Ask instead whether
Pi-hole ever *saw* the query:

```bash
# 1. a name nothing has ever looked up, asked from inside a container
probe="dnsproof-$(date +%s).example.com"
docker exec sonarr getent hosts "$probe"

# 2. did Pi-hole see it?  (API: POST /api/auth for a SID, then /api/queries)
#    Pi-hole's own query log in the UI does just as well.
```

If the probe is absent, those lookups never reached Pi-hole. A second tell: the
client list in Pi-hole's dashboard contains laptops and phones but **never the
server's own address**. And to see who is really answering:

```bash
dig +short whoami.akamai.net        # returns the resolver's egress address
```

The fix is one file, and it survives removing the VPN later:

```json
/etc/docker/daemon.json
{ "dns": ["192.168.1.42"] }
```

```bash
sudo systemctl restart docker   # restarts every container
```

Every container then asks Pi-hole directly, and Pi-hole forwards over HTTPS as
in Step 11.3. Re-run the probe afterwards: Pi-hole should log it, forwarded to
`192.168.1.42#5053`, and `whoami.akamai.net` should return the encrypted
resolver's address rather than the old one.

Two things worth knowing before running it:

- **It restarts everything.** Check nobody is watching first. If `/mnt/storage`
  or an equivalent mount is involved, note that the empty-mount race is a *boot*
  problem — a manual restart is safe because the disk is already mounted.
- **No loop is created.** Pi-hole's upstream is an IP (`…#5053`), dnscrypt-proxy
  bootstraps by IP, and the VPN container's endpoint is an IP — none of them
  need DNS to come up.

A welcome side effect: the containers now get the blocklists too. They never did
before.

## Step 11.5 — Watch it

dnscrypt-proxy is now a single point of failure for the household's DNS. Two
safeguards:

- Like Pi-hole, it carries `com.centurylinklabs.watchtower.enable: "false"`, so
  a 4 AM image update can't take the network offline unattended.
- The two Uptime Kuma DNS monitors from [Step 4.5](04-deploy-the-stack.md#step-45--first-run-setup-for-each-service) (ports `53` and `5053`),
  with the ntfy alerts from [Phase 6](06-push-notifications.md). The `5053` monitor goes red the moment the
  container stops, even while Pi-hole is still answering from its cache.

---

[← Phase 10: Optional: public links for friends, through a relay VPS](10-public-relay.md) · [All phases](README.md) · [Phase 12: Optional: per-user content filters (seerr-guard) →](12-content-filters.md)
