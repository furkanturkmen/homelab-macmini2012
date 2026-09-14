#!/usr/bin/env python3
"""
Copy the per-user content filters out of the Seerr fork's database.

The fork kept each person's hidden TMDB keyword ids in user_settings.blockedTags
and their own "hide adult content" switch in user_settings.hideAdult - columns
stock Seerr does not have. Moving back to stock Seerr means those lists need a
home of their own first, so this writes them to the filter store the add-on
reads (jellylab-push-data/content-filters.json).

People are keyed by Jellyfin user id rather than Seerr's: Jellyfin is where the
filter is finally enforced, and the id survives a Seerr database being rebuilt.

With --check it also compares the result against what Jellyfin is enforcing
right now (the jellylab:kw:<id> markers in each person's BlockedTags), so the
copy can be trusted before anything depends on it.

Read-only against the database; only --out is written.
"""
import argparse
import datetime
import json
import os
import sqlite3
import sys
import tempfile
import urllib.request

LIVE_DB = os.path.expanduser('~/homelab/jellyseerr/config/db/db.sqlite3')
STORE = os.path.expanduser('~/homelab/jellylab-push-data/content-filters.json')
# server/lib/adultTags.ts in the fork. The container never overrode them
# (ADULT_TAG_IDS unset), so the defaults are what was in effect.
DEFAULT_ADULT_TAGS = [256466, 155477, 195669, 198385, 356759, 341367]
MARKER = 'jellylab:kw:'


def ids(raw):
    """blockedTags is stored as a JSON array of strings; accept a CSV too."""
    if not raw:
        return []
    try:
        values = json.loads(raw)
    except ValueError:
        values = raw.split(',')
    out = sorted({int(v) for v in values if str(v).strip().isdigit() and int(v) > 0})
    return out


def export(db_path):
    con = sqlite3.connect('file:%s?mode=ro' % db_path, uri=True)
    rows = con.execute(
        'SELECT u.id, u.jellyfinUsername, u.jellyfinUserId, s.blockedTags, s.hideAdult '
        'FROM user u LEFT JOIN user_settings s ON s.userId = u.id ORDER BY u.id'
    ).fetchall()
    users, skipped = {}, []
    for seerr_id, name, jf_id, blocked, hide_adult in rows:
        entry = {'name': name, 'seerrUserId': seerr_id,
                 'blockedTags': ids(blocked), 'hideAdult': bool(hide_adult)}
        if not entry['blockedTags'] and not entry['hideAdult']:
            continue
        if not jf_id:
            # A local Seerr account has no Jellyfin side to enforce on.
            skipped.append(name)
            continue
        users[jf_id] = entry
    return {
        'version': 2,
        'adultTags': DEFAULT_ADULT_TAGS,
        'users': users,
        'canary': None,
        'exportedFrom': 'seerr fork user_settings, %s' % datetime.datetime.now().isoformat(timespec='seconds'),
    }, skipped


def check(doc):
    key = os.environ.get('JELLYFIN_API_KEY')
    if not key:
        sys.exit('--check needs JELLYFIN_API_KEY in the environment (and JELLYFIN_URL if not local)')
    base = os.environ.get('JELLYFIN_URL', 'http://127.0.0.1:8096')
    req = urllib.request.Request(base + '/Users',
                                 headers={'Authorization': 'MediaBrowser Token="%s"' % key})
    people = json.load(urllib.request.urlopen(req, timeout=15))
    ok = True
    for person in people:
        enforced = sorted(int(t[len(MARKER):]) for t in (person['Policy'].get('BlockedTags') or [])
                          if t.startswith(MARKER) and t[len(MARKER):].isdigit())
        entry = doc['users'].get(person['Id'], {})
        wanted = set(entry.get('blockedTags', []))
        if entry.get('hideAdult'):
            wanted |= set(doc['adultTags'])
        same = sorted(wanted) == enforced
        ok &= same
        print('  %-8s exported=%-2d enforced in Jellyfin=%-2d %s' % (
            person['Name'], len(wanted), len(enforced), 'match' if same else 'MISMATCH'))
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--db', default=LIVE_DB)
    ap.add_argument('--out', help='write the store here (atomically); default: print')
    ap.add_argument('--check', action='store_true', help='compare against Jellyfin BlockedTags')
    args = ap.parse_args()

    doc, skipped = export(args.db)
    for name in skipped:
        print('skipped %s: filters set but no Jellyfin account' % name, file=sys.stderr)
    if args.out:
        folder = os.path.dirname(os.path.abspath(args.out))
        fd, tmp = tempfile.mkstemp(dir=folder, prefix='.content-filters.')
        with os.fdopen(fd, 'w') as fh:
            json.dump(doc, fh, indent=2)
            fh.write('\n')
        os.chmod(tmp, 0o644)
        os.replace(tmp, args.out)
        print('wrote %s: %d people' % (args.out, len(doc['users'])))
    else:
        json.dump(doc, sys.stdout, indent=2)
        print()
    if args.check and not check(doc):
        sys.exit(1)


if __name__ == '__main__':
    main()
