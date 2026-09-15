#!/usr/bin/env python3
"""
Keep qBittorrent's VPN tunnel whole, and repair it in the right order when not.

Written after gluetun spent twelve and a half hours half-broken. A DNS hiccup
failed its healthcheck, it began restarting the VPN, and hung at "stopping".
The tunnel itself kept carrying traffic, so nothing leaked and nothing looked
down - but port forwarding had been torn off first, so no peer could connect in
and downloads crawled. Docker marked the container unhealthy and does nothing
with that, and nothing else was watching.

Every run checks, from the host:

- gluetun is running and Docker calls it healthy;
- traffic from inside the tunnel leaves from an address that is not this
  household's own (checked against the host's own exit, both via Cloudflare's
  trace endpoint, so no DNS is involved);
- ProtonVPN has forwarded a port, and qBittorrent is listening on that port;
- qBittorrent answers and says it is connected.

Repairs, smallest first:

- only the port is wrong: push the forwarded port into qBittorrent with the same
  script gluetun uses (gluetun's own push fails when qBittorrent is restarting
  at that moment, which is how a port goes stale);
- anything else: restart gluetun, wait for it to be healthy with a forwarded
  port, then restart qBittorrent, then push the port. The order is not
  optional. qBittorrent lives in gluetun's network namespace, and a gluetun
  restart leaves it holding a namespace that no longer exists.

What it leaves alone:

- a qBittorrent that is not running: disk-guard stops it on purpose when the
  disk is nearly full, and restarting it would undo that;
- a gluetun started in the last few minutes: that is Watchtower or a person
  mid-update, and gluetun's own reconnect needs that long anyway;
- a failure seen only once: it has to be seen on two runs in a row, because a
  reconnect in progress looks exactly like a fault for a minute.

A repair happens at most once per COOLDOWN and at most MAX_REPAIRS times a day;
past that it only notifies, so a fault a restart cannot fix does not become a
restart loop that hides it.

If traffic in the tunnel ever leaves from the household's own address - which
the network namespace makes impossible - qBittorrent is stopped at once and it
says so. That is the one case worth acting on without a second look.

--dry-run reports and changes nothing. --repair runs the full restart once,
regardless of state, to prove the sequence works.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

COMPOSE_DIR = '/home/furkan/homelab'
ENV_FILE = f'{COMPOSE_DIR}/.env'
STATE_FILE = '/home/furkan/homelab-scripts/.vpn-guard-state.json'
VPN = 'gluetun'
QBIT = 'qbittorrent'
QB_API = 'http://127.0.0.1:8083/api/v2'  # from inside gluetun's namespace: no login needed
PORT_FILE = '/tmp/gluetun/forwarded_port'
PORT_SCRIPT = '/gluetun/update-qbit-port.sh'
TRACE = 'https://1.1.1.1/cdn-cgi/trace'

SETTLE_S = 300           # leave a freshly started gluetun alone this long
COOLDOWN_S = 20 * 60     # between repairs
MAX_REPAIRS = 4          # per rolling 24 hours
WAIT_HEALTHY_S = 240     # for gluetun to come back after a restart

DRY = '--dry-run' in sys.argv
FORCE = '--repair' in sys.argv


def log(msg):
    print(f"{time.strftime('%F %T')}  {msg}", flush=True)


def sh(*cmd, timeout=60):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except subprocess.TimeoutExpired:
        return 124, ''


def inspect(container, fmt):
    code, out = sh('docker', 'inspect', '-f', fmt, container)
    return out if code == 0 else ''


def in_vpn(*cmd, timeout=30):
    return sh('docker', 'exec', VPN, *cmd, timeout=timeout)


def qb(path):
    code, out = in_vpn('wget', '-qO-', '-T', '10', f'{QB_API}{path}')
    if code != 0 or not out:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def trace_ip(output):
    for line in output.splitlines():
        if line.startswith('ip='):
            return line[3:]
    return ''


def env(name):
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if line.startswith(f'{name}='):
                    return line.split('=', 1)[1].strip().strip('"\'')
    except OSError:
        pass
    return ''


def notify(title, body, priority='default', tags='shield'):
    topic, user, pw = env('NTFY_TOPIC'), env('NTFY_USER'), env('NTFY_PASSWORD')
    if not topic or DRY:
        return
    req = urllib.request.Request(f'http://localhost:8095/{topic}', data=body.encode(),
                                 headers={'Title': title, 'Priority': priority, 'Tags': tags})
    if user:
        req.add_header('Authorization', 'Basic ' + base64.b64encode(f'{user}:{pw}'.encode()).decode())
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        log(f'ntfy failed: {e}')


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'strikes': 0, 'repairs': []}


def save_state(state):
    if DRY:
        return
    tmp = STATE_FILE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def check():
    """What is wrong, as a list of short reasons, plus the facts behind them."""
    facts, problems = {}, []

    if inspect(QBIT, '{{.State.Running}}') != 'true':
        facts['qbittorrent'] = 'not running'
        return facts, problems  # disk-guard's decision, or a person's; not ours to undo

    facts['gluetun'] = inspect(VPN, '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}')
    if facts['gluetun'] != 'running/healthy':
        problems.append(f"gluetun is {facts['gluetun'] or 'missing'}")
        return facts, problems

    _, host_trace = sh('curl', '-s', '-m', '10', TRACE)
    _, vpn_trace = in_vpn('wget', '-qO-', '-T', '10', TRACE)
    facts['home_ip'], facts['vpn_ip'] = trace_ip(host_trace), trace_ip(vpn_trace)
    if not facts['vpn_ip']:
        problems.append('no traffic gets out through the tunnel')
    elif facts['home_ip'] and facts['vpn_ip'] == facts['home_ip']:
        problems.append('LEAK')

    _, port = in_vpn('cat', PORT_FILE)
    facts['forwarded_port'] = port if port.isdigit() else ''
    if not facts['forwarded_port']:
        problems.append('no forwarded port')

    prefs, transfer = qb('/app/preferences'), qb('/transfer/info')
    if prefs is None or transfer is None:
        problems.append('qBittorrent does not answer inside the tunnel')
        return facts, problems
    facts['listen_port'] = str(prefs.get('listen_port'))
    facts['connection'] = transfer.get('connection_status')
    if facts['forwarded_port'] and facts['listen_port'] != facts['forwarded_port']:
        problems.append(f"qBittorrent listens on {facts['listen_port']}, forwarded is {facts['forwarded_port']}")
    if facts['connection'] == 'disconnected':
        problems.append('qBittorrent reports disconnected')
    return facts, problems


def push_port(port):
    code, out = in_vpn(PORT_SCRIPT, port)
    return code == 0 and 'set to' in out


def wait_for_gluetun():
    deadline = time.time() + WAIT_HEALTHY_S
    while time.time() < deadline:
        time.sleep(10)
        if inspect(VPN, '{{if .State.Health}}{{.State.Health.Status}}{{end}}') == 'healthy':
            _, port = in_vpn('cat', PORT_FILE)
            if port.isdigit():
                return port
    return ''


def full_restart():
    """gluetun, then qBittorrent, then the port. Returns what happened."""
    steps = []
    sh('docker', 'compose', '--project-directory', COMPOSE_DIR, 'restart', VPN, timeout=180)
    port = wait_for_gluetun()
    steps.append(f'gluetun restarted, {"healthy with port " + port if port else "NOT healthy after " + str(WAIT_HEALTHY_S) + "s"}')
    sh('docker', 'compose', '--project-directory', COMPOSE_DIR, 'restart', QBIT, timeout=180)
    for _ in range(12):
        time.sleep(5)
        if qb('/transfer/info') is not None:
            break
    steps.append('qBittorrent restarted')
    if port:
        steps.append('port pushed' if push_port(port) else 'port push FAILED')
    return steps


def main():
    state = load_state()
    now = time.time()
    state['repairs'] = [t for t in state.get('repairs', []) if now - t < 86400]

    facts, problems = check()
    summary = ' '.join(f'{k}={v}' for k, v in facts.items() if k != 'home_ip')

    if 'LEAK' in problems:
        log(f'LEAK: tunnel traffic leaves from the home address - stopping qbittorrent ({summary})')
        if not DRY:
            sh('docker', 'compose', '--project-directory', COMPOSE_DIR, 'stop', QBIT, timeout=120)
        notify('VPN guard: qBittorrent stopped',
               'Traffic inside the VPN tunnel left from your home address. qBittorrent is stopped; '
               'start it again only after checking gluetun.', priority='urgent', tags='rotating_light')
        return

    if FORCE:
        log(f'--repair requested ({summary})')
        if DRY:
            return
        steps = full_restart()
        facts, problems = check()
        log(f"repair: {'; '.join(steps)} -> {'ok' if not problems else 'still: ' + ', '.join(problems)}")
        return

    if not problems:
        if state.get('strikes'):
            log(f'ok again without repair ({summary})')
        else:
            log(f'ok ({summary})')
        state['strikes'] = 0
        save_state(state)
        return

    try:
        started = datetime.fromisoformat(inspect(VPN, '{{.State.StartedAt}}')[:19]).replace(tzinfo=timezone.utc)
        age = now - started.timestamp()
    except ValueError:
        age = SETTLE_S + 1
    if age < SETTLE_S:
        log(f'not yet: gluetun started {int(age)}s ago ({", ".join(problems)})')
        return

    state['strikes'] = state.get('strikes', 0) + 1
    if state['strikes'] < 2:
        log(f'strike 1, looking again next run: {", ".join(problems)} ({summary})')
        save_state(state)
        return

    # The cheap fix first, and it needs no cooldown: it restarts nothing.
    only_port = len(problems) == 1 and problems[0].startswith('qBittorrent listens on')
    if only_port:
        if DRY:
            log(f'would push the forwarded port: {problems[0]}')
            return
        ok = push_port(facts['forwarded_port'])
        log(f"port push {'ok' if ok else 'FAILED, restarting instead'}: {problems[0]}")
        if ok:
            state['strikes'] = 0
            save_state(state)
            return

    last = max(state['repairs'], default=0)
    if now - last < COOLDOWN_S or len(state['repairs']) >= MAX_REPAIRS:
        log(f'not repairing (cooldown or daily limit): {", ".join(problems)} ({summary})')
        if len(state['repairs']) >= MAX_REPAIRS and not state.get('gave_up_notified'):
            notify('VPN guard: giving up for today',
                   f'{MAX_REPAIRS} repairs in 24 hours and still: {", ".join(problems)}. Needs a look.',
                   priority='high', tags='warning')
            state['gave_up_notified'] = True
        save_state(state)
        return

    if DRY:
        log(f"would restart gluetun then qbittorrent: {', '.join(problems)}")
        return

    state['repairs'].append(now)
    save_state(state)
    steps = full_restart()
    facts, after = check()
    result = 'ok' if not after else 'still: ' + ', '.join(after)
    log(f"repaired {', '.join(problems)}: {'; '.join(steps)} -> {result}")
    notify('VPN guard: tunnel repaired' if not after else 'VPN guard: repair did not fix it',
           f"Found: {', '.join(problems)}.\nDid: {'; '.join(steps)}.\nNow: {result}.",
           priority='default' if not after else 'high', tags='shield' if not after else 'warning')
    state['strikes'] = 0 if not after else state['strikes']
    if not after:
        state.pop('gave_up_notified', None)
    save_state(state)


if __name__ == '__main__':
    main()
