#!/usr/bin/env bash
# Watch the house from outside it.
#
# Every alert the homelab can raise travels through Uptime Kuma and ntfy, both
# of which run on the machine being watched. When that machine dies - power
# cut, kernel panic - the alarm dies with it and you find out from a family
# member. This runs on the relay VPS instead, which fails independently.
#
# It reports through ntfy.sh (the public service) rather than the ntfy at home,
# for the same reason. Only a one-line status message leaves; the topic name is
# the secret, so keep it random.
set -uo pipefail

TOPIC="${HOME_WATCH_TOPIC:-CHANGE_ME}"
PEER_IP="10.77.0.2"                  # the homelab end of the relay tunnel
STALE_AFTER=300                      # seconds without a handshake = down
STATE=/var/lib/home-watch.state
REMIND_EVERY=3600                    # while down, repeat at most this often

now=$(date +%s)
mkdir -p "$(dirname "$STATE")"
prev_state=$(cut -d' ' -f1 "$STATE" 2>/dev/null || echo unknown)
prev_alert=$(cut -d' ' -f2 "$STATE" 2>/dev/null || echo 0)

# 1. is the tunnel alive? (a handshake older than STALE_AFTER means it is not)
handshake=$(wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}' | sort -rn | head -1)
handshake=${handshake:-0}
age=$(( now - handshake ))
[ "$handshake" -eq 0 ] && age=999999

# 2. does the reverse proxy at home actually answer through it?
tcp_ok=no
timeout 8 bash -c "echo > /dev/tcp/$PEER_IP/443" 2>/dev/null && tcp_ok=yes

if [ "$age" -lt "$STALE_AFTER" ] && [ "$tcp_ok" = yes ]; then
  state=up
  detail="tunnel ${age}s ago, npm answering"
else
  state=down
  detail="handshake ${age}s ago, npm tcp=${tcp_ok}"
fi

notify() {  # notify <title> <message> <priority> <tags>
  curl -s -o /dev/null --max-time 20 \
    -H "Title: $1" -H "Priority: $3" -H "Tags: $4" \
    -d "$2" "https://ntfy.sh/$TOPIC" || true
}

if [ "$state" = down ]; then
  if [ "$prev_state" != down ] || [ $(( now - prev_alert )) -ge "$REMIND_EVERY" ]; then
    notify "Homelab unreachable" "The relay cannot reach home: $detail" 5 rotating_light
    prev_alert=$now
  fi
elif [ "$prev_state" = down ]; then
  notify "Homelab back" "The relay can reach home again: $detail" 3 white_check_mark
  prev_alert=0
fi

echo "$state $prev_alert $(date -Is) $detail" > "$STATE"
