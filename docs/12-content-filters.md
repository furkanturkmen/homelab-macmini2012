# Phase 12 — Optional: per-user content filters (seerr-guard)

For households where some people should not see some titles. A person's filter
is a list of TMDB keywords (say, the adult keywords). Anything carrying one of
them disappears for that person in **both** Seerr and Jellyfin, in every app.
Nobody else notices anything.

Without any filters set up, seerr-guard is a transparent proxy and this phase
can be skipped.

```
browser / JellyLab app / Homarr / npm ──> seerr-guard :5055 ──> Seerr (stock, no published port)
jellylab-push ──> Seerr directly (API key) ──> Jellyfin BlockedTags, per person
                  both read jellylab-push-data/content-filters.json
```

## What a filtered person gets

- Hidden titles are gone from every list: discover, trending, search (including
  a person's "known for"), recommendations, collections and cast pages.
- A hidden title's page, its page data and its API answer **404**, even when the
  URL is typed in by hand.
- A request or watchlist add for a hidden title is refused.
- Nothing personal is ever cached: API answers and pages go out without ETag or
  Last-Modified and marked `no-store`, and a device's revalidation headers are
  not forwarded. Without that, a phone or browser used earlier by an unfiltered
  person revalidated its cached copy, Seerr answered 304, and the filtered
  person saw the unfiltered results. The canary checks this case too.
- In Jellyfin, `jellylab-push` stamps each title with `jellylab:kw:<keyword>`
  tags and puts each person's markers in their **BlockedTags**. Jellyfin then
  hides those titles in every client.

Decisions come from the keywords Seerr's own detail endpoint returns (cached for
30 days), so no TMDB key of its own is needed.

**It fails closed.** A title that has not been checked yet, a store file that
exists but cannot be parsed, or a caller Seerr cannot identify all mean
*hidden* for anyone who might be filtered. A missing store file means no filters
at all.

## Why not Seerr's own blocklist

Stock Seerr has a keyword blocklist, but it is global. A blocklisted title is
refused **to everyone**, on the server, so it cannot express "hidden for these
two people". An earlier version of this stack patched that into a fork of
Seerr, which then had to be rebased and rebuilt by hand on every release.
seerr-guard does the same job in front of stock Seerr, which updates like any
other image.

## Step 12.1 — Services

Already in `docker-compose.yml`:

- `jellyseerr` runs `ghcr.io/seerr-team/seerr:v3` and publishes **no port**.
  Anything that could reach Seerr directly would get around the filter.
- `seerr-guard` publishes `5055` in its place, so bookmarks, Homarr and the
  app keep working unchanged.

Add to `.env` (generate with `openssl rand -hex 24`):

```
FILTER_STORE_SECRET=...
```

In npm, point the Seerr proxy host at **`seerr-guard:5055`**, not
`jellyseerr:5055`. An npm host left on Seerr itself is a way around the filter.

## Step 12.2 — Set filters

Open `http://<mac-mini-ip>:8099/filters/admin` on the home network (the page and
its API refuse other networks, the mesh VPN included). Sign in with a Jellyfin
administrator, pick a person, and add keywords or turn on "hide adult content".
Seerr applies a change straight away; Jellyfin within minutes, or immediately
after the next sync.

The JellyLab app's own "Hide adult content" switch keeps working: seerr-guard
answers the fork's `blockedTags` / `hideAdult` settings fields from the store.

## Step 12.3 — The canary

A Seerr account with no permissions, filtered on one keyword. Uptime Kuma checks
through it that the filter still works, so a Seerr update that breaks it shows
up as an alert rather than as a child seeing something.

1. Create a local Seerr user (Users → Create Local User). New users get the
   default permissions (Request), so then set them to none:
   `PUT /api/v1/user/<id>` with `{"permissions": 0}`. With no request permission,
   even a broken guard cannot turn the canary's request check into a real
   request.
2. Add a `canary` block to `content-filters.json`: the user id, one keyword, a
   movie that the keyword's discover list really contains, and a clean movie.
   ```json
   "canary": { "seerrUserId": 7, "blockedTags": [256466], "hiddenTitle": "movie:1307118", "cleanTitle": "movie:603", "keywordId": 256466 }
   ```
3. Uptime Kuma: a **Keyword** monitor on `http://seerr-guard:5055/__guard/canary`
   expecting `ok`, every 30 minutes, with the ntfy notification. That URL
   answers only inside the Docker network.

## Step 12.4 — Updates

- The `v3` image tag follows 3.x releases only. Watchtower installs them
  overnight, and a 4.0 never arrives on its own.
- If an update changes what the guard relies on (a route, the `keywords` field),
  the canary monitor goes red.
- To move to a new major version, change the tag deliberately and watch the
  canary.

## The Seerr owner account

Seerr's API key always acts as **user #1**, the account created at first setup.
jellylab-push, seerr-guard, Homarr and the scripts all use the API key, so user
#1 must stay an administrator. Make it the administrator Jellyfin account, not
the account someone watches with.

If the everyday account got there first, swap which Jellyfin account each Seerr
user is linked to rather than demoting #1. Move that person's own requests
(`media_request.requestedById`) and their `user_settings` row along with them,
and end both users' sessions. Do it with Seerr stopped and a database backup
taken first.

## Coming from the Seerr fork

1. Back up `jellyseerr/config` and `jellylab-push-data`.
2. `scripts/export-fork-filters.py --out jellylab-push-data/content-filters.json --check`
   copies each person's filter out of the fork's database. `--check` compares
   the copy with what Jellyfin enforces now.
3. Stop Seerr, then run
   `scripts/seerr-clear-tag-blocklist.py --config jellyseerr/config --apply --seerr-is-stopped`.
   It removes the crawler's blocklist entries without touching requests.
   **Never use stock Seerr's own blocklist clean-up for this:** it deletes
   Media rows, and those cascade to their requests.
4. Switch the image, start `seerr-guard`, and repoint npm. Then run a full
   Jellyfin library scan in Seerr, so titles the crawler had marked
   blocklisted get their availability back.

## Verify

```bash
# is a title hidden for Seerr user 4? (inside the Docker network)
docker run --rm --network homelab_default curlimages/curl -s "http://seerr-guard:5055/__guard/decide?user=4&keys=movie:1307118,movie:603"
docker run --rm --network homelab_default curlimages/curl -s http://seerr-guard:5055/__guard/canary   # ok
curl -s http://<mac-mini-ip>:5055/__guard/health      # the LAN reaches the guard, not Seerr
docker logs seerr-guard | grep "404\|filter"         # one line per hidden title or filtered list
```

Tests: `node --test seerr-guard/test/filter.test.mjs seerr-guard/test/guard.test.mjs`
and `node --test jellylab-push/test/filters.test.mjs jellylab-push/test/routes.test.mjs`.

## Rollback

Stop `seerr-guard`, and give `jellyseerr` its `5055:5055` port back. Point npm
at `jellyseerr:5055` again. Filtering in Seerr stops; Jellyfin keeps hiding
what it already hid.

---

[← Phase 11: Encrypt Pi-hole's upstream DNS](11-encrypted-dns.md) · [All phases](README.md)
