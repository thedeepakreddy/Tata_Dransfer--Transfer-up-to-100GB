# Phase 1.5: Final Report (Real-World Validation and Release Evidence)

**Overall readiness: PARTIAL.** The core transfer engine has strong, reproducible evidence, but only in **one browser engine (Chromium), on one machine, over loopback**. Every real-world dimension this phase exists to validate is **BLOCKED** in this environment and handed to the owner with a precise guide: other browsers, physical and mobile devices, real networks and TURN relay. By the phase's own rules, overall readiness cannot be PASS.

## 1. Executive summary

*   **Transfer integrity.** 12 large-file runs, **100 MiB up to 8 GiB**, all passed. Each run met four checks:
    *   the SHA-256 of the bytes **actually written to disk** matched the source;
    *   the receiver acknowledged the file;
    *   the sender showed *delivered* only after that acknowledgment;
    *   there were no console errors.

    On the Chrome/Edge direct-to-disk path, memory stayed **flat** (JS heap about 5 MiB at every size).
*   **Two memory limits measured, not just asserted:**
    *   The **in-memory receive path** used by Firefox and Safari costs about **2× the file size** in RAM (1 GiB file → 2.6 GiB receiver RSS).
    *   A **slow receiving disk** makes unwritten data pile up in RAM (+about 300 MiB in 14 s at 8 MiB/s), because the receiver cannot slow the sender down.

    Both need V2 protocol / architecture work and stay deferred.
*   **3 verified defects fixed** with regression tests, all narrowly scoped:
    *   **D1:** skipped E2E runs looked green.
    *   **D2:** the connection label made false "Relayed" / "Local WiFi" claims.
    *   **D3:** chat sent after the other device left appeared sent.
*   **1 open intermittent:** D4, an E2E-14 failure seen once in about 35 runs, root cause not identified. It is reported, not explained away.
*   **New lifecycle campaign (10 scenarios)** covering:
    *   signalling outages (QR screen and paired session)
    *   simulated backgrounding
    *   peer loss during chat
    *   screen share stopped from the app and from the native control (simulated)
    *   recording cleanup
    *   pending-offer withdrawal
    *   path-label accuracy

    10/10 after fixes.
*   **Owner guide** with step-by-step procedures, reproducible test-file recipes with reference hashes, a way to *prove* direct vs relay from browser internals, a firewall recipe that forces the TURN path, and fill-in templates.

## 2. Status definitions

| Label | Meaning |
|---|---|
| PASS | Executed here; all expectations met; evidence recorded |
| PARTIAL | Executed, but only part of the scope (e.g. Chromium-only, loopback-only), or only some expectations met |
| FAIL | Executed; an expectation was not met |
| BLOCKED | Not executable in this environment; needs the owner or infrastructure. Never a pass |
| NOT TESTED | Not executed in this campaign (in the detailed results this is written NOT RUN). Never a pass |
| SIMULATED | Executed against an approximation of the real condition, which is stated each time |

## 3. Release-readiness assessment (Stage 7)

| Dimension | Status | Basis |
|---|---|---|
| Automated test confidence | **PASS** | lint, build, 35 unit/server tests, 18 E2E, 10 lifecycle tests, 11 large-file runs; D4 flake open |
| Browser coverage | **PARTIAL** | Chromium 153 only. Firefox / Safari / Edge BLOCKED or NOT TESTED |
| Physical-device coverage | **BLOCKED** | No devices available; owner guide §3, §6 |
| Large-file evidence | **PARTIAL** | Chromium disk path PASS up to **8 GiB** (tested limit). In-memory path PASS to 1 GiB with about 2× RAM cost. Nothing on real hardware; nothing above 8 GiB; **no evidence for 100 GB** |
| Cross-network connectivity | **BLOCKED** | Loopback only (host/host). No NAT traversal evidence |
| TURN / relay | **BLOCKED** | No route to any TURN server; relay never observed |
| Transfer integrity and acknowledgment | **PASS** (Chromium) | Hash on disk = source in every run; ack-gated "delivered"; hostile-peer tests (E2E-15/16) |
| Call and chat reliability | **PARTIAL** | Lifecycle correct with fake devices (tracks released, share restore, recording saved, peer loss). Real media quality, permission prompts and mobile behaviour NOT TESTED |
| Security / privacy claims | **PARTIAL** | Claims in the docs/UI match the code (D2 / D3 removed two false UI claims). Open risks in §8 (short room codes, readable relay chat, no key verification, public TURN). No security certification is claimed |
| Remaining limitations | Documented | L-A, L-B, L-C, L-D in `defects.md` |
| Unresolved V2 dependencies | Documented | §9 |

## 4. Executed vs unexecuted tests

**Executed (in this environment):**

*   B-01…B-06 baseline
*   E2E-01…18 (three or more full runs)
*   L1…L10
*   LF-01…LF-12 (LF-12 = 1 GiB on the final code, PASS)
*   35 unit / server tests
*   D4 reproduction attempts

Details and commands: `test-results.md`.

**Simulated:**

*   L3 / L4 backgrounding, via Chrome page freeze;
*   L6 native "Stop sharing", via track end + `ended` event;
*   E2E-18 tab eviction, via renderer crash;
*   the save picker (the dialog itself cannot be driven headlessly; writes went through Chrome's real writable stream).

**Blocked / not run (owner guide):**

*   BR-02…BR-08 (every browser and device other than headless Chromium)
*   NET-02…NET-07 (every real network, including VPN, firewall and network switching)
*   all TURN tests
*   real mobile backgrounding / sleep / eviction (M1–M7)
*   real permission prompts
*   large files on real hardware
*   production signalling outage

## 5. Evidence

*   `docs/phase-1.5/evidence/large-file-opfs.json`: 100 MiB → 2 GiB
*   `…/large-file-opfs-4g-8g.json`: 4 GiB, 8 GiB
*   `…/large-file-memory-fallback.json`: 100 MiB, 500 MiB, 1 GiB in-memory
*   `…/large-file-slow-disk.json`: 400 MiB at 8 MiB/s
*   `…/large-file-postfix.json`: 1 GiB confirmation on the final code `0bd452e` (LF-12, PASS)

Each JSON holds environment, hashes, timings, per-second memory samples, the selected ICE pair and the UI label. No credentials, IPs or file contents are recorded. The synthetic data was deleted after each run.

## 6. Defect fixes (Stage 6)

| ID | Root cause | Fix | Regression test | Files |
|---|---|---|---|---|
| D1 | `node:test` prints skips as `ok … # SKIP`, exit 0 | Missing prerequisites fail when run via the npm script | B-05 re-run: exit 1 | `tests/e2e/transfer.e2e.mjs`, `tests/validation/lifecycle.e2e.mjs` |
| D2 | Host-vs-not-host classification of the local candidate of *any* succeeded pair; ICE failure set "relayed"; unknown displayed as "Relayed" | Classify the transport's selected pair, both ends: relay → Relayed, host+host → Local network, else Direct, unknown → no claim | `tests/connectionPath.test.ts` (4), L10 | `src/lib/connectionPath.ts` (new), `useWebRTC.ts`, `useCallManager.ts`, `ChatRoom.tsx`, `Sender.tsx` |
| D3 | Relay fallback ignored whether the peer was in the room | Track presence from the existing `ready` / `peer-disconnected` messages; otherwise show "not delivered" | L5; E2E-13 still passes | `useWebRTC.ts` |

No wire-protocol change and no new dependency. The fixes work with the currently deployed signalling server.

## 7. Residual risks

1. **Firefox / Safari / iOS large files:** about 2× file size in RAM (L-A). On phones, practical limits are likely far below desktop. Not measured on devices.
2. **Slow receiving disk:** unbounded in-memory backlog (L-B). A very large file sent to a slow disk may exhaust memory.
3. **TURN is untested** and uses a free public relay with no availability guarantee. Users behind strict NATs or firewalls may be unable to connect at all.
4. **Real-network behaviour is unknown:** NAT traversal, mobile network switches, VPNs, and mobile OS suspension.
5. **D4:** a rare, unexplained E2E-14 failure on the reload path.
6. Security / privacy, unchanged from Phase 1.0:
    *   6-hex-character room codes;
    *   relayed chat readable by the server (now always labelled);
    *   no DTLS key verification;
    *   public TURN credentials embedded in the client (inherent to static-credential TURN; not reproduced in any report);
    *   the server logs room codes (recommend logging a hash; see §10).

## 8. Observability (Stage 5)

*   **Client console:** connection / ICE state changes, data-channel closure, and error names. It never logs file contents, file names, chat text, seat tokens or IP addresses.
*   **Server log:** join / leave / replace / expiry lines carrying the **room code** and role. No tokens, no message contents.
*   **UI:** per-file failure reasons, "via server relay" tags, "not delivered" notices, and now an accurate path label (D2).
*   **Gap:** there is no way, without browser internals, to see the selected candidate types. For owner testing the guide uses `chrome://webrtc-internals` / `about:webrtc`. No telemetry was added.

## 9. Deferred to V2 (unchanged list, with new evidence)

1. Receiver→sender **flow control**; L-B now measured.
2. A **streaming save path** for browsers without the File System Access API; L-A now measured at about 2× RAM.
3. A framed binary protocol, resumable transfers, end-to-end integrity hash, optional key verification.
4. Longer / higher-entropy room codes, join throttling, origin allow-list.
5. Hosted TURN with short-lived credentials, plus a relay-only diagnostic mode for testing.
6. Splitting the `useWebRTC` hook; perfect negotiation.
7. A product decision on pending-offer timeouts (L-C).

## 10. Recommendations

*   **Small, optional (not done, to keep scope):** log a short hash of the room code instead of the code itself on the signalling server.
*   **Before any public claim changes:**
    *   do **not** advertise 100 GB, cross-browser support or "works on any network";
    *   the README now states what is known (8 GiB tested in Chromium; memory-bound elsewhere).
*   **Owner gate (minimum evidence before release candidacy):**
    *   guide §3 on Chrome desktop, Safari iOS and Chrome Android;
    *   §4 up to 4 GiB on real LAN hardware;
    *   §5.2 / §5.3 cross-network;
    *   §5.5 TURN;
    *   §6 M1–M5.

## 11. Should Tata Dransfer proceed to V2 architecture planning?

**Yes, proceed to V2 *planning*, in parallel with the owner-run validation. Do not proceed to a release.**

Rationale:

*   The Phase 1.0 engine is correct where it can be measured.
*   The two issues most likely to block real large-file use (L-A, L-B) are now *measured*, and both can only be fixed by V2 protocol / architecture work.
*   The open questions that matter most (TURN viability, mobile suspension, cross-browser behaviour) need the owner tests. Their results should feed V2 requirements, so planning can start but should not be finalised until §3/§5/§6 of the owner guide have results.

## 12. Changed files (this phase)

*   **Application:**
    *   `src/lib/connectionPath.ts` (new)
    *   `src/lib/useWebRTC.ts`
    *   `src/lib/useCallManager.ts`
    *   `src/components/ChatRoom.tsx`
    *   `src/components/Sender.tsx`
*   **Tests and tooling:**
    *   `tests/connectionPath.test.ts` (new)
    *   `tests/validation/harness.mjs` (new)
    *   `tests/validation/large-file.mjs` (new)
    *   `tests/validation/lifecycle.e2e.mjs` (new)
    *   `tests/e2e/transfer.e2e.mjs` (D1 only)
    *   `package.json`: `test` now includes the new unit test; new `test:validation` and `validate:large` scripts
*   **Docs:**
    *   `docs/phase-1.5/` (5 documents + `evidence/`)
    *   `README.md` (tested-limit wording)
