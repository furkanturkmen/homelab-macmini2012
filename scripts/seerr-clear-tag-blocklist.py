#!/usr/bin/env python3
"""
Remove what Seerr's keyword crawler put on the blocklist, safely.

Stock Seerr refuses a BLOCKLISTED title to everyone, on the server. The
per-user filter fork used the crawler's global blocklist and undid that for
unfiltered people inside Seerr; stock Seerr does not, so before switching to
it every crawler-made entry has to go, or those titles become unrequestable
for the whole household.

Stock Seerr's own clean-up is not safe for this. Its cleanBlocklist deletes
the Media rows, and Media rows cascade to their requests. This does it the
way the fork did instead:

- blocklist rows the crawler made (blocklistedTags set) are deleted;
  hand-made entries (blocklistedTags empty) are kept;
- a Media row still marked BLOCKLISTED is deleted only when nothing refers to
  it - no request, issue or watchlist entry - and otherwise reset to
  UNKNOWN, so the next library scan can mark it available again;
- settings.json main.blocklistedTags is emptied so the crawler does not put
  it all back.

Seerr must be stopped: it caches settings and holds the database open.
Without --apply this only reports what it would do.
"""
import argparse
import json
import os
import sqlite3
import sys

BLOCKLISTED = 6
UNKNOWN = 1
REFERRERS = ('media_request', 'issue', 'watchlist')


def counts(con):
    one = lambda sql: con.execute(sql).fetchone()[0]
    return {
        'blocklist crawler rows': one('SELECT count(*) FROM blocklist WHERE blocklistedTags IS NOT NULL'),
        'blocklist hand-made rows': one('SELECT count(*) FROM blocklist WHERE blocklistedTags IS NULL'),
        'media BLOCKLISTED': one(f'SELECT count(*) FROM media WHERE status = {BLOCKLISTED} OR status4k = {BLOCKLISTED}'),
        'media total': one('SELECT count(*) FROM media'),
        'requests': one('SELECT count(*) FROM media_request'),
        'issues': one('SELECT count(*) FROM issue'),
        'watchlist': one('SELECT count(*) FROM watchlist'),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--config', required=True, help="Seerr's config directory (holds settings.json and db/db.sqlite3)")
    ap.add_argument('--apply', action='store_true', help='make the changes; without it, only report')
    ap.add_argument('--seerr-is-stopped', action='store_true', help='required with --apply')
    args = ap.parse_args()

    db_path = os.path.join(args.config, 'db', 'db.sqlite3')
    settings_path = os.path.join(args.config, 'settings.json')
    if args.apply and not args.seerr_is_stopped:
        sys.exit('refusing: stop Seerr first and pass --seerr-is-stopped')

    con = sqlite3.connect(db_path if args.apply else f'file:{db_path}?mode=ro', uri=not args.apply)
    con.execute('PRAGMA foreign_keys = ON')
    before = counts(con)

    blocked_ids = [r[0] for r in con.execute(f'SELECT id FROM media WHERE status = {BLOCKLISTED} OR status4k = {BLOCKLISTED}')]
    referenced = set()
    for table in REFERRERS:
        referenced.update(r[0] for r in con.execute(f'SELECT DISTINCT mediaId FROM {table} WHERE mediaId IS NOT NULL'))
    to_delete = [i for i in blocked_ids if i not in referenced]
    to_reset = [i for i in blocked_ids if i in referenced]

    settings = json.load(open(settings_path, encoding='utf-8'))
    tags = settings.get('main', {}).get('blocklistedTags')

    print('before:', json.dumps(before))
    print(f'plan: delete {before["blocklist crawler rows"]} crawler blocklist rows, '
          f'delete {len(to_delete)} unreferenced BLOCKLISTED media, reset {len(to_reset)} referenced ones to UNKNOWN, '
          f'clear main.blocklistedTags (now {tags!r})')

    if not args.apply:
        print('dry run: nothing changed (pass --apply --seerr-is-stopped to do it)')
        return

    with con:
        con.execute('DELETE FROM blocklist WHERE blocklistedTags IS NOT NULL')
        for chunk in range(0, len(to_delete), 500):
            ids = to_delete[chunk:chunk + 500]
            con.execute(f'DELETE FROM media WHERE id IN ({",".join("?" * len(ids))})', ids)
        for mid in to_reset:
            con.execute(f'UPDATE media SET status = CASE WHEN status = {BLOCKLISTED} THEN {UNKNOWN} ELSE status END, '
                        f'status4k = CASE WHEN status4k = {BLOCKLISTED} THEN {UNKNOWN} ELSE status4k END WHERE id = ?', (mid,))

    problems = con.execute('PRAGMA foreign_key_check').fetchall()
    integrity = con.execute('PRAGMA integrity_check').fetchone()[0]
    after = counts(con)
    con.close()

    settings.setdefault('main', {})['blocklistedTags'] = ''
    tmp = settings_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(settings, fh, indent=1)
    os.replace(tmp, settings_path)

    print('after: ', json.dumps(after))
    print('integrity:', integrity, '| foreign key problems:', len(problems))
    if after['requests'] != before['requests'] or after['issues'] != before['issues'] or after['watchlist'] != before['watchlist']:
        sys.exit('ERROR: requests, issues or watchlist changed - restore the backup')
    if integrity != 'ok' or problems:
        sys.exit('ERROR: database check failed - restore the backup')


if __name__ == '__main__':
    main()
