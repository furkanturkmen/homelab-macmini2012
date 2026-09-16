# Phase 6 — Push notifications when a download finishes

Get a push on your phone the moment Radarr or Sonarr imports something, plus
Seerr request events. Runs entirely on your own server; nothing is exposed to
the internet.

## Why ntfy and not the *arr apps' own notifiers

Radarr and Sonarr can post to Discord, Telegram and friends directly, but all
of those mean handing a third party your library activity. ntfy is a tiny
self-hosted push server with an iOS and Android app, and Seerr speaks it
natively.

## The one iOS catch

An iPhone cannot hold a background connection, so a self-hosted ntfy cannot
reach it on its own. The server config sets:

```
NTFY_UPSTREAM_BASE_URL: "https://ntfy.sh"
```

That forwards a **wake-up ping** through ntfy.sh so APNS can reach the phone.
Only a hash of the topic leaves your network — the message body is still
fetched from your own server. Without this, notifications only arrive while
the app is open.

Android does not need it.

## Step 6.1 — Start ntfy

Already in `docker-compose.yml`. Add three values to your `.env`:

```bash
# the topic name doubles as a shared secret - generate, do not pick
head -c 12 /dev/urandom | base64 | tr -dc 'a-z0-9' | head -c 16
head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20
```

```
NTFY_TOPIC=<first command's output, prefixed however you like>
NTFY_USER=homelab
NTFY_PASSWORD=<second command's output>
```

```bash
cd ~/homelab && docker compose up -d ntfy
```

## Step 6.2 — Lock the topic down

```bash
set -a; . ./.env; set +a
docker exec -e NTFY_PASSWORD="$NTFY_PASSWORD" ntfy ntfy user add --role=user "$NTFY_USER"
docker exec ntfy ntfy access "$NTFY_USER" "$NTFY_TOPIC" rw
docker exec ntfy ntfy access '*' "$NTFY_TOPIC" write-only
```

The last line is deliberate. Radarr, Sonarr and Seerr publish **without**
credentials, which keeps their configs free of secrets, but reading requires a
login — so nobody who stumbles on the topic can see your activity. The topic
name is the write secret, which is why it must be random.

Verify:

```bash
curl -s -o /dev/null -w "publish %{http_code}\n" -d test "http://localhost:8095/$NTFY_TOPIC"   # 200
curl -s -o /dev/null -w "read    %{http_code}\n" "http://localhost:8095/$NTFY_TOPIC/json?poll=1" # 403
```

## Step 6.3 — Radarr and Sonarr

Both run a small script on import. It lives in the app's own config directory,
which is gitignored, and reaches ntfy over the compose network rather than the
LAN — see `radarr/config/ntfy.sh` and `sonarr/config/ntfy.sh` on the server.

Wire it up in each app: **Settings → Connect → + → Custom Script**

- **Path:** `/config/ntfy.sh`
- Tick **On Import** and **On Upgrade**, leave the rest off
- **Test**, then Save

Custom Script rather than the Webhook connection on purpose: webhook posts raw
JSON, which arrives as a wall of braces. The script formats a readable line
using the `radarr_*` / `sonarr_*` environment variables the app sets.

## Step 6.4 — Seerr

**Settings → Notifications → ntfy**

- **Server URL:** `http://ntfy` (container name; no port needed)
- **Topic:** your `NTFY_TOPIC`
- Leave username and password empty — anonymous publish is allowed

Enable **Request Approved**, **Request Declined** and **Request Failed** only.

Deliberately leave **Media Available** off: Radarr and Sonarr already fire on
import, so enabling it here double-notifies every single download.

While you are in Seerr, check **Settings → General → Application URL** is set.
Empty means every notification it sends has a dead link in it.

## Uptime Kuma alerts (same topic)

Uptime Kuma shows red and green on its own page but alerts nobody until a
notification exists. Settings → Notifications → **Setup Notification**:

- **Notification Type:** ntfy
- **Server URL:** `http://ntfy`. Kuma is on the same Docker network, so the
  container name works and nothing leaves the host
- **Topic:** your `NTFY_TOPIC`
- **Priority:** 4. Kuma raises *down* alerts one step on its own
- **Authentication:** none. The topic is write-only for anonymous clients
  (Step 6.2), so no ntfy password ends up in Kuma's database
- Tick **Default enabled** and **Apply on all existing monitors**, then **Test**

## Step 6.5 — The phone

> **Native notifications inside your own iOS app need a paid Apple Developer
> account.** Apple gates the `aps-environment` entitlement behind Developer
> Program membership, and every background push to an iOS app goes through
> APNS. A free personal team cannot build with it, which is why the ntfy app
> exists: they paid for the entitlement so you do not have to. `jellylab-push`
> is built and working server-side either way, ready for the day you join.

1. Install **ntfy** from the App Store or Play Store
2. Settings → **Manage users** → add your server URL, `NTFY_USER`, `NTFY_PASSWORD`
3. **Subscribe to topic** → tick *Use another server* → enter the server URL and topic

Off-LAN this needs Netbird up, since the server is only reachable inside your
network. The wake-up still arrives via ntfy.sh, but fetching the message body
needs a route to the mini. [Step 6.7](#step-67--optional-reach-ntfy-without-the-vpn)
removes that requirement.

## What you end up with

| Event | Source | Example |
|-------|--------|---------|
| Movie imported | Radarr | `Movie added — Dune Part Two (2024), Bluray-1080p` |
| Episode imported | Sonarr | `Episode added — Frieren S01E12, WEBDL-1080p` |
| Quality upgrade | either | same, reading `upgraded` |
| Request approved / declined / failed | Seerr | request title |

---

## Step 6.6 — Native notifications in your own app (optional, needs a paid Apple account)

`jellylab-push` subscribes to the ntfy topic and forwards each event to Expo
Push, so notifications land in the jellylab app itself instead of the ntfy app.
It is running and tested end to end. It is also **parked**, for a reason worth
recording:

> Apple only issues the `aps-environment` entitlement to a **paid Developer
> Program** membership. Every background push to an iOS app goes through APNS,
> APNS requires that entitlement, and a free personal team cannot have it.
> `xcodebuild` refuses outright:
>
> ```
> Personal development teams do not support the Push Notifications capability
> Entitlements file defines "aps-environment" which is not registered
> ```
>
> This is exactly why the ntfy app exists: they hold the entitlement so you do
> not have to buy one. Nothing in this repo can work around it.

Because the app must still build on a free team, `jellylab` carries a local
config plugin (`plugins/withoutPushEntitlement.js`) that removes the
entitlement after `expo-notifications` adds it. Dropping the package from
`app.json` plugins is not enough — it applies its own plugin whenever
installed — and uninstalling it breaks the Metro bundle, since the `require`
is resolved statically.

**To turn it on later:** join the Developer Program, delete that plugin from
`app.json`, run `npx expo prebuild --clean`, rebuild. Then in the app:
Profile → Notifications → the `jellylab-push` address and
`PUSH_REGISTER_SECRET` → Test connection → toggle on. No code changes.

### How the bridge works

```
Radarr ─┐
Sonarr ─┼─▶ ntfy ─▶ jellylab-push ─▶ Expo Push ─▶ APNS ─▶ app
Seerr  ─┘
```

It subscribes to ntfy rather than taking webhooks directly, so the Radarr,
Sonarr and Seerr connections from Steps 6.3 and 6.4 stay untouched, and any
source added later reaches the app just by publishing to the same topic. ntfy
also keeps a browsable history that push notifications do not.

No npm dependencies: Node's global `fetch` covers both the ntfy stream and the
Expo API, so it runs on a stock `node:22-alpine` with `jellylab-push/index.mjs`
mounted in. Nothing to build, nothing to keep patched.

Health check, which needs no auth:

```bash
curl http://<ip>:8099/health     # {"ok":true,"devices":0}
```

`devices` is how many phones have registered. It stays 0 until the entitlement
exists.


---

## Step 6.7 — Optional: reach ntfy without the VPN

Needs [Phase 10](10-public-relay.md). Skip it if you always have the mesh VPN on.

**The symptom that sends you here:** pushes arrive, but instead of the message
you get a placeholder — a notification titled *ntfy* saying *message*. Nothing
is broken. ntfy.sh only relays a **wake-up ping**; the phone then fetches the
body from `NTFY_BASE_URL`, and if that address is only reachable over the VPN,
the fetch fails and iOS shows the placeholder. Turning the VPN on fills the
text in instantly, which is the quickest way to confirm the diagnosis.

Publishing it through the relay makes the body reachable from anywhere.

1. **DNS.** An A record for `push.yourdomain.tld` → your VPS. Some registrars
   point a new subdomain at their own hosting by default; change it to the
   VPS address, or Let's Encrypt cannot validate.
2. **VPS.** Add the name to the SNI allowlist and the port-80 acme
   `server_name` ([Step 10.4](10-public-relay.md), [Step 10.6](10-public-relay.md)).
3. **npm.** A proxy host → `ntfy`:`80`, **Websockets Support on** (ntfy
   subscribes over a long-lived stream), then request the certificate, then in
   a **second save** switch on Force SSL and HTTP/2 ([Step 10.6](10-public-relay.md)
   explains why it must be a second save).
4. **Refuse writes from outside.** In the host's **Advanced** tab:

   ```nginx
   if ($request_method !~ ^(GET|HEAD)$) {
       return 403;
   }
   ```

   Subscribing and fetching are `GET`; publishing is `POST`/`PUT`. Your own
   services publish over the Docker network and never through this host, so
   they are unaffected — while the anonymous write access from
   [Step 6.2](#step-62--lock-the-topic-down), which is safe on a private
   address, never becomes an open spam endpoint on a public one.

   > `limit_except GET { deny all; }` looks like the right tool and is not:
   > npm puts the Advanced block in `server` context, and `limit_except` is
   > only valid inside a `location`. nginx's config test rejects it.

5. **Point ntfy at the public name** and recreate it:

   ```
   NTFY_BASE_URL=https://push.yourdomain.tld
   ```
   ```bash
   docker compose up -d ntfy
   ```

6. **Re-subscribe on the phone.** ntfy derives the ntfy.sh wake-up topic from
   the base URL, so changing it **silently orphans the old subscription**. Add
   the new server under Manage users, set it as the default server, unsubscribe
   the old topic and subscribe again. Same topic name — no need to rotate it,
   because reads were already behind a login.

Verify, from a machine that is *not* on your LAN:

```bash
curl -s -o /dev/null -w "health      %{http_code}\n" https://push.yourdomain.tld/v1/health          # 200
curl -s -o /dev/null -w "publish     %{http_code}\n" -d x https://push.yourdomain.tld/$NTFY_TOPIC   # 403
curl -s -o /dev/null -w "read noauth %{http_code}\n" "https://push.yourdomain.tld/$NTFY_TOPIC/json?poll=1"  # 403
curl -s -u "$NTFY_USER:$NTFY_PASSWORD" "https://push.yourdomain.tld/$NTFY_TOPIC/json?poll=1" | tail -2      # the messages
```

> **Testing from the VPS itself will fail with `000`** if you added the country
> filter in [Step 10.4](10-public-relay.md) — the VPS drops its own request for
> being outside the allowed country. Test from a machine on the LAN instead,
> forcing the public path:
> `curl --resolve push.yourdomain.tld:443:<vps-ip> https://push.yourdomain.tld/v1/health`

Two limits to accept: with a country filter you are back to placeholders when
travelling abroad, and the anonymous write rule still exists inside ntfy — it
is only unreachable because npm refuses the method. Exposing ntfy by any other
route reopens it.
---

[← Phase 5: Remote access with Netbird](05-netbird.md) · [All phases](README.md) · [Phase 7: Route qBittorrent through a VPN →](07-qbittorrent-vpn.md)
