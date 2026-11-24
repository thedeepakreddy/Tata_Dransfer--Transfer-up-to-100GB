// Shared helpers for the Phase 1.5 validation campaign.
//
// Unlike the E2E suite (which fakes the save picker in memory), these helpers
// let the receiver write through Chrome's real FileSystemWritableFileStream into
// an on-disk browser profile (Origin Private File System), so the received file
// can be hashed straight from disk by Node.
//
// Requires: `npm run build` first, and Playwright with Chromium installed.

import { spawn, execFileSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { createWriteStream, createReadStream, mkdtempSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(import.meta.dirname, '../..');

export function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

export async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Start the production server (dist/server.cjs). Returns { proc, base, port, stop, logs }. */
export async function startServer(port) {
  port = port ?? (await freePort());
  const logs = [];
  const proc = spawn(process.execPath, ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    const check = () => {
      if (logs.join('').includes('Server running')) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout.on('data', check);
    proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
  const stop = () => new Promise((r) => {
    if (proc.exitCode !== null) return r();
    proc.once('exit', r);
    proc.kill();
  });
  return { proc, port, base: `http://localhost:${port}`, stop, logs };
}

/**
 * Write a deterministic pseudo-random file (AES-256-CTR keystream of zeros,
 * fixed key, IV derived from the size) and return its SHA-256. Same size =>
 * same bytes, on any machine, so results are reproducible.
 */
export async function makeDeterministicFile(filePath, size) {
  const key = Buffer.alloc(32, 0x5a);
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(size), 8);
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  const hash = createHash('sha256');
  const out = createWriteStream(filePath);
  const block = Buffer.alloc(4 * 1024 * 1024);
  let left = size;
  while (left > 0) {
    const n = Math.min(left, block.length);
    const chunk = cipher.update(block.subarray(0, n));
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    left -= n;
  }
  await new Promise((r) => out.end(r));
  return hash.digest('hex');
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

/** Find files of an exact size below a directory (used to locate the OPFS file on disk). */
export function findFilesBySize(dir, size) {
  const found = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { if (statSync(p).size === size) found.push(p); } catch { /* raced */ }
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * Total RSS (bytes) of the browser whose command line mentions `marker` (its
 * --user-data-dir) plus all of its descendants (renderer, GPU, network and
 * utility processes do not carry the profile path themselves).
 */
export function rssOfProcessesMatching(marker) {
  const procs = new Map(); // pid -> { ppid, rss, cmd }
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const ppid = Number(status.match(/PPid:\s+(\d+)/)?.[1]);
      const rss = Number(status.match(/VmRSS:\s+(\d+) kB/)?.[1] ?? 0) * 1024;
      procs.set(Number(pid), { ppid, rss, cmd: readFileSync(`/proc/${pid}/cmdline`, 'utf8') });
    } catch { /* process exited */ }
  }
  const roots = [...procs].filter(([, p]) => p.cmd.includes(marker) && !p.cmd.includes('--type=')).map(([pid]) => pid);
  const included = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, p] of procs) {
      if (!included.has(pid) && included.has(p.ppid)) { included.add(pid); grew = true; }
    }
  }
  let total = 0;
  for (const pid of included) total += procs.get(pid).rss;
  return total;
}

/** In-page: record every RTCPeerConnection so getStats() can prove the selected path. */
export function trackPeerConnections() {
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (...args) {
    const pc = new Orig(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Orig);
}

/**
 * In-page: replace showSaveFilePicker with a real OPFS file. Writes go through
 * Chrome's genuine FileSystemWritableFileStream (with its swap-file and
 * close/commit semantics). Optionally throttle writes to emulate a slow disk.
 */
export function opfsSavePicker({ throttleBytesPerSec = 0 } = {}) {
  window.__opfs = { writes: 0, bytes: 0, closed: false, aborted: false, name: null, maxPendingWrites: 0, pending: 0 };
  window.showSaveFilePicker = async ({ suggestedName } = {}) => {
    const root = await navigator.storage.getDirectory();
    const name = `${Date.now()}-${suggestedName || 'file'}`;
    window.__opfs.name = name;
    const handle = await root.getFileHandle(name, { create: true });
    return {
      createWritable: async () => {
        const w = await handle.createWritable();
        return {
          write: async (data) => {
            window.__opfs.pending += 1;
            window.__opfs.maxPendingWrites = Math.max(window.__opfs.maxPendingWrites, window.__opfs.pending);
            try {
              if (throttleBytesPerSec > 0) {
                await new Promise((r) => setTimeout(r, (data.byteLength / throttleBytesPerSec) * 1000));
              }
              await w.write(data);
              window.__opfs.writes += 1;
              window.__opfs.bytes += data.byteLength;
            } finally {
              window.__opfs.pending -= 1;
            }
          },
          close: async () => { await w.close(); window.__opfs.closed = true; },
          abort: async () => { await w.abort(); window.__opfs.aborted = true; },
        };
      },
    };
  };
}

/** Read the selected ICE candidate pair from the page's peer connection(s). */
export async function selectedPath(page) {
  return page.evaluate(async () => {
    for (const pc of (window.__pcs || []).slice().reverse()) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      let pairId = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      const pair = pairId ? stats.get(pairId) : null;
      if (!pair) continue;
      const l = stats.get(pair.localCandidateId);
      const rm = stats.get(pair.remoteCandidateId);
      return {
        local: l?.candidateType, remote: rm?.candidateType, protocol: l?.protocol,
        localAddressKind: l?.address?.startsWith('127.') ? 'loopback' : (l?.address ? 'other' : 'hidden'),
      };
    }
    return null;
  });
}

export async function jsHeap(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    await cdp.detach();
    return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null;
  } catch {
    return null;
  }
}

export function mb(bytes) {
  return bytes == null ? null : Math.round((bytes / 1048576) * 10) / 10;
}

export function chromiumVersion(chromium) {
  try {
    return execFileSync(chromium.executablePath(), ['--version']).toString().trim();
  } catch {
    return 'unknown';
  }
}

export const tmp = (prefix) => mkdtempSync(path.join(process.env.TD_WORKDIR || tmpdir(), prefix));
