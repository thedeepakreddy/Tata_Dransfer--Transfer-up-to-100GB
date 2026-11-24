// Phase 1.5 progressive large-file transfer runner.
//
//   npm run build
//   node tests/validation/large-file.mjs --sizes=100M,400M,1G [--mode=opfs|memory]
//        [--throttle=20M] [--out=docs/phase-1.5/evidence/large-file.json]
//
// For each size: generates a deterministic file, hashes it, pairs two real
// Chromium instances through the production server, transfers the file, and
// records duration, throughput, memory samples, the selected ICE path and the
// SHA-256 of the bytes the receiver actually wrote to disk.
//
// mode=opfs   receiver writes through Chrome's real FileSystemWritableFileStream
//             into an on-disk profile (the Chrome/Edge direct-to-disk path).
// mode=memory receiver has no save picker (the Firefox/Safari code path) and
//             the file arrives as an in-memory Blob download.
// --throttle  caps the receiver's disk writes (bytes/s) to emulate a slow disk.

import { rmSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, loadPlaywright, startServer, makeDeterministicFile, sha256File, findFilesBySize,
  rssOfProcessesMatching, trackPeerConnections, opfsSavePicker, selectedPath, jsHeap, mb,
  chromiumVersion, tmp,
} from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const parseSize = (s) => {
  const m = /^(\d+(?:\.\d+)?)([KMG]?)$/i.exec(s.trim());
  if (!m) throw new Error(`bad size ${s}`);
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase()];
  return Math.round(Number(m[1]) * mult);
};
const sizes = (args.sizes || '100M').split(',').map(parseSize);
const mode = args.mode || 'opfs';
const throttle = args.throttle ? parseSize(args.throttle) : 0;
const outFile = args.out ? path.resolve(ROOT, args.out) : null;

const pw = loadPlaywright();
if (!pw) { console.error('Playwright is not installed: cannot run.'); process.exit(2); }
if (!existsSync(path.join(ROOT, 'dist/server.cjs'))) { console.error('Run `npm run build` first.'); process.exit(2); }
const { chromium } = pw;

const LAUNCH_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

async function runOne(server, size) {
  const work = tmp('td-large-');
  const senderDir = path.join(work, 'sender-profile');
  const receiverDir = path.join(work, 'receiver-profile');
  const filePath = path.join(work, `synthetic-${size}.bin`);
  const result = {
    sizeBytes: size, sizeMiB: mb(size), mode, throttleBytesPerSec: throttle || null,
    fileType: 'application/octet-stream (deterministic AES-256-CTR keystream)',
    startedAt: new Date().toISOString(),
  };
  let sender, receiver;
  try {
    const g0 = Date.now();
    result.sourceSha256 = await makeDeterministicFile(filePath, size);
    result.generateMs = Date.now() - g0;

    const common = { args: LAUNCH_ARGS, acceptDownloads: true, permissions: ['camera', 'microphone'] };
    sender = await chromium.launchPersistentContext(senderDir, common);
    receiver = await chromium.launchPersistentContext(receiverDir, common);
    const sp = sender.pages()[0] || await sender.newPage();
    const rp = receiver.pages()[0] || await receiver.newPage();
    const consoleErrors = [];
    for (const [who, p] of [['sender', sp], ['receiver', rp]]) {
      p.on('pageerror', (e) => consoleErrors.push(`${who} pageerror: ${e.message}`));
      p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${who}: ${m.text().slice(0, 200)}`); });
    }
    await sp.addInitScript(trackPeerConnections);
    await rp.addInitScript(trackPeerConnections);
    if (mode === 'opfs') await rp.addInitScript(opfsSavePicker, { throttleBytesPerSec: throttle });
    else await rp.addInitScript(() => { delete window.showSaveFilePicker; });

    await sp.goto(server.base);
    await sp.locator('.loader-screen').waitFor({ state: 'detached' });
    await sp.getByRole('button', { name: /Send files/ }).click();
    const pin = sp.locator('.pin-box strong');
    await pin.filter({ hasText: /^[0-9A-F]{6}$/ }).waitFor();
    await rp.goto(`${server.base}/?room=${await pin.textContent()}`);
    await sp.locator('.chat-room-container').waitFor();
    await rp.locator('.chat-room-container').waitFor();

    await sp.locator('.composer input[type=file]').setInputFiles(filePath);
    const name = path.basename(filePath);
    const rsub = rp.locator('.file-bubble', { hasText: name }).locator('.file-sub');
    const ssub = sp.locator('.file-bubble', { hasText: name }).locator('.file-sub');
    await rsub.filter({ hasText: 'pending acceptance' }).waitFor({ timeout: 30000 });

    const download = mode === 'memory' ? rp.waitForEvent('download', { timeout: 0 }) : null;
    const t0 = Date.now();
    await rp.locator('.file-bubble', { hasText: name }).locator('..').getByRole('button', { name: 'Accept' }).click();

    const samples = [];
    const deadline = t0 + 120000 + (size / (2 * 1024 * 1024)) * 1000; // allow >= 2 MiB/s
    let receiverDoneAt = null, senderDoneAt = null, receiverText = '', senderText = '';
    while (Date.now() < deadline) {
      receiverText = (await rsub.textContent()) || '';
      senderText = (await ssub.textContent()) || '';
      const now = Date.now();
      if (!receiverDoneAt && /received|failed|cancelled/.test(receiverText)) receiverDoneAt = now;
      if (!senderDoneAt && /delivered|failed|cancelled|not confirmed/.test(senderText)) senderDoneAt = now;
      samples.push({
        tSec: Math.round((now - t0) / 100) / 10,
        senderHeapMiB: mb(await jsHeap(sp)),
        receiverHeapMiB: mb(await jsHeap(rp)),
        senderRssMiB: mb(rssOfProcessesMatching(senderDir)),
        receiverRssMiB: mb(rssOfProcessesMatching(receiverDir)),
        receiverPendingWrites: mode === 'opfs' ? await rp.evaluate(() => window.__opfs?.pending ?? null) : null,
      });
      if (receiverDoneAt && senderDoneAt) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    result.receiverStatusText = receiverText.trim();
    result.senderStatusText = senderText.trim();
    result.receiverCompleteSec = receiverDoneAt ? (receiverDoneAt - t0) / 1000 : null;
    result.senderDeliveredSec = senderDoneAt ? (senderDoneAt - t0) / 1000 : null;
    result.timedOut = !(receiverDoneAt && senderDoneAt);
    result.throughputMiBps = receiverDoneAt ? Math.round((size / 1048576 / ((receiverDoneAt - t0) / 1000)) * 10) / 10 : null;
    result.receiverAcknowledged = /delivered/.test(senderText);
    result.selectedPath = await selectedPath(sp).catch(() => null);
    result.uiConnectionLabel = ((await sp.locator('.peer-status').textContent()) || '').trim();
    const peak = (k) => samples.reduce((m, s) => (s[k] != null && s[k] > m ? s[k] : m), 0);
    result.peak = {
      senderHeapMiB: peak('senderHeapMiB'), receiverHeapMiB: peak('receiverHeapMiB'),
      senderRssMiB: peak('senderRssMiB'), receiverRssMiB: peak('receiverRssMiB'),
      receiverPendingWrites: mode === 'opfs' ? peak('receiverPendingWrites') : null,
    };
    result.samples = samples.length > 120 ? samples.filter((_, i) => i % Math.ceil(samples.length / 120) === 0) : samples;
    if (mode === 'opfs') {
      result.writer = await rp.evaluate(() => window.__opfs);
      const onDisk = findFilesBySize(receiverDir, size);
      result.receiverFilesFoundOnDisk = onDisk.length;
      result.receiverSha256 = onDisk.length === 1 ? await sha256File(onDisk[0]) : null;
    } else if (download && /received/.test(receiverText)) {
      const dl = await download;
      const saved = path.join(work, 'download.bin');
      await dl.saveAs(saved);
      result.receiverSha256 = await sha256File(saved);
      result.downloadSuggestedName = dl.suggestedFilename();
    }
    result.hashMatch = result.receiverSha256 ? result.receiverSha256 === result.sourceSha256 : null;
    result.consoleErrors = consoleErrors.slice(0, 20);
    result.verdict = result.hashMatch && result.receiverAcknowledged && !result.timedOut ? 'PASS' : 'FAIL';
  } catch (e) {
    result.verdict = 'FAIL';
    result.error = String(e?.stack || e).slice(0, 2000);
  } finally {
    await sender?.close().catch(() => {});
    await receiver?.close().catch(() => {});
    rmSync(work, { recursive: true, force: true }); // synthetic data + profiles
    result.finishedAt = new Date().toISOString();
  }
  return result;
}

const server = await startServer();
const env = {
  chromium: chromiumVersion(chromium),
  node: process.version,
  os: `${process.platform} ${(await import('node:os')).release()}`,
  cpus: (await import('node:os')).cpus().length,
  memGiB: Math.round((await import('node:os')).totalmem() / 1024 ** 3),
  network: 'loopback only (single machine; no external network in this sandbox)',
  commit: (await import('node:child_process')).execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(),
  dirty: (await import('node:child_process')).execSync('git status --porcelain', { cwd: ROOT }).toString().trim() !== '',
};
const results = [];
try {
  for (const size of sizes) {
    console.log(`--- ${mb(size)} MiB (${mode}${throttle ? `, throttle ${mb(throttle)} MiB/s` : ''})`);
    const r = await runOne(server, size);
    const { samples, ...summary } = r;
    console.log(JSON.stringify(summary, null, 2));
    results.push(r);
  }
} finally {
  await server.stop();
}
if (outFile) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ env, results }, null, 2));
  console.log(`evidence written to ${path.relative(ROOT, outFile)}`);
}
process.exit(results.every((r) => r.verdict === 'PASS') ? 0 : 1);
