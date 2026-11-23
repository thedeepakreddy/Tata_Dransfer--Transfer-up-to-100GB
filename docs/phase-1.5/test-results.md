# Phase 1.5: Test Results

All results below were **executed in the automated environment** unless the status says otherwise. Statuses follow `validation-plan.md` §1. BLOCKED and NOT RUN are never counted as passes.

## 0. Environment and baseline (Stage 0)

| Item | Value |
|---|---|
| Date | 2026-11-23 |
| Branch | `claude/new-session-3xymt9` |
| Baseline commit | `2b56ca2` (matched `origin`; clean tree at start) |
| Final commit | see `final-report.md` |
| OS | Linux 6.18 x86-64 VM, 4 CPUs, 16 GB RAM, no swap, 59 GB free disk |
| Node / npm / TypeScript | v22.23.5 / 10.9.9 / 5.8.3 |
| Browser | Google Chrome for Testing **153.0.8010.12**, headless, via Playwright 1.63.0 (pre-installed, not a project dependency) |
| Other browsers | **None** (no Firefox, no WebKit / Safari) |
| Network | **Loopback only**: DNS does not resolve, STUN/TURN hosts are unreachable, and the production signalling host cannot be reached |
| Media devices | Chromium fake camera / microphone / screen (`--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`) |

| ID | Command | Result | Status |
|---|---|---|---|
| B-01 | `npm run lint` (tsc --noEmit) | no errors (4.0 s) | PASS |
| B-02 | `npm test` | 31/31 at baseline (1.2 s) | PASS |
| B-03 | `npm run build` | built (3.4 s); the existing "chunk > 500 kB" warning is unchanged | PASS |
| B-04 | `npm run test:e2e` | 18/18 (2 min 50 s) | PASS |
| B-05 | `npm run test:e2e` with `dist/` removed | **before:** 18 × `ok … # SKIP`, exit 0, which misrepresents an empty run → defect **D1**. **After the fix:** `not ok 1 - prerequisites`, 18 skipped, exit **1** | FAIL → fixed |
| B-06 | Network probes: UDP STUN binding requests to the 4 configured STUN/TURN hosts; TCP 443 to the TURN host; HTTPS to the production signalling host | all `ENOTFOUND` / no route; HTTPS code 000 | n/a; confirms cross-network and TURN tests are BLOCKED here |

Coverage inventory at baseline:

| Area | Coverage |
|---|---|
| Chromium | 18 E2E + 31 unit/server tests |
| Firefox, Safari, iOS, Android, physical devices, real networks, TURN | **none** |
| Largest file previously exercised | 400 MiB (Phase 1.0) |

## 1. Browser and device matrix (Stage 1)

| ID | Environment | Status | Evidence / reason |
|---|---|---|---|
| BR-01 | Chrome for Testing 153, headless, Linux VM, loopback | **PARTIAL**: everything listed in §2–§4 PASS, but one engine, one machine, fake devices | §2–§4 |
| BR-02 | Chrome desktop (Win/macOS) | **NOT RUN**: owner | Guide §3 |
| BR-03 | Edge desktop | **NOT RUN**: owner | Guide §3 |
| BR-04 | Firefox desktop | **BLOCKED** here (not installed, no network to install); owner | Guide §3 |
| BR-05 | Safari macOS | **BLOCKED** here; owner | Guide §3 |
| BR-06 | Safari iPhone / iPad | **BLOCKED** here; owner | Guide §3, §6 |
| BR-07 | Chrome Android | **BLOCKED** here; owner | Guide §3, §6 |
| BR-08 | Other devices | **BLOCKED** here; owner | Guide §3 |

Coverage within BR-01 for the Stage 1 items:

| Stage 1 item | Test | Status |
|---|---|---|
| File picker and save/write | LF-01…07: real `FileSystemWritableFileStream` (OPFS-backed picker stub; the native dialog itself cannot be driven headlessly). E2E-01…04 | PASS (picker UI: NOT RUN) |
| Reload / tab close / session recovery | E2E-14, E2E-18 (renderer crash), E2E-07/11 | PASS (E2E-14: see D4) |
| Background / foreground | L3, L4 | SIMULATED, PASS |
| Device sleep | n/a | BLOCKED (owner guide §6) |
| Calls and permissions | E2E-09, E2E-10, L6–L8 (permissions auto-granted by flag) | PASS; permission prompts NOT RUN |
| Screen sharing | L6, L7 | PASS (fake capture) |
| Native stop-sharing | L6 | SIMULATED, PASS |
| Recording cleanup | L8 | PASS |
| Peer loss | E2E-07/10/11/17, L5 | PASS |
| UI state accuracy | L5, L10 (and D2/D3 fixed) | PASS after fixes |
| Failure messages | E2E-04, -15, -16, L5, L7 | PASS |

## 2. Progressive large files (Stage 2)

**Method:**

*   **Script:** `npm run validate:large -- --sizes=…` (`tests/validation/large-file.mjs`).
*   **Source file:** a deterministic AES-256-CTR keystream (same size → same bytes), hashed before sending.
*   **Setup:** two separate Chromium instances with on-disk profiles, paired through the production server build (`dist/server.cjs`, `NODE_ENV=production`) over loopback.
*   **Real disk path:** the receiver's save picker is stubbed to return an **OPFS file**, so writes go through Chrome's real `FileSystemWritableFileStream` to disk. The received file is located on disk in the receiver's profile and hashed by Node.
*   **Memory:** JS heap via CDP `Performance.getMetrics`; RSS summed over each Chrome process tree, which double-counts shared pages, so compare between runs only.
*   **Timing:** 1 s polling, so times are ±1 s.
*   **Cleanup:** files and profiles deleted after each run.
*   **Raw evidence:** `docs/phase-1.5/evidence/*.json`, including per-second memory samples.
*   **App code for LF-01…LF-11:** commit `2b56ca2` (the JSON says `dirty: true` only because the new harness files were still untracked). The post-fix confirmation run is LF-12.

| ID | Size | Mode | Source SHA-256 (prefix) | Received on disk (prefix) | Match | Ack | Time (s) | MiB/s | Peak heap S/R (MiB) | Peak RSS S/R (MiB) | Selected path | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LF-01 | 100 MiB | disk | 66cc33c77b7e7edf | 66cc33c77b7e7edf | ✅ | ✅ | 5.1 | 19.8 | 5.1 / 4.6 | 610 / 584 | host/host udp | PASS |
| LF-02 | 400 MiB | disk | f843c2b137bb919f | f843c2b137bb919f | ✅ | ✅ | 14.3 | 28.1 | 4.9 / 4.7 | 603 / 582 | host/host udp | PASS |
| LF-03 | 500 MiB | disk | b9addb3587841777 | b9addb3587841777 | ✅ | ✅ | 16.4 | 30.6 | 4.7 / 4.5 | 587 / 603 | host/host udp | PASS |
| LF-04 | 1 GiB | disk | 8aeaec64f850a45e | 8aeaec64f850a45e | ✅ | ✅ | 31.7 | 32.3 | 4.8 / 4.8 | 603 / 593 | host/host udp | PASS |
| LF-05 | 2 GiB | disk | 103f11474b7553a2 | 103f11474b7553a2 | ✅ | ✅ | 63.6 | 32.2 | 5.4 / 4.6 | 607 / 588 | host/host udp | PASS |
| LF-06 | 4 GiB | disk | 0a0d967b0fbc217e | 0a0d967b0fbc217e | ✅ | ✅ | 127.2 | 32.2 | 4.9 / 4.9 | 590 / 587 | host/host udp | PASS |
| LF-07 | 8 GiB | disk | 9c49d0c26b83952d | 9c49d0c26b83952d | ✅ | ✅ | 232.2 | 35.3 | 5.2 / 4.9 | 611 / 594 | host/host udp | PASS |
| LF-08 | 100 MiB | in-memory fallback | 66cc33c77b7e7edf | 66cc33c77b7e7edf (download) | ✅ | ✅ | 5.1 | 19.7 | 4.7 / 4.5 | 595 / **731** | host/host udp | PASS (see L-A) |
| LF-09 | 500 MiB | in-memory fallback | b9addb3587841777 | b9addb3587841777 | ✅ | ✅ | 15.3 | 32.7 | 4.6 / 5.7 | 599 / **1,543** | host/host udp | PASS (see L-A) |
| LF-10 | 1 GiB | in-memory fallback | 8aeaec64f850a45e | 8aeaec64f850a45e | ✅ | ✅ | 27.5 | 37.2 | 4.8 / 7.7 | 592 / **2,613** | host/host udp | PASS (see L-A) |
| LF-11 | 400 MiB | disk, writes throttled to 8 MiB/s | f843c2b137bb919f | f843c2b137bb919f | ✅ | ✅ | 54.9 | 7.3 | 4.7 / 4.8 | 582 / **845** | host/host udp | PASS (see L-B) |

Observations:

*   **Disk path:** memory is flat from 100 MiB to 8 GiB (JS heap about 5 MiB; RSS ≈ idle). Writes are batched to 1 MiB (writes = MiB count), with at most 1 write in flight. No console errors in any run.
*   **In-memory fallback:** receiver RSS grows by roughly **2× the file size**. This is the Firefox/Safari code path; see defect L-A.
*   **Slow disk:** receiver RSS rose about 300 MiB in the first 14 s while the network outpaced the disk, plateaued, then drained (time series in `evidence/large-file-slow-disk.json`). This measures the deferred backpressure limitation L-B.
*   **UI label:** these pre-fix runs show `Connected · Local WiFi` on a VM with no Wi-Fi at all, which is evidence for defect D2.
*   **Not proven:** anything about real networks, other browsers, or sizes above 8 GiB.

## 3. Network and TURN (Stage 3)

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| NET-01 | Same machine, two browser instances | PASS | Selected pair `host`/`host`, UDP, in every LF run and L10 (from `getStats`, not guessed). Loopback-only, so it says nothing about NAT traversal |
| NET-02 | Same Wi-Fi / LAN | BLOCKED | Owner guide §5.1 |
| NET-03 | Two independent networks | BLOCKED | Guide §5.2 |
| NET-04 | Wi-Fi ↔ mobile data | BLOCKED | Guide §5.3 |
| NET-05 | VPN on / off | BLOCKED | Guide §5.4 |
| NET-06 | Firewalled (forces TURN) | BLOCKED: no route to any TURN server (B-06) | Guide §5.5 |
| NET-07 | Network switch mid-session | BLOCKED | Guide §5.6 |
| NET-08 | Signalling server outage | PASS (L1, L2, local server); production: NOT RUN | Guide §5.7 |
| TURN | Any relay evidence | **BLOCKED**: no relay candidate was, or could be, observed | Guide §5.5 |

## 4. Failure and lifecycle campaign (Stage 4)

`npm run test:validation` (`tests/validation/lifecycle.e2e.mjs`), production build, Chromium 153.

| ID | Scenario | Before fixes | After fixes | Status |
|---|---|---|---|---|
| L1 | Sender on its QR screen while signalling is down 4 s → server restarted on the same port | pass | pass | PASS: QR and code kept, socket re-registered by itself, then paired |
| L2 | Paired session during a signalling outage | pass | pass | PASS: chat delivered over the data channel (no relay tag), 5 MiB file delivered and acknowledged, UI not "Disconnected"; both devices re-registered after the restart |
| L3 | Receiver frozen 8 s mid-transfer (200 MiB) | pass | pass | SIMULATED, PASS: received + delivered, all bytes written |
| L4 | Receiver frozen 35 s (beyond the 20 s grace) | pass (outcome: received / delivered) | same | SIMULATED, PASS on consistency. Note limitation L-D: the freeze does not stop Chrome's network thread |
| L5 | Chat after the other device left | **fail**: bubble shown as sent "via server relay", no warning | pass | Defect **D3**, fixed |
| L6 | Screen share: stop from the app, stop from the native control (simulated), then hang up | pass | pass | PASS (native control SIMULATED): camera track restored as the outgoing track both times; screen tracks ended; mic stayed live; after hang-up every camera / mic / screen track ended |
| L7 | Share during an audio call | pass | pass | PASS: notice shown, `getDisplayMedia` never called |
| L8 | Recording, then the *other* side hangs up | pass | pass | PASS: `call-recording-*.webm` downloaded (content > 1 KB), call UI gone, all tracks ended |
| L9 | Pending offer: no auto-timeout; sender withdraws | pass | pass | PASS (behaviour L-C documented) |
| L10 | UI path label vs `getStats` selected pair | **fail**: label not accurate | pass | Defect **D2**, fixed. Selected pair `host`/`host` UDP → "Local network" |

Final run after fixes: **10/10 pass**.

Other Stage 4 items are covered by the regression suite (§5): sender/receiver disconnect (E2E-11/07), rejection (05), cancellation both ways (06/12), reload (14), tab death (18), peer loss in a call (10), hang-up (09), invalid / duplicate / early / oversized messages (15/16 + server unit tests), seat reclaim (14/18 + unit tests). Slow write path: LF-11. Memory pressure: measured in LF-08…11, not induced to the point of a crash.

**Not run:** inducing out-of-memory, real mobile backgrounding / eviction, network interruption of the *peer* path (cannot be done on loopback). These are owner-guide §5.6 and §6.

## 5. Regression suite after fixes

| Command | Result |
|---|---|
| `npm run lint` | PASS |
| `npm test` | **35/35** (19 server + 12 protocol + 4 new path-classification tests) |
| `npm run build` | PASS |
| `npm run test:e2e` | Run 1 after fixes: **17/18**, E2E-14 failed (detail not captured; see D4). Runs 2–3: 18/18 |
| `npm run test:validation` | **10/10** |

## D4. Reproduction attempts for the E2E-14 intermittent failure

| Attempt | Runs of E2E-14 | Failures |
|---|---|---|
| Full suite, first run after fixes | 1 | **1** (detail not captured) |
| E2E-14 alone | 3 | 0 |
| E2E-14 alone, loop | 15 | 0 |
| E2E-14 alone, 4 CPU-burning processes, page-console capture | 12 | 0 |
| Full suite (plain) | 2 | 0 |
| Full suite with page-console capture (`transfer.debug` copy, scratch only) | PENDING | PENDING |

## 8. Owner-run results

*(Empty. Paste completed templates from `owner-device-test-guide.md` here. Until then every BR-02…08, NET-02…07 and M1–M7 result is NOT RUN / BLOCKED.)*
