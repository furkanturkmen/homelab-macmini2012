# Phase 10 — Optional: public links for friends, through a relay VPS

**Skip this phase if Netbird ([Phase 5](05-netbird.md)) does what you need.** Netbird stays the
way you and anyone you install it for reach the whole homelab. This phase adds
something Netbird cannot: a normal `https://` address that family and friends
open in a browser or the Jellyfin app, with nothing to install. The two run
side by side.

> **Status:** built and verified end to end, with Jellyfin and Seerr both
> public.

## Why a relay VPS and not the alternatives

| Option | What your ISP sees | Catch |
|--------|--------------------|-------|
| Netbird only ([Phase 5](05-netbird.md)) | an encrypted mesh | every viewer needs the Netbird app |
| Open port 443 at home | every visitor's IP, the hostname, how much you stream | your home IP is public in DNS |
| Cloudflare Tunnel | traffic to Cloudflare | Cloudflare decrypts everything, and its terms do not allow streaming video |
| **Relay VPS** | **one WireGuard flow to the VPS** | a small monthly cost |

The VPS never runs Jellyfin and never holds a certificate. It reads the
requested hostname from each TLS handshake and passes the still-encrypted
connection down a WireGuard tunnel that the homelab opened outwards. Nothing is
forwarded on the home router.

```
friend ──https──> VPS :443 ──WireGuard──> wg-relay ──> relay-forward ──> npm ──> jellyfin
                  (reads SNI,              (home, outbound tunnel)          └──> seerr-guard ──> Seerr
                   checks country)
at home: Pi-hole answers the same name with the LAN IP, so home traffic stays home
```

The bottleneck is not the VPS: the smallest plan relays far more than one old
iGPU can transcode. Pick by price, not specs.

## Step 10.1 — Rent the VPS

Requirements: **KVM** virtualisation (container-based VPSes often cannot load
WireGuard), a **dedicated IPv4**, and Ubuntu LTS. The cheapest tier of most EU
hosts is enough.

This setup uses **STRATO VPS Linux S** (1 vCore, 2 GB, 60 GB NVMe, KVM,
dedicated IPv4, unlimited traffic, about €4/month in September 2026).
OVHcloud VPS-1, netcup and Hetzner work the same way. Compare the renewal price,
not the first-months promotion.

At checkout:

- **Order as a private customer.** At STRATO a consumer can cancel monthly
  after the first term; a business customer has to cancel before each yearly
  renewal.
- **Skip the SSL and backup add-ons.** The certificates are issued at home by
  npm (Let's Encrypt), and the VPS only holds a few config files that this
  phase recreates in minutes.
- **Untick optional marketing consent.** It shares personal data with ad
  partners, which defeats the point of the exercise.
- Read the provider's **acceptable-use terms**. Relaying your own service to
  people who have accounts on it is ordinary hosting. The clauses to check are
  the ones on anonymisation services, on handing the server to anonymous third
  parties, and on copyright complaints, which let a host suspend a server.

In the install form pick the **plain Ubuntu LTS image**, not the Plesk or app
variants. The web-console password field may accept letters and digits only;
a 24-character random one is strong regardless. After any reboot the web
console shows `login:`. That's normal, there is no need to log in there.

The VPS provider sees what your ISP would otherwise have seen: visitors' IPs,
the hostname and how much data flows. It does not see what anyone watches,
because TLS ends at home.

Log in with a key only. If the provider's install form takes a public key,
paste it there.

> ⚠️ **A web form can silently corrupt a pasted key.** One provider's form
> inserted a space in the middle of the key, and the result was a plain
> `Permission denied (publickey)` with no other hint. If that happens and your
> keys are on GitHub, log in once through the provider's web console and run
> `ssh-import-id gh:<your-github-user>`. It fetches the keys directly.

## Step 10.2 — Harden the VPS and install the pieces

```bash
apt update && apt upgrade -y
apt install -y wireguard-tools nginx libnginx-mod-stream libnginx-mod-stream-geoip2 mmdb-bin ufw
rm /etc/nginx/sites-enabled/default

ufw default deny incoming
ufw allow 22/tcp
ufw allow 80/tcp       # certificate checks only - see Step 10.4
ufw allow 443/tcp
ufw allow 51820/udp
ufw enable
```

Confirm `sshd -T | grep passwordauthentication` prints `no`, then reboot once
so the updates take effect.

## Step 10.3 — The tunnel

**VPS side:** generate a key and create `/etc/wireguard/wg0.conf` from
[`relay/vps-wg0.conf.example`](../relay/vps-wg0.conf.example), then
`systemctl enable --now wg-quick@wg0`.

**Home side:** no WireGuard install on the host is needed. The `wg-relay`
container holds the tunnel, and two tiny `socat` containers share its network
namespace (the same pattern as qBittorrent inside gluetun) to pass ports 443
and 80 on to npm.

1. Generate the home key and write `wg-relay/wg_confs/wg0.conf` from
   [`relay/home-wg0.conf.example`](../relay/home-wg0.conf.example). `wg-relay/`
   is gitignored, so the private key never reaches the repo.
2. Enable the optional services in `.env`:
   ```
   COMPOSE_PROFILES=relay
   ```
   Without that line `docker compose up -d` leaves all three containers out,
   which is what someone running only Netbird wants.
3. `docker compose up -d`
4. Add the home public key as a peer in the VPS config, then check:
   ```bash
   wg show wg0            # on the VPS: "latest handshake: N seconds ago"
   ping -c3 10.77.0.2     # the home end answers
   ```

`wg-relay` sits on a Docker network of its own (`relay`, `172.31.77.0/24` in
`docker-compose.yml`), and npm joins that network as well as the default one.
This is not tidiness; Step 10.5 depends on it. Tunnel visitors must reach npm
from an address outside the default Docker network, or Jellyfin cannot tell
them apart from the services that run next to it.

## Step 10.4 — Forward only the public names

Two nginx configs on the VPS:

- [`relay/stream-relay.conf.example`](../relay/stream-relay.conf.example):
  port 443. It passes TLS through by hostname, only for visitors from the
  countries you list, and drops everything else.
- [`relay/acme-relay.conf.example`](../relay/acme-relay.conf.example): port 80.
  It forwards only `/.well-known/acme-challenge/`, so npm can obtain
  certificates, and redirects everything else to HTTPS.

**The country filter** cuts out almost all of the internet's scanning and
password guessing before it reaches home. It is not a lock (a VPN in an
allowed country gets through), so accounts still need strong passwords. Let's
Encrypt checks from abroad, which is why port 80 has no country filter; it only
ever forwards the challenge path.

The country database is DB-IP's free one. Install
[`relay/update-geoip.example`](../relay/update-geoip.example) as
`/usr/local/sbin/update-geoip` (`chmod 755`) and **run it once before** adding
the stream config, since nginx will not start without the file. Then refresh it
monthly with two systemd units:

```ini
# /etc/systemd/system/update-geoip.service
[Unit]
Description=Refresh the country database for the relay filter
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/update-geoip

# /etc/systemd/system/update-geoip.timer
[Unit]
Description=Monthly country database refresh
[Timer]
OnCalendar=*-*-05 04:30
Persistent=true
RandomizedDelaySec=1h
[Install]
WantedBy=timers.target
```

`systemctl daemon-reload && systemctl enable --now update-geoip.timer`.

Someone travelling abroad is refused too. Add their country to the map for the
trip, then `nginx -t && systemctl reload nginx`.

Check from a machine outside your network:

```bash
openssl s_client -connect <VPS_IP>:443 -servername jellyfin.yourdomain.tld   # reaches npm
openssl s_client -connect <VPS_IP>:443 -servername anything.example          # dropped
curl -H "Host: sonarr.yourdomain.internal" http://<VPS_IP>/                  # no answer
```

And on the VPS itself, which the database places in no country:

```bash
curl -v --resolve jellyfin.yourdomain.tld:443:127.0.0.1 https://jellyfin.yourdomain.tld/   # dropped
tail /var/log/nginx/relay.log     # each line shows the visitor's country code
```

Before npm has a certificate for the name, the first command ends in
`tlsv1 unrecognized name`. That alert comes from npm at home, which proves the
whole path works.

The Host-header test matters most. npm serves its internal admin hosts on port
80, and the relay must never let an outside request reach them.

## Step 10.5 — Tell Jellyfin who is local

npm hands Jellyfin the visitor's address in `X-Forwarded-For`. Jellyfin only
believes that from a proxy it knows, and decides "local or remote" from the
result. Remote is what applies the remote bitrate cap and what an account
restricted to home sign-in is refused on.

Dashboard → Networking (or `POST /System/Configuration/network` with an API
key, which applies without a restart):

- **Known proxies:** `npm` (the container name; Jellyfin resolves it)
- **LAN networks:** your home subnet, e.g. `192.168.1.0/24`, **and** the default
  Docker network, e.g. `172.18.0.0/16`
  (`docker network inspect homelab_default` shows it)

Both parts of that second setting are needed, for opposite reasons:

- Leave the Docker network out and every container counts as remote.
  **Jellyfin enforces remote access on every request, not only at sign-in**,
  so jellylab-push and Seerr can then no longer act for an account that may
  only sign in from home. An administrator account restricted that way is
  locked out of every tool that runs in Docker.
- Put the tunnel on the default network instead of its own `relay` network
  (Step 10.3), and friends arriving through the VPS would count as local and
  skip the bitrate cap.

Check each path with Jellyfin's own answer (`IsInNetwork`):

```bash
K='Authorization: MediaBrowser Token="<jellyfin api key>"'
curl -s -H "$K" http://192.168.1.42:8096/System/Endpoint                  # LAN direct: true
curl -s -H "$K" -H "Host: jellyfin.yourdomain.internal" http://192.168.1.42/System/Endpoint   # through npm: true
docker run --rm --network homelab_default curlimages/curl -s -H "$K" http://jellyfin:8096/System/Endpoint   # containers: true
docker run --rm --network homelab_relay curlimages/curl -s -H "$K" -H "Host: jellyfin.yourdomain.internal" http://npm/System/Endpoint   # tunnel: false
```

To keep an administrator account off the relay entirely, turn off **Allow
remote connections** for it and use an ordinary account for watching. The
administrator still works at home and from every container.

## Step 10.6 — Names, certificates and the npm hosts

> ⚠️ **Set strong, unique passwords on every Jellyfin account first.** Every
> certificate is published in public Certificate Transparency logs
> (searchable on crt.sh), and bots watch those logs. A name gets its first
> login attempts within hours of its certificate, long before you share the
> link with anyone.

1. **DNS at the registrar:** an `A` record for each public name, pointing at
   the VPS IP. At STRATO a new subdomain points at STRATO's own web hosting
   until you choose **IP address of your own server** and enter the VPS IP.
   Wait until a public resolver agrees:
   `nslookup jellyfin.yourdomain.tld 9.9.9.9`.
2. **Pi-hole:** a local DNS record for each name, pointing at the Mac Mini's
   LAN IP. Home devices then go straight to npm instead of out to the VPS and
   back, and they count as local, which Steps 10.5 and 10.7 depend on for
   administrators.
3. **npm, one proxy host per name** (scheme `http`, **Websockets Support** and
   **Block Common Exploits** on):

   | Name | Forward hostname | Port |
   |------|------------------|------|
   | `jellyfin.yourdomain.tld` | `jellyfin` | `8096` |
   | `seerr.yourdomain.tld` | **`seerr-guard`**, never `jellyseerr` | `5055` |

   SSL tab: **Request a new Certificate** (HTTP challenge, leave **Use DNS
   Challenge** off). npm asks Let's Encrypt, which checks through the VPS's port
   80, so it only works once steps 1 and 10.4 are done.
4. **Open each host again** and turn on **Force SSL** and **HTTP/2**, then save.
   On npm 2.15 those switches were not stored when set in the same save that
   requested the certificate, and plain `http://` kept working at home.
5. Leave **HSTS** off until everything has settled. Browsers remember it for
   up to two years, so a mistake made while it is on is hard to undo.

npm renews the certificates on its own through the same port-80 path, so keep
`acme-relay` on the VPS.

Check from outside and from home:

```bash
echo | openssl s_client -connect <VPS_IP>:443 -servername jellyfin.yourdomain.tld 2>/dev/null \
  | openssl x509 -noout -subject -issuer -enddate     # CN=jellyfin.yourdomain.tld, Let's Encrypt
curl -sI http://jellyfin.yourdomain.tld/ | head -3     # 301 to https://
```

## Step 10.7 — Seerr on the relay: administrators stay home

Seerr checks a Jellyfin sign-in by asking Jellyfin from inside Docker, which
Jellyfin trusts as local (Step 10.5). So turning off **Allow remote
connections** for an administrator does not keep that account out of a public
Seerr, and a Seerr administrator can read every API key in its settings.

seerr-guard closes that gap (it runs even without content filters, [Phase 12](12-content-filters.md)).
It recognises a visitor who came through the relay by the last
`X-Forwarded-For` address npm adds, which lies in `RELAY_NETWORKS` (the compose
`relay` network), and there it refuses any account with admin, settings or
user-management rights:

- a sign-in answers `403 This account can only be used at home.`, the Seerr
  session it created is ended, and its cookie never reaches the visitor;
- a session started at home, or the API key (which always acts as user #1),
  is refused the same way.

**Manage Requests** alone is not refused, so an everyday account with that
permission can approve requests from anywhere.

In Seerr (Settings → General):

- **Application URL:** `https://seerr.yourdomain.tld`, so links in
  notifications work away from home.
- **Local (password) sign-in** (Settings → Users): off, when everyone signs in
  with Jellyfin (`POST /api/v1/settings/main` with `{"localLogin": false}` does
  the same). That leaves no Seerr-only passwords to guess; a Seerr sign-in then
  always ends at Jellyfin and its lockout (Step 10.8). The canary is unaffected,
  since it is checked through the API key, not a sign-in.
- **Default permissions** (Settings → Users) apply to everyone who signs in
  for the first time. Plain **Request** means requests wait for approval.

Check from outside (the key travels inside TLS to npm at home):

```bash
curl -s -H "X-Api-Key: <seerr api key>" https://seerr.yourdomain.tld/api/v1/auth/me
# {"message":"This account can only be used at home."}
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Api-Key: <seerr api key>" http://<mac-mini-ip>:5055/api/v1/auth/me   # 200 at home
```

## Step 10.8 — What family and friends need

Nothing to install, and no VPN. For each person:

1. A **Jellyfin account of their own** (Dashboard → Users → **+**) with a strong
   password, limited to the libraries they should see. The relay's country
   filter is not a lock; the password is.

   Set **Failed login attempts before user is locked out** (the user's profile
   page, or `LoginAttemptsBeforeLockout` in `POST /Users/<id>/Policy`) to e.g. `10` on **every** account, the administrator included. The
   default `-1` means *no lockout at all*: tested, five wrong passwords in a
   row changed nothing, while a limit of 3 disabled the account on the third.
   A locked account is re-enabled by an administrator. If the only
   administrator is the one locked, the API key still works:
   `POST /Users/<id>/Policy` with the user's policy and `"IsDisabled": false`.
   Do not call the administrator `admin`: it is the first name bots try, and
   they can lock it even when they cannot get in. Renaming it in Jellyfin
   changes nothing else, because Seerr links accounts by Jellyfin user id.
2. Two links:
   - `https://jellyfin.yourdomain.tld` to watch, in a browser or as the server
     address in any Jellyfin app;
   - `https://seerr.yourdomain.tld` to request. They sign in with the same
     Jellyfin username and password, and the first sign-in creates their Seerr
     account.
3. A request waits for approval (Step 10.7), Radarr or Sonarr downloads it, and
   it appears in Jellyfin.

Test once on mobile data with Wi-Fi and Netbird off. That is the only way to
see what a friend sees.

## Step 10.9 — Optional: WireGuard for your own devices

The public names are for watching and requesting. Managing the homelab from
away (the *arr apps, Portainer, Pi-hole, SSH, the administrator account) still
needs a VPN, and should: none of that belongs on the internet. Netbird
(Phase 5) does that job. This step is the alternative that runs entirely on
your own machines, through the relay you already have. Use one or the other.

```
phone ──WireGuard (UDP 51821)──> VPS ──wg0 tunnel──> wg-relay ──> wg-home (host) ──> LAN
         encrypted end to end: the VPS and wg-relay only pass it on, and hold no key
```

The server is **at home**, not on the VPS. A WireGuard hub on the VPS would be
simpler, but whoever gets into the VPS would then be on your LAN. This way the
VPS forwards packets it cannot read or forge.

1. **Home server.** Generate a key and write `wg-home/wg_confs/wghome.conf` from
   [`relay/home-wghome.conf.example`](../relay/home-wghome.conf.example)
   (`wg-home/` is gitignored), then `docker compose up -d wg-home`. It runs on
   the host network, in the `relay` profile, so devices arrive with their own
   tunnel address and reach the LAN the way a Netbird route does. It listens
   on 51821, because Netbird already has 51820.
2. **Home tunnel.** Add the "Step 10.9" lines from
   [`relay/home-wg0.conf.example`](../relay/home-wg0.conf.example) to
   `wg-relay/wg_confs/wg0.conf`, then restart it **and then** the forwarders:
   ```bash
   docker compose restart wg-relay
   docker compose restart relay-forward relay-forward-http
   ```
   The order matters. The forwarders live in wg-relay's network namespace, and
   restarting all three in one command started them before wg-relay: they kept
   the old, dead namespace and both public names were down until they were
   restarted again. It is the same reason the three are opted out of
   Watchtower. The UDP forward is the only thing wg-relay passes on; everything
   else from the VPS is still dropped.
3. **VPS.** Add the "Step 10.9" lines from
   [`relay/vps-wg0.conf.example`](../relay/vps-wg0.conf.example), then:
   ```bash
   echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-relay-forward.conf && sysctl -p /etc/sysctl.d/99-relay-forward.conf
   ufw route allow in on eth0 out on wg0 to 10.77.0.2 port 51821 proto udp
   systemctl restart wg-quick@wg0
   ```
   ufw's routed policy stays deny, so that one route is all the VPS forwards.
   Restarting wg0 drops the public names for a moment; the home end reconnects
   by itself within a couple of minutes.
4. **Jellyfin.** Add `10.78.0.0/24` to the LAN networks (Step 10.5), so your
   devices count as home: the administrator can sign in and no bitrate cap
   applies.
5. **Each device**, in the WireGuard app: create a tunnel from scratch and let
   the app **generate the key pair**; only the public key leaves the device.
   - Addresses `10.78.0.2/32` (the next device `.3`), DNS the Mac Mini's LAN IP
     (Pi-hole), **MTU `1340`**
   - Peer: the public key of `wghome.key`, endpoint `<VPS_IP>:51821`, allowed
     IPs `10.78.0.0/24, <your LAN subnet>`
   - On iOS, **On-Demand**: on for mobile data and for Wi-Fi *except* your home
     network, so it is only on when you are away.

   Add the device's public key as a `[Peer]` in `wghome.conf` and
   `docker compose restart wg-home`. A lost device is one block to delete.

The MTU leaves room for the wrapping: this tunnel travels inside the relay
tunnel, whose own MTU is 1420 and which adds up to 80 bytes, so 1340 fits
without fragmenting.

Check it at home:

```bash
docker exec wg-home wg show wghome   # "latest handshake" for each device
```

From the device, open `http://<mac-mini-ip>:8096`. With an API key,
`/System/Endpoint` there answers `"IsInNetwork":true`. This was tested with a throwaway client
going out to the VPS's public address and back in: handshake, the LAN, Pi-hole
and a 500 KB download at MTU 1340.

## Step 10.10 — The JellyLab app through the public names

The JellyLab app finds `jellylab-push` (free space, download progress, cancel)
on the Jellyfin address with port 8099. On a public `https://` name that port is
not reachable, and must not be: the service has no sign-in of its own, and
`/cancel` deletes a running download. So npm serves it on the public Jellyfin
name instead, and the service decides what a visitor from outside may do.

1. In npm, edit the Jellyfin proxy host → **Custom Locations** → add
   `/jellylab-push`, scheme `http`, host `jellylab-push`, port `8099`. Check
   afterwards that Force SSL is still on (Step 10.6).
2. `INTERNAL_NETWORKS` and `RELAY_NETWORKS` on `jellylab-push` in
   `docker-compose.yml` are the same as on seerr-guard. npm's custom location
   sets `X-Forwarded-For` to the connecting address itself, so a visitor cannot
   pretend to be at home.
3. A JellyLab build that uses `https://<name>/jellylab-push` for an `https`
   address without a port, and sends the Jellyfin token with its reads
   (jellylab PR #2).

What a visitor through the relay gets:

| | Outside | At home |
|---|---|---|
| Free space, download progress, filter names | with a Jellyfin sign-in | always |
| Cancel, stop a search, release check, app logs | refused ("Only available at home") | yes |
| The filter page | refused | yes |

```bash
B=https://jellyfin.yourdomain.tld/jellylab-push
curl -s -o /dev/null -w "%{http_code}\n" $B/storage                                 # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Emby-Token: <token>" $B/storage       # 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "X-Emby-Token: <token>" $B/cancel # 403
```

At home the service still asks for nothing, as before. Anyone on the LAN, or on
a mesh VPN you let reach port 8099, can cancel a download.

---

[← Phase 9: Catch a torrent that is not what it claims to be](09-torrent-guard.md) · [All phases](README.md) · [Phase 11: Encrypt Pi-hole's upstream DNS →](11-encrypted-dns.md)
