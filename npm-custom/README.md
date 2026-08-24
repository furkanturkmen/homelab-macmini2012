# Nginx Proxy Manager — custom includes

Tracked copies of the files that live at `npm/data/nginx/custom/` on the host
(`/data/nginx/custom/` inside the container). The live `npm/` tree is gitignored
runtime data, so these are the reviewable copy.

> The hostnames here read `jellyseerr.yourdomain.internal`, matching the rest of
> this repo. Substitute the names your own NPM serves before copying these in —
> the maps match on `$host` exactly, and a name that never matches makes the
> whole file a no-op. `http.conf` also proxies to `192.168.1.20:8082` — an
> example address for a development machine, not a real one.

**These are invisible in the NPM web UI.** NPM rewrites every file under
`proxy_host/` from its own database whenever a host is saved, but it only
*includes* the files under `custom/` and never reads or displays them. If a
proxied host behaves in a way the UI cannot account for, this directory is the
first place to look.

| File | Included at | Applies to |
|------|-------------|------------|
| `http.conf` | `http` context, once | the whole nginx instance |
| `server_proxy.conf` | end of every `server` block | **every** proxy host |

`server_proxy.conf` running for every host is why the directives in it are
written to be inert by default: each value comes from a map in `http.conf` that
returns the upstream's own header unless the request matches the one host and
origin it is meant for.

## What they currently do

Add CORS headers to **jellyseerr.yourdomain.internal** for requests from
`http://localhost:8082` and `http://127.0.0.1:8082` — the Expo dev server that
serves the JellyLab app when it is bundled for a desktop browser.

Jellyseerr sends no `access-control-*` headers of its own and answers preflight
`OPTIONS` with `405`, so a browser refuses every cross-origin read. Loading the
same URL in a tab works, because a top-level navigation is not a cross-origin
read — which makes the service look healthy while the app cannot use it. The
iOS app is unaffected either way: CORS is a browser rule.

Two things worth keeping in mind if you edit them:

- The origin is named rather than `*`, because Jellyseerr authenticates with a
  `connect.sid` cookie and a browser will not send credentials to a wildcard.
- Every map default echoes `$upstream_http_access_control_allow_*`. An empty
  value would mean "clear this header" to headers-more, which silently stripped
  Jellyfin's own `Access-Control-Allow-Origin: *` the first time round.

## The dev-preview host

`http.conf` also defines a `server {}` block for `jellylab.yourdomain.internal`,
proxying to an Expo web dev server on a laptop. It exists for one reason:
cookies.

Jellyseerr's `connect.sid` is an express-session cookie with no `SameSite`
attribute, which browsers treat as `Lax` and never send on a **cross-site**
request. A dev server on `http://localhost:8082` is a different site from
`jellyseerr.yourdomain.internal`, so the session is unusable there no matter how
correct the CORS headers are — the app signs in and then every authenticated
call comes back `401 cookie 'connect.sid' required`. Served from a name under
the same registrable domain, it is same-site, and the cookie travels.

`SameSite=None` would be the other way out, but it requires `Secure`, and a
`.internal` name can never hold a certificate.

Measured, same request, same session, only the origin differing:

| page served from | `GET /api/v1/request` |
|------------------|-----------------------|
| `http://localhost:8082` | `401 cookie 'connect.sid' required` |
| `http://jellylab.yourdomain.internal` | `200` with results |

It is deliberately not an NPM proxy host — NPM regenerates those from its
database, and this one points at a laptop that is usually off. It also needs a
DNS record (Pi-hole → the NPM host) for the name to resolve, and the upgrade
headers in the block are what keep Metro's hot reload working through the proxy.

## Install

```bash
docker exec npm mkdir -p /data/nginx/custom
docker cp npm-custom/http.conf          npm:/data/nginx/custom/http.conf
docker cp npm-custom/server_proxy.conf  npm:/data/nginx/custom/server_proxy.conf
docker exec npm nginx -t && docker exec npm nginx -s reload
```

## Verify

```bash
# the dev origin gets the headers
curl -sD - -o /dev/null -H "Origin: http://localhost:8082" \
  http://jellyseerr.yourdomain.internal/api/v1/status | grep -i access-control

# a preflight is answered by nginx, not passed to Jellyseerr
curl -sD - -o /dev/null -X OPTIONS -H "Origin: http://localhost:8082" \
  http://jellyseerr.yourdomain.internal/api/v1/auth/jellyfin | head -1   # 204

# any other origin, and any other host, are untouched
curl -sD - -o /dev/null -H "Origin: http://example.com" \
  http://jellyseerr.yourdomain.internal/api/v1/status | grep -ci access-control  # 0
curl -sD - -o /dev/null -H "Origin: http://localhost:8082" \
  http://jellyfin.yourdomain.internal/System/Info/Public | grep -i access-control  # *
```

## Remove

```bash
docker exec npm rm -f /data/nginx/custom/http.conf /data/nginx/custom/server_proxy.conf
docker exec npm nginx -t && docker exec npm nginx -s reload
```

Nothing else depends on them — removing both puts every host back to stock NPM
behaviour.
