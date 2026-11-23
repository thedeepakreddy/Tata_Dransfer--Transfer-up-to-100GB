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
    // Over-long messages are refused locally with a notice, not silently lost.
    await sender.locator('.msg-input').fill('z'.repeat(10001));
    await sender.getByRole('button', { name: 'Send message' }).click();
    await sender.locator('.sys-note', { hasText: 'longer than 10,000 characters' }).waitFor();
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

// ---------------------------------------------------------------------------
// Additional coverage: sender disconnect, receiver cancel, chat fallback,
// session restore, and a scripted (hostile) peer sending malformed, duplicate
// and out-of-order protocol messages to the real app.
// ---------------------------------------------------------------------------

test('sender disconnecting mid-transfer fails the transfer on the receiver', { skip, timeout: 90000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    await sendFile(sender, makeFile('sdrop.bin', randomBytes(400 * 1024 * 1024)));
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(receiver, 'sdrop.bin').filter({ hasText: /receiving — \d+%/ }).waitFor({ timeout: 30000 });
    await close(sender);
    await fileSub(receiver, 'sdrop.bin').filter({ hasText: /failed/ }).waitFor({ timeout: 45000 });
    assert.doesNotMatch(await fileSub(receiver, 'sdrop.bin').textContent(), /received/);
    await receiver.waitForFunction(() => window.__saved.aborted === true);
  } finally {
    await close(sender, receiver);
  }
});

test('receiver cancellation mid-transfer reaches the sender', { skip, timeout: 90000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    await sendFile(sender, makeFile('rcancel.bin', randomBytes(400 * 1024 * 1024)));
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(receiver, 'rcancel.bin').filter({ hasText: /receiving — \d+%/ }).waitFor({ timeout: 30000 });
    await receiver.locator('.file-bubble', { hasText: 'rcancel.bin' }).locator('..').getByRole('button', { name: 'Cancel' }).click();
    await fileSub(receiver, 'rcancel.bin').filter({ hasText: 'cancelled' }).waitFor({ timeout: 20000 });
    await fileSub(sender, 'rcancel.bin').filter({ hasText: 'cancelled' }).waitFor({ timeout: 20000 });
    await receiver.waitForFunction(() => window.__saved.aborted === true);
  } finally {
    await close(sender, receiver);
  }
});

test('chat falls back to the signalling relay without WebRTC and is labelled as relayed', { skip, timeout: 60000 }, async () => {
  // No peer connection can be created, so the data channel never opens.
  const noWebRTC = () => {
    window.RTCPeerConnection = class { constructor() { throw new Error('WebRTC blocked for test'); } };
  };
  const { sender, receiver } = await pair({ senderInit: [[noWebRTC]], receiverInit: [[noWebRTC]] });
  try {
    await sender.locator('.msg-input').fill('relayed hello');
    await sender.getByRole('button', { name: 'Send message' }).click();
    const inBubble = receiver.locator('.row.in', { hasText: 'relayed hello' });
    await inBubble.waitFor({ timeout: 15000 });
    assert.match(await inBubble.textContent(), /via server relay/);
    const outBubble = sender.locator('.row.out', { hasText: 'relayed hello' });
    assert.match(await outBubble.textContent(), /via server relay/);
    // The UI no longer claims blanket end-to-end encryption.
    assert.doesNotMatch(await receiver.locator('.conn-note').textContent(), /End-to-End/i);
  } finally {
    await close(sender, receiver);
  }
});

test('a reloaded sender reclaims its seat with its token and can transfer again', { skip, timeout: 90000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    await sendFile(sender, makeFile('before.txt', Buffer.from('before')));
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(sender, 'before.txt').filter({ hasText: 'delivered' }).waitFor({ timeout: 20000 });
    const saved = await sender.evaluate(() => JSON.parse(sessionStorage.getItem('td:session')));
    assert.ok(saved.token, 'seat token stored for reloads');
    await sender.reload();
    // Same room, no "Room is full": the sender lands back in the chat room.
    await sender.locator('.chat-room-container').waitFor({ timeout: 30000 });
    assert.equal(await sender.locator('.alert.err').count(), 0);
    await sendFile(sender, makeFile('after.txt', Buffer.from('after reload')));
    await receiver.locator('.file-bubble', { hasText: 'after.txt' }).locator('..').getByRole('button', { name: 'Accept' }).click();
    await fileSub(sender, 'after.txt').filter({ hasText: 'delivered' }).waitFor({ timeout: 30000 });
  } finally {
    await close(sender, receiver);
  }
});

/**
 * Turn a blank page into a scripted peer speaking the wire protocol directly:
 * it joins the room over the real signalling server, negotiates a real
 * RTCPeerConnection, and exposes the data channel as window.__dc and every
 * received control message in window.__inbox.
 */
async function scriptedPeer(roomId, role) {
  const page = await newPage();
  await page.goto(`${base}/api/health`);
  await page.evaluate(({ roomId, role }) => new Promise((resolve, reject) => {
    window.__inbox = [];
    const ws = new WebSocket(`ws://${location.host}/signaling`);
    let pc;
    const setupDc = (dc) => {
      dc.binaryType = 'arraybuffer';
      window.__dc = dc;
      dc.onmessage = (e) => { if (typeof e.data === 'string') window.__inbox.push(JSON.parse(e.data)); };
      const opened = () => {
        dc.send(JSON.stringify({ type: 'name_exchange', userName: 'Script', proto: 2 }));
        resolve();
      };
      if (dc.readyState === 'open') opened(); else dc.onopen = opened;
    };
    const makePc = () => {
      pc = new RTCPeerConnection();
      pc.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', payload: e.candidate })); };
      pc.ondatachannel = (e) => setupDc(e.channel);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', roomId, role }));
    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ready' && msg.isInitiator) {
        makePc();
        setupDc(pc.createDataChannel('fileTransfer', { ordered: true }));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'offer', payload: offer }));
      } else if (msg.type === 'offer') {
        makePc();
        await pc.setRemoteDescription(msg.payload);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', payload: answer }));
      } else if (msg.type === 'answer') {
        await pc.setRemoteDescription(msg.payload);
      } else if (msg.type === 'ice-candidate') {
        try { await pc.addIceCandidate(msg.payload); } catch { /* ignore */ }
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    };
    setTimeout(() => reject(new Error('scripted peer never connected')), 20000);
  }), { roomId, role });
  return page;
}

const dcSend = (page, msg) => page.evaluate((m) => window.__dc.send(JSON.stringify(m)), msg);
const dcSendBytes = (page, n) => page.evaluate((n) => window.__dc.send(new Uint8Array(n).fill(7)), n);
const inbox = (page) => page.evaluate(() => window.__inbox);
const waitInbox = (page, pred) => page.waitForFunction(pred, null, { timeout: 15000 });

test('receiver rejects malformed, duplicate, premature and oversized messages from a hostile sender', { skip, timeout: 90000 }, async () => {
  const room = 'EVIL01';
  // The scripted sender joins first (so it is the initiator); the real app
  // joins the same room as receiver.
  const evilReady = scriptedPeer(room, 'sender');
  await new Promise((r) => setTimeout(r, 500));
  const app = await newPage([[fakeSavePicker(), {}]]);
  const pageErrors = [];
  app.on('pageerror', (e) => pageErrors.push(e.message));
  await app.goto(`${base}/?room=${room}`);
  const evil = await evilReady;
  try {
    await app.locator('.chat-room-container').waitFor();

    // Malformed JSON, non-string chat text and a spoofed system notice: no crash, not rendered.
    await evil.evaluate(() => window.__dc.send('{not json'));
    await dcSend(evil, { type: 'chat', id: 'bad1', text: { boom: true } });
    await dcSend(evil, { type: 'chat', id: 'bad2', text: 'spoof', senderRole: 'system', isSystemMessage: true });
    await dcSend(evil, { type: 'chat', id: 'ok1', text: 'still alive' });
    await app.locator('.row.in', { hasText: 'still alive' }).waitFor();
    await app.locator('.row.in', { hasText: 'spoof' }).waitFor(); // shown as a normal peer message...
    assert.equal(await app.locator('.sys-note', { hasText: 'spoof' }).count(), 0); // ...never as a system notice

    // Invalid offers are ignored.
    await dcSend(evil, { type: 'meta', fileId: 'neg', name: 'neg.bin', size: -5, mimeType: 'x/y' });
    await dcSend(evil, { type: 'meta', fileId: '../../x', name: 'id.bin', size: 5, mimeType: 'x/y' });
    await dcSend(evil, { type: 'meta', fileId: 'nan', name: 'nan.bin', size: 'lots', mimeType: 'x/y' });

    // Overflow: path-traversal name, duplicate offer, chunks before accept, then too many bytes.
    await dcSend(evil, { type: 'meta', fileId: 'f1', name: '../../evil‮gpj.sh', size: 10, mimeType: 'text/plain' });
    await dcSend(evil, { type: 'meta', fileId: 'f1', name: 'dup.sh', size: 10, mimeType: 'text/plain' });
    await dcSendBytes(evil, 10); // before acceptance: must be dropped, not counted
    const f1 = app.locator('.file-bubble', { hasText: 'evilgpj.sh' });
    await f1.waitFor();
    assert.equal(await app.locator('.file-bubble', { hasText: 'dup.sh' }).count(), 0);
    assert.equal(await app.locator('.file-bubble', { hasText: /neg\.bin|id\.bin|nan\.bin/ }).count(), 0);
    await f1.locator('..').getByRole('button', { name: 'Accept' }).click();
    await waitInbox(evil, () => window.__inbox.some((m) => m.type === 'file-accept' && m.fileId === 'f1'));
    await dcSendBytes(evil, 20);
    await f1.locator('.file-sub').filter({ hasText: /failed — Received more data/ }).waitFor();
    await waitInbox(evil, () => window.__inbox.some((m) => m.type === 'file-cancel' && m.fileId === 'f1' && m.error === true));

    // Short file: EOF before all bytes -> failed, sender gets a negative ack.
    await dcSend(evil, { type: 'meta', fileId: 'f2', name: 'short.bin', size: 8, mimeType: 'x/y' });
    const f2 = app.locator('.file-bubble', { hasText: 'short.bin' });
    await f2.locator('..').getByRole('button', { name: 'Accept' }).click();
    await waitInbox(evil, () => window.__inbox.some((m) => m.type === 'file-accept' && m.fileId === 'f2'));
    await dcSendBytes(evil, 4);
    await dcSend(evil, { type: 'eof', fileId: 'f2' });
    await f2.locator('.file-sub').filter({ hasText: /failed — Incomplete file/ }).waitFor();
    await waitInbox(evil, () => window.__inbox.some((m) => m.type === 'file-ack' && m.fileId === 'f2' && m.ok === false));

    // Good file with a duplicate EOF and a stray EOF for an unknown id: exactly one positive ack.
    await dcSend(evil, { type: 'meta', fileId: 'f3', name: 'good.bin', size: 4, mimeType: 'x/y' });
    const f3 = app.locator('.file-bubble', { hasText: 'good.bin' });
    await f3.locator('..').getByRole('button', { name: 'Accept' }).click();
    await waitInbox(evil, () => window.__inbox.some((m) => m.type === 'file-accept' && m.fileId === 'f3'));
    await dcSendBytes(evil, 4);
    await dcSend(evil, { type: 'eof', fileId: 'f3' });
    await dcSend(evil, { type: 'eof', fileId: 'f3' });
    await dcSend(evil, { type: 'eof', fileId: 'nope' });
    await f3.locator('.file-sub').filter({ hasText: 'received' }).waitFor();
    await new Promise((r) => setTimeout(r, 500));
    const acks = (await inbox(evil)).filter((m) => m.type === 'file-ack' && m.fileId === 'f3');
    assert.deepEqual(acks, [{ type: 'file-ack', fileId: 'f3', ok: true, bytes: 4 }]);
    // A late duplicate meta for a finished file does not create a new offer.
    await dcSend(evil, { type: 'meta', fileId: 'f3', name: 'again.bin', size: 4, mimeType: 'x/y' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await app.locator('.file-bubble', { hasText: 'again.bin' }).count(), 0);

    // Re-offering a file the receiver already failed or declined is answered,
    // so a sender re-offering after a reconnect is never left waiting forever.
    await dcSend(evil, { type: 'meta', fileId: 'f1', name: 'retry.bin', size: 10, mimeType: 'x/y' });
    await waitInbox(evil, () => window.__inbox.filter((m) => m.type === 'file-cancel' && m.fileId === 'f1').length >= 2);
    await dcSend(evil, { type: 'meta', fileId: 'f4', name: 'nothanks.bin', size: 4, mimeType: 'x/y' });
    await app.locator('.file-bubble', { hasText: 'nothanks.bin' }).locator('..').getByRole('button', { name: 'Decline' }).click();
    await waitInbox(evil, () => window.__inbox.some((m) => m.type === 'file-decline' && m.fileId === 'f4'));
    await dcSend(evil, { type: 'meta', fileId: 'f4', name: 'nothanks.bin', size: 4, mimeType: 'x/y' });
    await waitInbox(evil, () => window.__inbox.filter((m) => m.type === 'file-decline' && m.fileId === 'f4').length >= 2);

    assert.deepEqual(pageErrors, []);
  } finally {
    await close(evil, app);
  }
});

test('sender rejects an invalid acknowledgment and ignores duplicate or late acks from a hostile receiver', { skip, timeout: 90000 }, async () => {
  const sender = await newPage();
  await sender.goto(base);
  await sender.locator('.loader-screen').waitFor({ state: 'detached' });
  await sender.getByRole('button', { name: /Send files/ }).click();
  const pin = sender.locator('.pin-box strong');
  await pin.filter({ hasText: /^[0-9A-F]{6}$/ }).waitFor();
  const evil = await scriptedPeer(await pin.textContent(), 'receiver');
  try {
    await sender.locator('.chat-room-container').waitFor();
    const accept = async (name) => {
      await evil.waitForFunction((n) => window.__inbox.some((m) => m.type === 'meta' && m.name === n), name, { timeout: 15000 });
      const meta = (await inbox(evil)).find((m) => m.type === 'meta' && m.name === name);
      await dcSend(evil, { type: 'file-accept', fileId: meta.fileId });
      await dcSend(evil, { type: 'file-accept', fileId: meta.fileId }); // duplicate accept: harmless
      await evil.waitForFunction((id) => window.__inbox.some((m) => m.type === 'eof' && m.fileId === id), meta.fileId, { timeout: 15000 });
      return meta;
    };

    // Wrong byte count in a positive ack -> failure, not "delivered".
    await sendFile(sender, makeFile('lie.bin', randomBytes(1000)));
    const m1 = await accept('lie.bin');
    await dcSend(evil, { type: 'file-ack', fileId: m1.fileId, ok: true, bytes: 999 });
    await fileSub(sender, 'lie.bin').filter({ hasText: /failed — Receiver confirmed a different size/ }).waitFor();
    // A later "correct" ack cannot revive it.
    await dcSend(evil, { type: 'file-ack', fileId: m1.fileId, ok: true, bytes: 1000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.match(await fileSub(sender, 'lie.bin').textContent(), /failed/);

    // Before the ack the sender says it is waiting, not delivered.
    await sendFile(sender, makeFile('fine.bin', randomBytes(2000)));
    const m2 = await accept('fine.bin');
    await fileSub(sender, 'fine.bin').filter({ hasText: 'waiting for confirmation' }).waitFor();
    await dcSend(evil, { type: 'file-ack', fileId: 'unknown', ok: true, bytes: 2000 }); // stray ack
    await dcSend(evil, { type: 'file-ack', fileId: m2.fileId, ok: true, bytes: 2000 });
    await dcSend(evil, { type: 'file-ack', fileId: m2.fileId, ok: false, reason: 'late' }); // late contradicting ack
    await fileSub(sender, 'fine.bin').filter({ hasText: 'delivered' }).waitFor();
    await new Promise((r) => setTimeout(r, 300));
    assert.match(await fileSub(sender, 'fine.bin').textContent(), /delivered/);
  } finally {
    await close(evil, sender);
  }
});

test('when the other device leaves, the remaining side shows disconnected promptly', { skip, timeout: 60000 }, async () => {
  const { sender, receiver } = await pair();
  try {
    await sendFile(sender, makeFile('hi.txt', Buffer.from('hi')));
    await fileSub(receiver, 'hi.txt').waitFor();
    await receiver.getByRole('button', { name: 'Back' }).click();
    // Well under the 20 s grace period: driven by the data channel closing.
    await sender.locator('.peer-status', { hasText: 'Disconnected' }).waitFor({ timeout: 8000 });
  } finally {
    await close(sender, receiver);
  }
});

test('a sender whose tab died without closing its connection is re-paired with a fresh handshake', { skip, timeout: 90000 }, async () => {
  const { sender, receiver } = await pair({ receiverInit: [[fakeSavePicker(), {}]] });
  try {
    await sendFile(sender, makeFile('one.txt', Buffer.from('one')));
    await receiver.getByRole('button', { name: 'Accept' }).click();
    await fileSub(sender, 'one.txt').filter({ hasText: 'delivered' }).waitFor({ timeout: 20000 });
    const session = await sender.evaluate(() => sessionStorage.getItem('td:session'));

    // Crash the renderer: no clean WebRTC shutdown, so the receiver's data
    // channel keeps reporting 'open' (like an OS-discarded mobile tab).
    const cdp = await sender.context().newCDPSession(sender);
    // The crashed page never answers, so don't wait for a reply.
    await Promise.race([cdp.send('Page.crash').catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    await close(sender);

    // The "reopened" tab: same saved session (room + seat token), new page load.
    const reopened = await newPage([[(s) => sessionStorage.setItem('td:session', s), session]]);
    try {
      await reopened.goto(base);
      await reopened.locator('.chat-room-container').waitFor({ timeout: 30000 });
      const t0 = Date.now();
      await sendFile(reopened, makeFile('two.txt', Buffer.from('two after reopen')));
      await receiver.locator('.file-bubble', { hasText: 'two.txt' }).locator('..').getByRole('button', { name: 'Accept' }).click();
      await fileSub(reopened, 'two.txt').filter({ hasText: 'delivered' }).waitFor({ timeout: 30000 });
      // Recovered by the new handshake, not by waiting out ICE timeouts.
      assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
    } finally {
      await close(reopened);
    }
  } finally {
    await close(sender, receiver);
  }
});
