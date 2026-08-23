/**
 * jellylab-push — turns homelab events into native push notifications inside
 * the Jellylab app.
 *
 * It subscribes to the ntfy topic rather than taking webhooks from Radarr,
 * Sonarr and Seerr directly. Those three are already publishing to ntfy and
 * tested, so this needs no changes to them, and any source added later reaches
 * the app for free just by publishing to the same topic. ntfy also keeps a
 * browsable history that push notifications do not.
 *
 * No npm dependencies on purpose — Node's global fetch covers both the ntfy
 * stream and the Expo Push API, so the container is a stock node image with
 * this file mounted in. Nothing to build, nothing to keep patched.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const {
  NTFY_URL = 'http://ntfy',
  NTFY_TOPIC,
  NTFY_USER,
  NTFY_PASSWORD,
  PUSH_REGISTER_SECRET,
  PUSH_PORT = '8099',
  DEVICES_FILE = '/data/devices.json',
} = process.env;

for (const [k, v] of Object.entries({ NTFY_TOPIC, NTFY_USER, NTFY_PASSWORD, PUSH_REGISTER_SECRET })) {
  if (!v) {
    console.error(`missing required env ${k}`);
    process.exit(1);
  }
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- device store

/** @type {Map<string, {platform?: string, addedAt: string}>} */
let devices = new Map();

async function loadDevices() {
  try {
    const raw = JSON.parse(await readFile(DEVICES_FILE, 'utf8'));
    devices = new Map(Object.entries(raw));
    log(`loaded ${devices.size} device(s)`);
  } catch {
    log('no device file yet, starting empty');
  }
}

async function saveDevices() {
  await mkdir(dirname(DEVICES_FILE), { recursive: true });
  await writeFile(DEVICES_FILE, JSON.stringify(Object.fromEntries(devices), null, 2));
}

// ------------------------------------------------------------------ expo push

/**
 * Expo caps a request at 100 messages. Tokens that come back as
 * DeviceNotRegistered are dropped: they belong to an app that was deleted or
 * reinstalled, and left in place they would fail on every future send.
 */
async function push({ title, body, data }) {
  const tokens = [...devices.keys()];
  if (tokens.length === 0) return;

  const dead = [];
  for (let i = 0; i < tokens.length; i += 100) {
    const chunk = tokens.slice(i, i + 100);
    const messages = chunk.map(to => ({
      to,
      title,
      body,
      sound: 'default',
      data: data ?? {},
    }));

    let json;
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      json = await res.json();
    } catch (err) {
      log('expo push failed:', err.message);
      continue;
    }

    const tickets = json?.data ?? [];
    tickets.forEach((ticket, idx) => {
      if (ticket?.status === 'error') {
        const reason = ticket?.details?.error;
        log(`push error for ${chunk[idx].slice(0, 24)}…: ${ticket.message}`);
        if (reason === 'DeviceNotRegistered') dead.push(chunk[idx]);
      }
    });
  }

  if (dead.length) {
    dead.forEach(t => devices.delete(t));
    await saveDevices();
    log(`dropped ${dead.length} unregistered device(s)`);
  }
}

// ----------------------------------------------------------------- ntfy stream

/**
 * ntfy's /json endpoint is a long-lived newline-delimited JSON stream. It is
 * expected to drop — server restart, network blip — so this reconnects rather
 * than treating an ended stream as fatal. `since=all` is deliberately not used:
 * on reconnect we only want new events, not a replay of the backlog as a burst
 * of notifications.
 */
async function streamNtfy() {
  const url = `${NTFY_URL}/${NTFY_TOPIC}/json`;
  const auth = 'Basic ' + Buffer.from(`${NTFY_USER}:${NTFY_PASSWORD}`).toString('base64');

  for (;;) {
    try {
      log(`connecting to ${url}`);
      const res = await fetch(url, { headers: { authorization: auth } });
      if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
      log('connected');

      let buffer = '';
      for await (const bytes of res.body) {
        buffer += Buffer.from(bytes).toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          // open/keepalive frames carry no payload
          if (msg.event !== 'message') continue;

          const title = msg.title || 'Homelab';
          const body = (msg.message || '').trim();
          if (!body) continue;

          log(`forwarding: [${title}] ${body.replace(/\n/g, ' | ').slice(0, 60)}`);
          await push({ title, body, data: { ntfyId: msg.id, tags: msg.tags ?? [] } });
        }
      }
      log('stream ended, reconnecting');
    } catch (err) {
      log('stream error:', err.message);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ----------------------------------------------------------------- http server

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e5) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, devices: devices.size });
  }

  // Registration is reachable from the LAN, so it needs a shared secret -
  // otherwise anything on the network could register a token and receive
  // every notification.
  if (req.headers.authorization !== `Bearer ${PUSH_REGISTER_SECRET}`) {
    return send(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'POST' && url.pathname === '/devices') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    const token = payload?.token;
    if (typeof token !== 'string' || !token.startsWith('ExponentPushToken')) {
      return send(res, 400, { error: 'expected an ExponentPushToken' });
    }
    devices.set(token, { platform: payload.platform, addedAt: new Date().toISOString() });
    await saveDevices();
    log(`registered ${token.slice(0, 28)}… (${devices.size} total)`);
    return send(res, 200, { ok: true, devices: devices.size });
  }

  if (req.method === 'DELETE' && url.pathname === '/devices') {
    const token = url.searchParams.get('token');
    if (token && devices.delete(token)) {
      await saveDevices();
      log(`unregistered ${token.slice(0, 28)}…`);
    }
    return send(res, 200, { ok: true, devices: devices.size });
  }

  if (req.method === 'POST' && url.pathname === '/test') {
    await push({ title: 'Jellylab', body: 'Test notification from your homelab', data: {} });
    return send(res, 200, { ok: true, sentTo: devices.size });
  }

  return send(res, 404, { error: 'not found' });
});

await loadDevices();
server.listen(Number(PUSH_PORT), () => log(`listening on :${PUSH_PORT}`));
streamNtfy();
