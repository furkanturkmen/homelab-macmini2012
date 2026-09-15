# Phase 7 — Route qBittorrent through a VPN

Without this, qBittorrent announces your home IP to every tracker and peer you
connect to. This puts torrent traffic — and only torrent traffic — inside a
WireGuard tunnel. Jellyfin, Nextcloud, the *arr apps and Netbird keep using the
normal connection.

## Why a container and not a system VPN

`gluetun` holds the tunnel, and qBittorrent joins its network namespace rather
than having one of its own:

```yaml
qbittorrent:
  network_mode: "service:gluetun"
```

That gives a real kill switch. gluetun sets the firewall's OUTPUT policy to
DROP and permits only `tun0`, the VPN endpoint itself, and the private ranges
needed for WebUI replies:

```
-P OUTPUT DROP
-A OUTPUT -o tun0 -j ACCEPT
-A OUTPUT -d <endpoint> -p udp --dport 51820 -j ACCEPT
```

If the tunnel drops, qBittorrent has no interface left to leak through. That is
stronger than binding qBittorrent to an interface and hoping, which fails open.

## Step 7.1 — Pick a provider

Port forwarding is the thing that matters. Without it you cannot accept
incoming connections, and your ratio suffers.

| Provider | Port forwarding | Note |
|----------|-----------------|------|
| ProtonVPN | yes, on paid | rotates on reconnect |
| AirVPN | yes | static, set once |
| Mullvad | no | otherwise excellent |
| PIA | yes | owned by Kape, formerly an adware company |

This setup uses ProtonVPN (Plus or Unlimited — port forwarding is not on Free).

## Step 7.2 — Generate the WireGuard config

Proton account → Downloads → WireGuard configuration:

- **Name: something unique** — see the warning below
- **Platform:** Router
- **NAT-PMP (Port Forwarding): ON** — easy to miss, and forwarding silently
  does nothing without it
- **Server:** a **P2P**-marked server (the `P` badge) in a country you want

> ⚠️ **Creating a config that reuses an existing name replaces that certificate.**
> Generating a second config called `conf-home` silently invalidates the first.
> WireGuard rejects a bad peer **without any error** — the tunnel connects, the
> interface comes up, and no traffic passes. This is indistinguishable from a
> misconfiguration and is worth ruling out first if nothing flows.

Open the downloaded `.conf`. You need four values:

```
PrivateKey = ...          -> WIREGUARD_PRIVATE_KEY
Address    = 10.2.0.2/32  -> WIREGUARD_ADDRESSES
PublicKey  = ...          -> WIREGUARD_PUBLIC_KEY   (from [Peer])
Endpoint   = 1.2.3.4:51820 -> VPN_ENDPOINT_IP / VPN_ENDPOINT_PORT
```

Put them in `.env`, which is gitignored:

```
WIREGUARD_PRIVATE_KEY=...
WIREGUARD_ADDRESSES=10.2.0.2/32
WIREGUARD_PUBLIC_KEY=...
VPN_ENDPOINT_IP=...
VPN_ENDPOINT_PORT=51820
```

## Step 7.3 — Three settings that are not obvious

All three are already in `docker-compose.yml`. They are recorded here because
each one presents as a completely different problem.

**`VPN_SERVICE_PROVIDER: "custom"`, not `"protonvpn"`.** With the provider
preset, gluetun supplies the peer public key and endpoint from its own bundled
server list. When that disagrees with your certificate the handshake is
rejected silently, and you get a tunnel that connects and carries nothing.
Taking all four values from the `.conf` removes the guesswork.

**`DOT: "off"` with `DNS_ADDRESS: "10.2.0.1"`.** gluetun defaults to
DNS-over-TLS via Cloudflare. Proton only permits DNS to their own resolver
inside the tunnel and resets anything else, so every lookup fails and the
healthcheck restart-loops over a link that is actually fine. `10.2.0.1` is the
`DNS =` line from Proton's config.

**`VPN_PORT_FORWARDING_UP_COMMAND`.** Proton hands out a new forwarded port on
every reconnect. Without pushing it into qBittorrent, it keeps announcing a
port that no longer forwards and quietly stops accepting incoming peers —
downloads still work, seeding dies. `gluetun/update-qbit-port.sh` sets it over
qBittorrent's API on each change.

That script reaches qBittorrent on `127.0.0.1` because they share a namespace,
which is also why it needs no credentials: qBittorrent is configured to skip
auth for localhost, and inside a shared namespace nothing else can be
localhost.

> qBittorrent rewrites `qBittorrent.conf` when it shuts down, so edit that file
> only while the container is **stopped**. Changes made while it is running are
> silently discarded on the next restart.

## Step 7.4 — Repoint Radarr and Sonarr

qBittorrent no longer has a network of its own, so `qbittorrent:8083` stops
resolving. In both apps: **Settings → Download Clients → qBittorrent → Host**
becomes `gluetun`. Test, then Save.

## Step 7.5 — Verify, do not assume

A tunnel that starts is not a tunnel that works. Check the exit IP from
**inside** the container:

```bash
docker exec qbittorrent sh -c 'wget -qO- https://ifconfig.me/ip'   # VPN address
curl -s https://ifconfig.me/ip                                      # your own, for contrast
```

Two different answers means it is working. The same answer twice means
qBittorrent is not in the namespace.

Then confirm the kill switch really exists:

```bash
docker exec gluetun iptables -S OUTPUT | head -3
```

`-P OUTPUT DROP` on the first line is the whole point. Without it there is no
kill switch, whatever else looks healthy.

## Step 7.6 — Keep it whole: the VPN guard

A working tunnel does not stay working by itself. Once, gluetun failed a
healthcheck on a DNS hiccup, started restarting the VPN and hung at "stopping"
for twelve and a half hours. Nothing leaked (the kill switch held, and the old
tunnel kept carrying traffic), but port forwarding had been torn down first, so
no peer could connect in and every download crawled. Docker marked gluetun
unhealthy and does nothing with that.

[`scripts/vpn-guard.py`](../scripts/vpn-guard.py) checks every five minutes:
gluetun healthy, traffic inside the tunnel leaving from an address other than
your own, a forwarded port, qBittorrent listening on exactly that port. When
something is wrong on two runs in a row it repairs, smallest fix first:

- only the port is stale: it pushes the forwarded port into qBittorrent. This
  happens when gluetun hands out a port while qBittorrent is restarting;
- anything else: restart gluetun, wait until it is healthy with a port, **then**
  restart qBittorrent, then push the port. qBittorrent lives in gluetun's
  network namespace, so restarting gluetun alone leaves it without a network.

It leaves a stopped qBittorrent alone (disk-guard stops it on purpose when the
disk is nearly full), waits five minutes after gluetun starts (Watchtower or you
mid-update), repairs at most every 20 minutes and 4 times a day, and sends an
ntfy message for every repair. If tunnel traffic ever left from your own address
it stops qBittorrent at once.

```bash
cp scripts/vpn-guard.py ~/homelab-scripts/ && chmod 755 ~/homelab-scripts/vpn-guard.py
python3 ~/homelab-scripts/vpn-guard.py --dry-run    # reports, changes nothing
crontab -e
# */5 * * * * /usr/bin/python3 /home/furkan/homelab-scripts/vpn-guard.py >> /home/furkan/homelab-scripts/vpn-guard.log 2>&1
```

Paths in the script assume the user `furkan` and `~/homelab`; adjust them for
yours. `--repair` runs the full restart once, whatever the state, to prove the
sequence on your machine. It took about 20 seconds here.

## Step 7.7 — Indexer searches through the tunnel too

The tunnel hides what qBittorrent shares, but Prowlarr still searched every
indexer from the home connection: the torrent sites logged the home address and
every query, and the ISP saw which sites were being visited. Sonarr and Radarr
only ever talk to Prowlarr, so Prowlarr is the one place to fix it.

gluetun has an HTTP proxy built in. `HTTPPROXY: "on"` starts it on port 8888
inside the tunnel, and `HTTPPROXY_STEALTH: "on"` stops it adding proxy headers.
It is reachable as `gluetun:8888` on the compose network and deliberately not
published on the host.

In Prowlarr: **Settings → Indexers → Indexer Proxies → Add → Http**, host
`gluetun`, port `8888`, tag `vpn`. Then give every indexer the `vpn` tag.

An indexer tagged for FlareSolverr (`cf`) cannot have both: Prowlarr applies a
single proxy per indexer, and FlareSolverr uses the normal connection. The only
one was 1337x, so it is disabled rather than left searching from the home
address. Knaben covers most of what it found. Moving FlareSolverr into gluetun's
namespace would fix it properly, but vpn-guard would then also have to restart
FlareSolverr after gluetun, and Cloudflare challenges VPN addresses harder
anyway. Until then, do not enable an indexer that needs FlareSolverr.

The old `6881` port mappings went at the same time. qBittorrent listens on the
forwarded port inside the tunnel, so 6881 on the host was an open port with
nothing behind it.

Verify from inside Prowlarr's container. The two `ip=` lines must differ, and
the second must match gluetun's public IP:

```bash
docker exec prowlarr curl -s https://www.cloudflare.com/cdn-cgi/trace | grep ^ip
docker exec prowlarr curl -s -x http://gluetun:8888 https://www.cloudflare.com/cdn-cgi/trace | grep ^ip
```

## Step 7.8 — Subtitle searches through the tunnel, and what still is not

Bazarr sends every subtitle search to the providers with the **release name**
in it (`Show.S01E04.720p.WEBRip.x264-GROUP`), from the home connection, and for
OpenSubtitles tied to your account. Of everything left outside the tunnel, that
said the most about what was downloaded.

Bazarr has a proxy setting, and it applies it as `HTTP_PROXY`/`HTTPS_PROXY`
with `NO_PROXY` from the exclusion list. **Settings → General → Proxy**: type
HTTP, host `gluetun`, port `8888`, and exclude the services it talks to inside
Docker, or those calls go out through the VPN and fail: `localhost`,
`127.0.0.1`, `sonarr`, `radarr`, `whisper`, `jellyfin`. In the config file that
is the `proxy:` block of `bazarr/config/config/config.yaml` (edit it only with
Bazarr stopped).

While you are there, turn off **Analytics** (`analytics: enabled: false`). It
posts usage statistics to Google Analytics.

An environment proxy is a request, not a kill switch: each library decides
whether to honour it. Verify by sampling Bazarr's connections during a search:

```bash
docker exec bazarr cat /proc/net/tcp    # remote addresses in hex; gluetun:8888 is ...:22B8
```

Here, during a movie subtitle search, 182 samples went to `gluetun:8888`, and
the internal ones to Sonarr, Radarr, Jellyfin and whisper. One went direct:
Bazarr's news feed (`announcements.json` from cdn.jsdelivr.net), which says
nothing about your media. OpenSubtitles kept working through the VPN.

**Still direct from home, on purpose:** metadata lookups by Jellyfin (TMDB,
TheTVDB, AniDB, AniList), Sonarr, Radarr and Seerr. They reveal which titles are
in the library, not where they came from, and moving them buys little. Your ISP
sees the names of those services, not what is downloaded.

**Lesson from this server:** set the tunnel up *before* the first download.
qBittorrent's log shows it announcing the home address for about a day and a
half after it was installed and before gluetun existed. Every torrent in that
window was shared from the home connection, and no later setting changes that.
To check your own history:

```bash
grep -h "Detected external IP" ~/homelab/qbittorrent/config/qBittorrent/logs/qbittorrent.log* | sort
```

A single unfamiliar address in that list can be a peer reporting a wrong one;
qBittorrent inside gluetun has no other way out.

---

[← Phase 6: Push notifications when a download finishes](06-push-notifications.md) · [All phases](README.md) · [Phase 8: Stop the server transcoding: prefer H.264 at grab time →](08-prefer-h264.md)
