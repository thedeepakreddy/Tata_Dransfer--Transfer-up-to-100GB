// Phase 1.5 lifecycle / failure campaign: real Chromium pages, real production
// server, real WebRTC. Scenarios the Phase 1.0 E2E suite does not cover.
//
//   npm run build && npm run test:validation
//
// Some scenarios are SIMULATED and labelled as such:
//   - "backgrounding" uses Chrome's page lifecycle freeze (CDP
//     Page.setWebLifecycleState), which is what Chrome does to background
//     tabs; it is not a real mobile OS suspending the browser.
//   - the browser's native "Stop sharing" control is simulated by stopping the
//     capture track and firing its 'ended' event, which is what the app sees.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, loadPlaywright, startServer, freePort, trackPeerConnections, opfsSavePicker, selectedPath, tmp,
} from './harness.mjs';

const pw = loadPlaywright();
const required = process.env.npm_lifecycle_event === 'test:validation';
const missing = !pw ? 'playwright is not installed' : !existsSync(path.join(ROOT, 'dist/server.cjs')) ? 'run `npm run build` first' : null;
if (missing && required) {
  test('prerequisites', () => assert.fail(`Cannot run the validation suite: ${missing}`));
}
const skip = missing || false;

let browser;
let work;
before(async () => {
  if (skip) return;
  work = tmp('td-life-');
  browser = await pw.chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
});
after(async () => {
  await browser?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

function trackMedia() {
  window.__streams = [];
  window.__screens = [];
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => { const s = await gum(c); window.__streams.push(s); return s; };
  const gdm = md.getDisplayMedia.bind(md);
  md.getDisplayMedia = async (c) => { const s = await gdm(c); window.__screens.push(s); return s; };
}

async function newPage(init = []) {
  const ctx = await browser.newContext({ acceptDownloads: true, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  for (const [fn, arg] of [[trackPeerConnections], [trackMedia], ...init]) await page.addInitScript(fn, arg);
  return page;
}

async function openSender(base, init) {
  const sender = await newPage(init);
  await sender.goto(base);
  await sender.locator('.loader-screen').waitFor({ state: 'detached' });
  await sender.getByRole('button', { name: /Send files/ }).click();
  const pin = sender.locator('.pin-box strong');
  await pin.filter({ hasText: /^[0-9A-F]{6}$/ }).waitFor();
  return { sender, code: await pin.textContent() };
}

async function pair(base, { senderInit = [], receiverInit = [] } = {}) {
  const { sender, code } = await openSender(base, senderInit);
  const receiver = await newPage(receiverInit);
  await receiver.goto(`${base}/?room=${code}`);
  await sender.locator('.chat-room-container').waitFor();
  await receiver.locator('.chat-room-container').waitFor();
  return { sender, receiver, code };
}

const close = async (...pages) => { for (const p of pages) await p?.context().close().catch(() => {}); };
const sub = (page, name) => page.locator('.file-bubble', { hasText: name }).locator('.file-sub');
const bubbleBtn = (page, name, label) => page.locator('.file-bubble', { hasText: name }).locator('..').getByRole('button', { name: label });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeFile(name, bytes) {
  const p = path.join(work, name);
  writeFileSync(p, bytes);
  return p;
}
const sendFile = (page, p) => page.locator('.composer input[type=file]').setInputFiles(p);

/** Make sure the data channel is up (a full file round trip needs it). */
async function warmUp(sender, receiver, name = 'warm.txt') {
  await sendFile(sender, makeFile(name, Buffer.from('warm')));
  await sub(receiver, name).filter({ hasText: 'pending acceptance' }).waitFor();
  await bubbleBtn(receiver, name, 'Decline').click();
  await sub(sender, name).filter({ hasText: 'declined' }).waitFor();
}

async function freeze(page, ms) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await sleep(ms);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await cdp.detach();
}

// ---------------------------------------------------------------------------
// Signalling loss
// ---------------------------------------------------------------------------

test('L1 waiting sender keeps its QR code while signalling is down, then re-registers', { skip, timeout: 90000 }, async () => {
  const port = await freePort();
  let server = await startServer(port);
  const { sender, code } = await openSender(server.base);
  let receiver;
  try {
    await server.stop();
    await sleep(4000);
    // Still on the waiting screen with the same code; not an empty chat room.
    assert.equal(await sender.locator('.chat-room-container').count(), 0);
    assert.equal(await sender.locator('.pin-box strong').textContent(), code);
    server = await startServer(port);
    // The socket comes back on its own (backoff 1-2-4-8 s) and rejoins the room.
    const deadline = Date.now() + 30000;
    while (!server.logs.join('').includes(`joined room ${code}`) && Date.now() < deadline) await sleep(500);
    assert.ok(server.logs.join('').includes(`joined room ${code}`), 'sender rejoined after the outage');
    receiver = await newPage();
    await receiver.goto(`${server.base}/?room=${code}`);
    await sender.locator('.chat-room-container').waitFor({ timeout: 20000 });
    await receiver.locator('.chat-room-container').waitFor();
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

test('L2 a paired session keeps chatting and transferring over the data channel during a signalling outage', { skip, timeout: 120000 }, async () => {
  const port = await freePort();
  let server = await startServer(port);
  const { sender, receiver, code } = await pair(server.base, { receiverInit: [[opfsSavePicker, {}]] });
  try {
    await warmUp(sender, receiver);
    await server.stop();
    await sleep(2000);
    await sender.locator('.msg-input').fill('during outage');
    await sender.getByRole('button', { name: 'Send message' }).click();
    const bubble = receiver.locator('.row.in', { hasText: 'during outage' });
    await bubble.waitFor({ timeout: 10000 });
    assert.doesNotMatch(await bubble.textContent(), /via server relay/);
    await sendFile(sender, makeFile('outage.bin', randomBytes(5 * 1024 * 1024)));
    await bubbleBtn(receiver, 'outage.bin', 'Accept').click();
    await sub(sender, 'outage.bin').filter({ hasText: 'delivered' }).waitFor({ timeout: 30000 });
    assert.equal(await receiver.evaluate(() => window.__opfs.bytes), 5 * 1024 * 1024);
    // The UI did not declare the session dead just because the server went away.
    assert.doesNotMatch(await sender.locator('.peer-status').textContent(), /Disconnected/);
    server = await startServer(port);
    const deadline = Date.now() + 30000;
    const rejoined = () => (server.logs.join('').match(new RegExp(`joined room ${code}`, 'g')) || []).length >= 2;
    while (!rejoined() && Date.now() < deadline) await sleep(500);
    assert.ok(rejoined(), 'both devices re-registered after the outage');
    // Still one working session afterwards.
    await sender.locator('.msg-input').fill('after outage');
    await sender.getByRole('button', { name: 'Send message' }).click();
    await receiver.locator('.row.in', { hasText: 'after outage' }).waitFor();
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Backgrounding (SIMULATED via Chrome page freeze)
// ---------------------------------------------------------------------------

test('L3 [simulated] receiver frozen for 8 s mid-transfer: transfer completes intact', { skip, timeout: 120000 }, async () => {
  const server = await startServer();
  const { sender, receiver } = await pair(server.base, { receiverInit: [[opfsSavePicker, {}]] });
  try {
    const size = 200 * 1024 * 1024;
    await sendFile(sender, makeFile('freeze8.bin', randomBytes(size)));
    await bubbleBtn(receiver, 'freeze8.bin', 'Accept').click();
    await sub(receiver, 'freeze8.bin').filter({ hasText: /receiving — [1-9]\d*%/ }).waitFor({ timeout: 30000 });
    await freeze(receiver, 8000);
    await sub(receiver, 'freeze8.bin').filter({ hasText: /received|failed/ }).waitFor({ timeout: 60000 });
    await sub(sender, 'freeze8.bin').filter({ hasText: /delivered|failed/ }).waitFor({ timeout: 60000 });
    assert.match(await sub(receiver, 'freeze8.bin').textContent(), /received/);
    assert.match(await sub(sender, 'freeze8.bin').textContent(), /delivered/);
    assert.equal(await receiver.evaluate(() => window.__opfs.bytes), size);
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

test('L4 [simulated] receiver frozen for 35 s (beyond the 20 s grace): outcome is consistent on both sides', { skip, timeout: 180000 }, async () => {
  const server = await startServer();
  const { sender, receiver } = await pair(server.base, { receiverInit: [[opfsSavePicker, {}]] });
  try {
    const size = 200 * 1024 * 1024;
    await sendFile(sender, makeFile('freeze35.bin', randomBytes(size)));
    await bubbleBtn(receiver, 'freeze35.bin', 'Accept').click();
    await sub(receiver, 'freeze35.bin').filter({ hasText: /receiving — [1-9]\d*%/ }).waitFor({ timeout: 30000 });
    await freeze(receiver, 35000);
    await sub(receiver, 'freeze35.bin').filter({ hasText: /received|failed|cancelled/ }).waitFor({ timeout: 90000 });
    await sub(sender, 'freeze35.bin').filter({ hasText: /delivered|failed|cancelled/ }).waitFor({ timeout: 90000 });
    const r = await sub(receiver, 'freeze35.bin').textContent();
    const s = await sub(sender, 'freeze35.bin').textContent();
    console.log(`L4 outcome: receiver="${r.trim()}" sender="${s.trim()}"`);
    // Whatever happens, the sender must never claim delivery the receiver did not make.
    if (/delivered/.test(s)) {
      assert.match(r, /received/);
      assert.equal(await receiver.evaluate(() => window.__opfs.bytes), size);
    }
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

test('L5 chat after the other device left is not presented as sent', { skip, timeout: 60000 }, async () => {
  const server = await startServer();
  const { sender, receiver } = await pair(server.base);
  try {
    await warmUp(sender, receiver);
    await receiver.getByRole('button', { name: 'Back' }).click();
    await sender.locator('.peer-status', { hasText: 'Disconnected' }).waitFor({ timeout: 10000 });
    await sender.locator('.msg-input').fill('anyone there?');
    await sender.getByRole('button', { name: 'Send message' }).click();
    await sender.locator('.sys-note', { hasText: /not delivered/i }).waitFor({ timeout: 5000 });
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Calls: screen share and recording
// ---------------------------------------------------------------------------

async function startVideoCall(sender, receiver) {
  await sender.getByRole('button', { name: 'Video call' }).click();
  await receiver.locator('.incoming-call-overlay').getByRole('button', { name: 'Accept' }).click();
  await sender.locator('.call-stage .call-timer', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
  await receiver.locator('.call-stage .call-timer', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
}

const outgoingVideoLabel = (page) => page.evaluate(() => {
  const pc = window.__pcs.filter((p) => p.connectionState === 'connected').pop();
  return pc?.getSenders().find((s) => s.track?.kind === 'video')?.track?.label ?? null;
});

test('L6 screen share: app stop and (simulated) native stop both restore the camera; hang-up releases everything', { skip, timeout: 120000 }, async () => {
  const server = await startServer();
  const { sender, receiver } = await pair(server.base);
  try {
    await warmUp(sender, receiver);
    await startVideoCall(sender, receiver);
    const cameraLabel = await outgoingVideoLabel(sender);
    assert.ok(cameraLabel && !cameraLabel.startsWith('screen'), `camera track first (${cameraLabel})`);
    const share = sender.locator('.ctrl-btn', { hasText: 'Share' });

    // Stop from the app's own button.
    await share.click();
    await sender.locator('.ctrl-btn.active', { hasText: 'Share' }).waitFor();
    assert.match(await outgoingVideoLabel(sender), /^screen/);
    await share.click();
    await sender.locator('.ctrl-btn.active', { hasText: 'Share' }).waitFor({ state: 'detached' });
    assert.equal(await outgoingVideoLabel(sender), cameraLabel);
    assert.equal(await sender.evaluate(() => window.__screens[0].getTracks().every((t) => t.readyState === 'ended')), true);

    // Stop from the browser's own control (simulated: track ends + 'ended' event).
    await share.click();
    await sender.locator('.ctrl-btn.active', { hasText: 'Share' }).waitFor();
    await sender.evaluate(() => {
      const t = window.__screens[1].getVideoTracks()[0];
      t.stop();
      t.dispatchEvent(new Event('ended'));
    });
    await sender.locator('.ctrl-btn.active', { hasText: 'Share' }).waitFor({ state: 'detached' });
    assert.equal(await outgoingVideoLabel(sender), cameraLabel);
    // Microphone still live (mute keeps working) while the call continues.
    assert.equal(await sender.evaluate(() => window.__streams[0].getAudioTracks()[0].readyState), 'live');

    await sender.getByRole('button', { name: 'End call' }).click();
    await sender.locator('.call-stage').waitFor({ state: 'detached' });
    await sender.waitForFunction(() =>
      [...window.__streams, ...window.__screens].every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
    assert.deepEqual(sender.errors, []);
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

test('L7 screen share in an audio call explains itself and starts no capture', { skip, timeout: 90000 }, async () => {
  const server = await startServer();
  const { sender, receiver } = await pair(server.base);
  try {
    await warmUp(sender, receiver);
    await sender.getByRole('button', { name: 'Audio call' }).click();
    await receiver.locator('.incoming-call-overlay').getByRole('button', { name: 'Accept' }).click();
    await sender.locator('.call-stage .call-timer', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
    await sender.locator('.ctrl-btn', { hasText: 'Share' }).click();
    await sender.locator('.sys-note', { hasText: 'Screen sharing is available in video calls' }).waitFor();
    assert.equal(await sender.evaluate(() => window.__screens.length), 0);
    await sender.getByRole('button', { name: 'End call' }).click();
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

test('L8 recording is stopped and saved when the other side hangs up', { skip, timeout: 120000 }, async () => {
  const server = await startServer();
  const { sender, receiver } = await pair(server.base);
  try {
    await warmUp(sender, receiver);
    await startVideoCall(sender, receiver);
    await sender.locator('.ctrl-btn', { hasText: 'Record' }).click();
    await sender.locator('.ctrl-btn.recording').waitFor();
    await sleep(3000);
    const download = sender.waitForEvent('download', { timeout: 20000 });
    await receiver.getByRole('button', { name: 'End call' }).click();
    const dl = await download;
    assert.match(dl.suggestedFilename(), /^call-recording-\d+\.webm$/);
    const saved = path.join(work, 'rec.webm');
    await dl.saveAs(saved);
    const { statSync } = await import('node:fs');
    assert.ok(statSync(saved).size > 1000, `recording has content (${statSync(saved).size} bytes)`);
    await sender.locator('.call-stage').waitFor({ state: 'detached' });
    await sender.waitForFunction(() => window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Offers and connection labelling
// ---------------------------------------------------------------------------

test('L9 a sender can withdraw a pending offer; the receiver sees it withdrawn', { skip, timeout: 60000 }, async () => {
  const server = await startServer();
  const { sender, receiver } = await pair(server.base);
  try {
    await sendFile(sender, makeFile('withdraw.txt', Buffer.from('x')));
    await sub(receiver, 'withdraw.txt').filter({ hasText: 'pending acceptance' }).waitFor();
    // Observed: there is no automatic timeout on a pending offer.
    await sleep(5000);
    assert.match(await sub(sender, 'withdraw.txt').textContent(), /pending acceptance/);
    await bubbleBtn(sender, 'withdraw.txt', 'Cancel').click();
    await sub(sender, 'withdraw.txt').filter({ hasText: 'cancelled' }).waitFor();
    await sub(receiver, 'withdraw.txt').filter({ hasText: 'cancelled' }).waitFor();
    assert.equal(await bubbleBtn(receiver, 'withdraw.txt', 'Accept').count(), 0);
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});

test('L10 the connection label matches the ICE path WebRTC actually selected', { skip, timeout: 60000 }, async () => {
  const server = await startServer();
  const { sender, receiver } = await pair(server.base);
  try {
    await warmUp(sender, receiver);
    const pathInfo = await selectedPath(sender);
    console.log('L10 selected path:', JSON.stringify(pathInfo));
    assert.equal(pathInfo.local, 'host');
    // A host<->host pair is a direct local-network path, and must not be shown as relayed.
    await sender.locator('.peer-status', { hasText: 'Local network' }).waitFor({ timeout: 10000 });
    assert.doesNotMatch(await sender.locator('.peer-status').textContent(), /Relayed/);
  } finally {
    await close(sender, receiver);
    await server.stop();
  }
});
