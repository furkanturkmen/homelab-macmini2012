# Subtitles

Bazarr on 6767, one provider, and two settings that between them decide whether
anything arrives at all.

| | |
|---|---|
| provider | `opensubtitlescom` only, account `the-furkan`, **VIP since 2026-08-30** |
| profile | `English + Dutch + Turkish`, `cutoff: None`, on all 36 titles |
| embedded | `use_embedded_subs: true` — a language already inside the file is never fetched again |

## The cutoff trap

**`cutoff` means "stop looking once you have this one".**

The profile was named `English + Dutch` and had `cutoff` pointing at English.
So Bazarr found an English subtitle, considered the title finished, and never
went looking for Dutch — for months, doing exactly what it was told. Nothing in
the library had Dutch unless the release shipped it embedded.

`cutoff: None` collects every language in the profile. There is no reason to
set a cutoff on a profile whose whole point is several languages.

## Count embedded tracks, or the library looks broken

`use_embedded_subs` is on, so Bazarr deliberately does **not** fetch a language
the file already carries. Counting sidecar `.srt` files alone is therefore
badly misleading:

```
by sidecar only        the entire anime shelf looks unsubtitled
counting both          en 30/33 titles · nl 24/33 · tr 28/33
```

Maleficent (2014) carries English SDH inside. Tokyo Ghoul and Steins;Gate carry
English fansubs. Now You See Me carries Turkish. All of those read as gaps from
the outside and are not.

```
scripts/subtitle-coverage.py            both, per title
scripts/subtitle-coverage.py --missing  only the real gaps
```

Genuine gaps are a handful of films short one language, plus Dutch on anime —
which barely exists on these providers and is unlikely to arrive.

## A stall is a file, not a mystery

```
ssh homelab "docker exec bazarr sh -c 'cat /config/config/throttled_providers.dat'"
```

`{}` is healthy. Anything else names the reason and the wall-clock time Bazarr
will wait until:

```
{'opensubtitlescom': ('DownloadLimitExceeded', datetime(2026, 8, 31, 3, 16), '6 hours')}
```

**Bazarr honours its own throttle even after the provider's real limit lifts.**
Buying VIP changed nothing until that file was cleared and Bazarr restarted —
it was still sitting out a six-hour penalty from the free tier. With one
provider, its throttle is the whole budget.

## No Japanese

Anime ships Japanese embedded rather than published separately, and
`use_embedded_subs` finds those tracks without asking anyone. Requesting it
externally spent a quarter of the budget on searches that could not land.

## Applying changes

`scripts/subtitle-languages.py`, dry-run by default:

```
python3 scripts/subtitle-languages.py                    # what it would change
python3 scripts/subtitle-languages.py --apply --search   # change it, then go looking
```

`--search` matters: adding a language does not backfill it. Bazarr only looks
when something asks, so without it the change appears to do nothing until the
next import.

## API notes

- Settings save by POSTing to `/api/system/settings`. List values need
  **repeated form fields** (`-d 'k=a' -d 'k=b'`), never a JSON string — a JSON
  string nests the list and silently disables every provider.
- Language profiles save through that same endpoint as `languages-profiles`,
  **not** through `/api/system/languages/profiles`, which is read-only (405).
- Providers that were tried and dropped: `yifysubtitles` served a *truncated*
  English sub (67 cues ending at 05:17 of a 20:45 film) and throttles
  constantly; `turkcealtyaziorg` needs an account. A partial sidecar looks
  exactly like a broken player — subtitles appear, then stop.
