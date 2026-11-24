#!/usr/bin/env node
/**
 * Lend a faster computer to convert-8bit.py.
 *
 * The server converts 10-bit anime to 8-bit one file at a time on its own CPU,
 * which on old hardware takes days for a big library. This takes files off the
 * same list while it runs: it asks the server for the next one (the server
 * marks it taken, so the two never do the same file), downloads it over ssh,
 * encodes it here with the exact settings the server uses, and sends it back.
 * The server then runs its usual checks (same tracks, same length, really
 * 8-bit) before anything is replaced, so a bad copy from here changes nothing.
 *
 * Needs ssh access to the server (the same as for deploying) and ffmpeg on
 * PATH. The encoder runs at idle priority, so this computer stays usable; on
 * Windows it also keeps the computer from going to sleep while it works.
 * Stop it with Ctrl+C: the file in hand is given back to the server.
 *
 *   node scripts/convert-8bit-helper.mjs <ssh host of the server>
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const host = process.argv[2];
if (!host) {
  console.error('usage: node convert-8bit-helper.mjs <ssh host of the server>');
  process.exit(2);
}
const REMOTE = process.env.CONVERT_8BIT_REMOTE || 'python3 ~/homelab-scripts/convert-8bit.py';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const ME = os.hostname().replace(/[^\w.-]/g, '') || 'helper';
const work = mkdtempSync(path.join(os.tmpdir(), 'convert-8bit-'));
const input = path.join(work, 'in.mkv');
const output = path.join(work, 'out.mkv');

const log = (msg) => console.log(`${new Date().toLocaleTimeString()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (file) => Math.round(statSync(file).size / 1e6);

/** Run a command; stdin/stdout may be file paths (binary-safe). */
function run(cmd, args, { stdin, stdout, priority } = {}) {
  return new Promise((resolve) => {
    const inFd = stdin ? openSync(stdin, 'r') : 'ignore';
    const outFd = stdout ? openSync(stdout, 'w') : 'pipe';
    const child = spawn(cmd, args, { stdio: [inFd, outFd, 'pipe'], windowsHide: true });
    if (priority !== undefined) {
      try { os.setPriority(child.pid, priority); } catch { /* best effort */ }
    }
    let out = '', err = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      if (typeof inFd === 'number') closeSync(inFd);
      if (typeof outFd === 'number') closeSync(outFd);
      resolve({ code: code ?? 1, out: out.trim(), err: err.trim() });
    });
  });
}

// A connection that dies (this computer slept, the network dropped) should
// fail within two minutes, not hang a transfer for hours.
const SSH = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-o', 'BatchMode=yes'];
const remote = (args, io) => run('ssh', [...SSH, host, `${REMOTE} ${args}`], io);

// Windows sleeps an idle computer, locked or not; a long encode does not count
// as activity. Ask it to stay awake for as long as this runs, the same request
// a video player makes. Nothing is changed in the power settings.
// The flag is ES_CONTINUOUS | ES_SYSTEM_REQUIRED written in decimal: PowerShell
// reads 0x80000001 as a negative int, the call then fails, and the computer
// slept mid-file. The call answers the previous state, which is never 0; 0 or
// no answer means it did not take, and that is said out loud.
let awake = null;
if (process.platform === 'win32') {
  awake = spawn('powershell', ['-NoProfile', '-Command',
    'Add-Type -Name P -Namespace W -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);\';'
    + ' [W.P]::SetThreadExecutionState(2147483649); while ($true) { Start-Sleep 3600 }'],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let answered = false;
  awake.stdout.on('data', (d) => {
    if (!answered) {
      answered = true;
      log(Number(String(d).trim()) ? 'keeping this computer awake while converting'
        : 'WARNING: could not keep this computer awake; it may sleep mid-file');
    }
  });
  awake.stderr.on('data', (d) => log(`WARNING: keep-awake: ${String(d).trim().split('\n')[0]}`));
}

let current = null;
function stop() {
  if (current) {
    log('giving the current file back to the server');
    spawnSync('ssh', [...SSH, host, `${REMOTE} --release ${current}`], { stdio: 'ignore' });
  }
  awake?.kill();
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if ((await run(FFMPEG, ['-hide_banner', '-version'])).code) {
  console.error(`${FFMPEG} not found: install ffmpeg or set FFMPEG to its path`);
  stop();
}

let done = 0;
for (;;) {
  const c = await remote(`--claim ${ME}`);
  if (c.code) {
    log(`could not reach the server: ${c.err || c.code}; trying again in 5 minutes`);
    await sleep(300_000);
    continue;
  }
  if (!c.out) {
    log(`nothing left to convert (${done} done here)`);
    break;
  }
  const { id, name, args } = JSON.parse(c.out);
  current = id;

  log(`fetching  ${name}`);
  const got = await remote(`--send ${id}`, { stdout: input });
  if (got.code) {
    log(`fetch failed: ${got.err}; giving it back`);
    await remote(`--release ${id}`);
    current = null;
    await sleep(60_000);
    continue;
  }

  // The server chooses the settings (convert-8bit.py encode_args), so a file
  // looks the same whichever computer converted it.
  log(`encoding  ${name} (${mb(input)} MB)`);
  const started = Date.now();
  const enc = await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    ...args, output],
  { priority: os.constants.priority.PRIORITY_LOW });

  if (enc.code) {
    // Nothing is sent: the server records the file as failed ("no output") and
    // leaves it alone until it changes, instead of handing it out again.
    log(`encoding failed: ${enc.err.split('\n').slice(-2).join(' ')}`);
  } else {
    log(`sending   ${name} (${mb(output)} MB, encoded in ${Math.round((Date.now() - started) / 60000)} min)`);
    const sent = await remote(`--receive ${id}`, { stdin: output });
    if (sent.code) {
      log(`send failed: ${sent.err}; giving it back`);
      await remote(`--release ${id}`);
      current = null;
      await sleep(60_000);
      continue;
    }
  }
  const fin = await remote(`--finish ${id}`);
  current = null;
  log(fin.out || fin.err || `finish answered ${fin.code}`);
  if (!fin.code) done++;
  rmSync(input, { force: true });
  rmSync(output, { force: true });
}
stop();
