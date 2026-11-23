// End-to-end tests: two real Chromium pages, the real production server,
// a real WebRTC data channel between them.
//
//   npm run build && npm run test:e2e
//
// Requires Playwright with a Chromium build (`require('playwright')` must
// resolve). Playwright is intentionally not a package dependency; if it is not
// installed the suite is skipped with a message rather than failing.
//
// The File System Access API save picker cannot be driven headlessly, so it is
// replaced by an in-page stub that records written bytes (and can be told to
// fail), or removed to exercise the in-memory download fallback.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

const ROOT = path.resolve(import.meta.dirname, '../..');
const skip = !chromium
  ? 'playwright is not installed'
  : !existsSync(path.join(ROOT, 'dist/server.cjs'))
    ? 'run `npm run build` first'
    : false;

let server;
let browser;
let base;
let workDir;

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

before(async () => {
  if (skip) return;
  workDir = mkdtempSync(path.join(tmpdir(), 'td-e2e-'));
  const port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn(process.execPath, ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('Server running')) {
        clearTimeout(t);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // Let two pages on one machine connect via plain host candidates.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/**
 * Install a fake showSaveFilePicker that collects bytes in window.__saved.
 * failAfterWrites: reject the Nth write (simulates a full disk).
 */
function fakeSavePicker({ failAfterWrites = Infinity } = {}) {
  return ({ failAfterWrites }) => {
    window.__saved = { chunks: [], closed: false, aborted: false, writes: 0 };
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (data) => {
          window.__saved.writes += 1;
          if (window.__saved.writes > failAfterWrites) {
            throw new DOMException('Not enough space', 'QuotaExceededError');
          }
          window.__saved.chunks.push(new Uint8Array(data.buffer ? data : data));
        },
        close: async () => { window.__saved.closed = true; },
        abort: async () => { window.__saved.aborted = true; },
      }),
    });
  };
}

async function savedBytes(page) {
  const b64 = await page.evaluate(() => {
    const parts = window.__saved.chunks;
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.byteLength; }
    let s = '';
    for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode(...all.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

/** Record every getUserMedia stream so tests can check tracks were stopped. */
function trackMedia() {
  window.__streams = [];
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await orig(c);
    window.__streams.push(s);
    return s;
  };
}

async function newPage(init = []) {
  const context = await browser.newContext({ acceptDownloads: true, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  for (const [fn, arg] of init) await page.addInitScript(fn, arg);
  return page;
}

async function pair({ senderInit = [], receiverInit = [] } = {}) {
  const sender = await newPage([[trackMedia], ...senderInit]);
  const receiver = await newPage([[trackMedia], ...receiverInit]);
  await sender.goto(base);
  await sender.locator('.loader-screen').waitFor({ state: 'detached' });
  await sender.getByRole('button', { name: /Send files/ }).click();
  const pin = sender.locator('.pin-box strong');
  await pin.filter({ hasText: /^[0-9A-F]{6}$/ }).waitFor();
  const code = await pin.textContent();
  await receiver.goto(`${base}/?room=${code}`);
  await sender.locator('.chat-room-container').waitFor();
  await receiver.locator('.chat-room-container').waitFor();
  return { sender, receiver };
}

async function close(...pages) {
  for (const p of pages) await p.context().close().catch(() => {});
}

function fileSub(page, name) {
  return page.locator('.file-bubble', { hasText: name }).locator('.file-sub');
}

async function sendFile(page, filePath) {
  await page.locator('.composer input[type=file]').setInputFiles(filePath);
}

function makeFile(name, bytes) {
  const p = path.join(workDir, name);
  writeFileSync(p, bytes);
  return p;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('successful transfer: receiver verifies, sender shows delivered only after ack', { skip, timeout: 60000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    const data = randomBytes(5 * 1024 * 1024 + 123);
    const file = makeFile('ok.bin', data);
    await sendFile(sender, file);
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(receiver, 'ok.bin').filter({ hasText: 'received' }).waitFor({ timeout: 30000 });
    await fileSub(sender, 'ok.bin').filter({ hasText: 'delivered' }).waitFor({ timeout: 30000 });
    const saved = await savedBytes(receiver);
    assert.equal(saved.length, data.length);
    assert.equal(sha(saved), sha(data));
    assert.equal(await receiver.evaluate(() => window.__saved.closed), true);
    // Writes were batched, not one per 16 KB chunk.
    assert.ok(await receiver.evaluate(() => window.__saved.writes) < 20);
  } finally {
    await close(sender, receiver);
  }
});

test('in-memory fallback download has the exact bytes and a safe name', { skip, timeout: 60000 }, async () => {
  const noPicker = () => { delete window.showSaveFilePicker; };
  const { sender, receiver } = await pair({ receiverInit: [[noPicker]] });
  try {
    const data = randomBytes(300 * 1024);
    const file = makeFile('report.pdf', data);
    await sendFile(sender, file);
    const download = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: 'Accept' }).click();
    const dl = await download;
    assert.equal(dl.suggestedFilename(), 'report.pdf');
    const got = readFileSync(await dl.path());
    assert.equal(sha(got), sha(data));
    await fileSub(sender, 'report.pdf').filter({ hasText: 'delivered' }).waitFor({ timeout: 20000 });
  } finally {
    await close(sender, receiver);
  }
});

test('zero-byte file completes', { skip, timeout: 60000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    await sendFile(sender, makeFile('empty.txt', Buffer.alloc(0)));
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(receiver, 'empty.txt').filter({ hasText: 'received' }).waitFor({ timeout: 20000 });
    await fileSub(sender, 'empty.txt').filter({ hasText: 'delivered' }).waitFor({ timeout: 20000 });
  } finally {
    await close(sender, receiver);
  }
});

test('receiver disk write failure is reported on both sides, never as success', { skip, timeout: 60000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), { failAfterWrites: 1 }]] });
  try {
    await sendFile(sender, makeFile('big.bin', randomBytes(8 * 1024 * 1024)));
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(receiver, 'big.bin').filter({ hasText: /failed — Could not write/ }).waitFor({ timeout: 30000 });
    await fileSub(sender, 'big.bin').filter({ hasText: /failed/ }).waitFor({ timeout: 30000 });
    assert.doesNotMatch(await fileSub(sender, 'big.bin').textContent(), /delivered/);
    // The partial file was discarded, not left behind.
    await receiver.waitForFunction(() => window.__saved.aborted === true);
    assert.equal(await receiver.evaluate(() => window.__saved.closed), false);
  } finally {
    await close(sender, receiver);
  }
});

test('declining an offer is reflected on the sender and the next file proceeds', { skip, timeout: 60000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    await sender.locator('.composer input[type=file]').setInputFiles([
      makeFile('first.bin', randomBytes(1000)),
      makeFile('second.bin', randomBytes(2000)),
    ]);
    await fileSub(receiver, 'first.bin').filter({ hasText: 'pending acceptance' }).waitFor();
    await receiver.getByRole('button', { name: 'Decline' }).click();
    await fileSub(sender, 'first.bin').filter({ hasText: 'declined' }).waitFor();
    await fileSub(receiver, 'second.bin').filter({ hasText: 'pending acceptance' }).waitFor();
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(sender, 'second.bin').filter({ hasText: 'delivered' }).waitFor({ timeout: 20000 });
  } finally {
    await close(sender, receiver);
  }
});

test('sender cancellation mid-transfer reaches the receiver', { skip, timeout: 90000 }, async () => {
  // A slow fake disk is irrelevant here; we just need a file big enough that
  // the cancel lands while bytes are still moving.
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    await sendFile(sender, makeFile('cancel.bin', randomBytes(400 * 1024 * 1024)));
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(sender, 'cancel.bin').filter({ hasText: /sending — \d+%/ }).waitFor({ timeout: 30000 });
    await sender.locator('.file-bubble', { hasText: 'cancel.bin' }).locator('..').getByRole('button', { name: 'Cancel' }).click();
    await fileSub(sender, 'cancel.bin').filter({ hasText: 'cancelled' }).waitFor({ timeout: 20000 });
    await fileSub(receiver, 'cancel.bin').filter({ hasText: 'cancelled' }).waitFor({ timeout: 20000 });
    await receiver.waitForFunction(() => window.__saved.aborted === true);
  } finally {
    await close(sender, receiver);
  }
});

test('receiver disconnecting mid-transfer fails the transfer on the sender', { skip, timeout: 90000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    await sendFile(sender, makeFile('drop.bin', randomBytes(400 * 1024 * 1024)));
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(sender, 'drop.bin').filter({ hasText: /sending — \d+%/ }).waitFor({ timeout: 30000 });
    await close(receiver);
    await fileSub(sender, 'drop.bin').filter({ hasText: /failed/ }).waitFor({ timeout: 45000 });
    assert.doesNotMatch(await fileSub(sender, 'drop.bin').textContent(), /delivered/);
  } finally {
    await close(sender, receiver);
  }
});

test('chat goes over the data channel and is not marked as relayed', { skip, timeout: 60000 }, async () => {
  const { sender, receiver } = await pair();
  try {
    // Make sure the data channel is up: a file round trip needs it.
    await sendFile(sender, makeFile('ping.txt', Buffer.from('ping')));
    await fileSub(receiver, 'ping.txt').waitFor();
    await sender.locator('.msg-input').fill('hello over p2p');
    await sender.getByRole('button', { name: 'Send message' }).click();
    const bubble = receiver.locator('.row.in', { hasText: 'hello over p2p' });
    await bubble.waitFor();
    assert.doesNotMatch(await bubble.textContent(), /via server relay/);
  } finally {
    await close(sender, receiver);
  }
});

test('ending a video call stops every camera and microphone track on both sides', { skip, timeout: 60000 }, async () => {
  const { sender, receiver } = await pair();
  try {
    await sendFile(sender, makeFile('warmup.txt', Buffer.from('x')));
    await fileSub(receiver, 'warmup.txt').waitFor();
    await sender.getByRole('button', { name: 'Video call' }).click();
    await receiver.locator('.incoming-call-overlay').getByRole('button', { name: 'Accept' }).click();
    await sender.locator('.call-stage .call-timer', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
    await receiver.locator('.call-stage .call-timer', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
    await sender.getByRole('button', { name: 'End call' }).click();
    for (const p of [sender, receiver]) {
      await p.locator('.call-stage').waitFor({ state: 'detached', timeout: 15000 });
      await p.waitForFunction(() =>
        window.__streams.length > 0 &&
        window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
    }
  } finally {
    await close(sender, receiver);
  }
});

test('losing the peer during a call ends it and releases media', { skip, timeout: 90000 }, async () => {
  const { sender, receiver } = await pair();
  try {
    await sendFile(sender, makeFile('warmup2.txt', Buffer.from('x')));
    await fileSub(receiver, 'warmup2.txt').waitFor();
    await sender.getByRole('button', { name: 'Audio call' }).click();
    await receiver.locator('.incoming-call-overlay').getByRole('button', { name: 'Accept' }).click();
    await sender.locator('.call-stage .call-timer', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
    await close(receiver);
    await sender.locator('.call-stage').waitFor({ state: 'detached', timeout: 45000 });
    await sender.waitForFunction(() =>
      window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
    await sender.locator('.sys-note', { hasText: /connection lost|ended/ }).first().waitFor();
  } finally {
    await close(sender, receiver);
  }
});
