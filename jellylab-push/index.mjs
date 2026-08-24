/**
 * jellylab-push — answers the questions about the homelab that the Jellylab
 * app needs and Jellyfin cannot.
 *
 * At present that is one question: how much room is left on the media drive.
 * Jellyfin has no API for it — it reports what is in the library, never what is
 * left to put there — and this container already has the media mount visible,
 * so a single statfs answers it.
 *
 * It used to also bridge ntfy to Expo Push, so notifications would arrive
 * inside the app rather than in ntfy's own app. That is gone. Native iOS push
 * needs the `aps-environment` entitlement, Apple only issues it to a paid
 * Developer Program account, and this build deliberately strips it (see
 * plugins/withoutPushEntitlement.js). Notifications go to the ntfy app, which
 * works and costs nothing. The name is kept because the container, the port and
 * the app's configured URL all refer to it; the bridge is recoverable from git
 * if a paid account ever makes it worth having.
 *
 * No npm dependencies on purpose — this is a stock node image with the file
 * mounted in. Nothing to build, nothing to keep patched.
 */

import { createServer } from 'node:http';
import { statfs } from 'node:fs/promises';

const {
  PUSH_PORT = '8099',
  MEDIA_PATH = '/media',
} = process.env;

const log = (...a) => console.log(new Date().toISOString(), ...a);

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true });
  }

  /**
   * Free space on the volume holding the media library.
   *
   * Unauthenticated on purpose: it is three numbers about disk space, on a
   * service reachable only over the LAN or the mesh VPN. Putting a secret in
   * front of it would mean the app shows nothing until that secret is
   * configured, for no gain worth having.
   */
  if (url.pathname === '/storage') {
    try {
      const s = await statfs(MEDIA_PATH);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      return send(res, 200, { total, free, used: total - free, path: MEDIA_PATH });
    } catch (err) {
      return send(res, 500, { error: `cannot read ${MEDIA_PATH}: ${err.message}` });
    }
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(Number(PUSH_PORT), () => log(`listening on :${PUSH_PORT}`));
