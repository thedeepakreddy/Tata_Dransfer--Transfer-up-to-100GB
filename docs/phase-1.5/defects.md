# Phase 1.5: Verified Defects

Every entry here was reproduced in this environment, or is a limitation measured with evidence. Phase 1.0 defects are in `docs/phase-1.0-engineering-report.md` and are not repeated.

| ID | Title | Severity | Status |
|---|---|---|---|
| D1 | Skipped E2E runs looked green | Medium (test integrity) | **Fixed** |
| D2 | Connection path mislabelled ("Relayed" for direct / unknown paths; "Local WiFi" for any host path) | Medium (false claims; misleads network testing) | **Fixed** |
| D3 | Chat sent after the other device left was shown as sent via relay | Medium (false delivery) | **Fixed** |
| D4 | Intermittent failure of the sender-reload E2E test | Unknown | **Open: not reproduced** |
| L-A | In-memory receive path uses about 2× the file size in RAM | High for Firefox/Safari users | **Deferred to V2 (measured)** |
| L-B | No receiver→sender backpressure; slow disk buffers in RAM | High for very large files | **Deferred to V2 (measured)** |
| L-C | No timeout on a pending file offer | Low | **Documented behaviour (not a defect)** |
| L-D | Chrome page freeze does not reproduce mobile suspension | n/a (test limitation) | **Documented** |

---

## D1: Skipped E2E runs looked green

*   **Reproduction:** remove `dist/` and run `npm run test:e2e`. All 18 tests printed `ok N - … # SKIP run \`npm run build\` first` and the process exited 0.
*   **Root cause:** `node:test` reports skipped tests as `ok … # SKIP` and exits successfully. A CI job or a skimmed log reads that as a pass. The Phase 1.0 docs described the skip as intentional, but it misrepresents a run that tested nothing.
*   **Fix:** `tests/e2e/transfer.e2e.mjs`. When the suite is started on purpose through its npm script (`npm_lifecycle_event === 'test:e2e'`), missing prerequisites add a failing `prerequisites` test. A bare `node --test` still skips. The new `tests/validation/lifecycle.e2e.mjs` behaves the same way under `npm run test:validation`.
*   **Regression evidence:** with `dist/` removed, `npm run test:e2e` now prints `not ok 1 - prerequisites … Cannot run the E2E suite: run \`npm run build\` first` and exits **1** (`test-results.md` §B-05).
*   **Risk:** none to the app (test-only).

## D2: Connection path mislabelled

*   **Reproduction:** pair two devices. The chat header and the waiting screen showed `Connected · Local WiFi` whenever the local candidate was `host`, and `Connected · Relayed` for anything else. The code (Phase 1.0 `useWebRTC.ts` `checkConnectionType`, `useCallManager.ts` `getConnectionQuality`) shows:
    *   `srflx` / `prflx` candidates, which are **direct** peer-to-peer paths through NAT, were labelled "Relayed";
    *   type `unknown` (stats unavailable) was also displayed as "Relayed";
    *   an ICE `failed` event explicitly set the type to `relayed`;
    *   any `host` candidate (Ethernet, a public address) was called "Local WiFi";
    *   the code looped over *any* succeeded pair, not the pair the transport selected.

    Automated: lifecycle test L10 failed before the fix (`getStats` showed `host`/`host`; UI did not show the accurate label).
*   **Impact:** the UI made false relay / direct claims, and the owner's real-network tests (Stage 3) would have recorded wrong conclusions from the label.
*   **Root cause:** a binary host/not-host classification of the local candidate only.
*   **Fix:**
    *   New `src/lib/connectionPath.ts` reads the transport's `selectedCandidatePairId` (falling back to the nominated succeeded pair) and classifies both ends:
        *   `relay` on either end → **Relayed**
        *   `host` + `host` → **Local network**
        *   any other combination → **Direct**
        *   unknown → no path claim, just "Connected".
    *   Used by the chat header, the sender's waiting screen and the call quality badge. ICE failure now sets `unknown`.
*   **Regression tests:** `tests/connectionPath.test.ts` (4 unit tests, including selected-pair vs stale relay pair) and lifecycle L10 (UI label must match the `getStats` selected pair; passes).
*   **Risk:** display only. The label still depends on the browser exposing candidate stats; Safari / Firefox fall back to the nominated pair (not verified here: BLOCKED).

## D3: Chat after the other device left was shown as sent

*   **Reproduction (L5):** pair, then the receiver taps Back. The sender shows "Disconnected". The sender types a message. Observed: the bubble showed `… · via server relay` and no warning. The server relays to *other members of the room*, and there were none, so the message went nowhere.
*   **Root cause:** `sendChatMessage` used the signalling relay whenever its own socket was open, without knowing whether the peer was still in the room.
*   **Fix:** `src/lib/useWebRTC.ts`:
    *   The client now tracks peer presence from server messages that already exist: `ready` means present, `peer-disconnected` means absent. No protocol change.
    *   The relay fallback is used only while the peer is present. Otherwise the existing "Message not delivered — not connected to the other device." notice appears.
*   **Regression tests:** L5 now passes. E2E-13 (relay fallback when WebRTC is unavailable but the peer *is* present) still passes.
*   **Risk:** if the peer's socket drops briefly while its data channel is also down, messages in that window are now reported as not delivered instead of being sent to an empty room. That is the honest outcome.

## D4: Intermittent failure of the sender-reload test (E2E-14)

*   **Observation:** in the first full `npm run test:e2e` run after the D2/D3 changes, E2E-14 ("a reloaded sender reclaims its seat…") failed once. The run output was filtered to pass/fail lines, so **the failure detail was not captured**.
*   **Reproduction attempts:** see `test-results.md` §D4. E2E-14 alone (3 + 15 runs), alone under CPU stress (12 runs), and full-suite runs (2 plain + 3 with page-console capture) did not fail again: **1 failure in 36 executions**.
*   **Assessment:** about 1 failure in 35+ executions, root cause **not identified**. Neither D2 (display) nor D3 (chat path) is on the code path the test exercises (reload → seat reclaim → fresh handshake → file transfer). It may be a timing race in the reload / re-handshake path that already existed, or a test-timing issue. **It is not claimed to be either.**
*   **Status:** open. If it recurs, the console-capturing variant of the suite (see `test-results.md` §D4) should be used to collect evidence. The owner reload tests (guide §3.3) cover this path on real devices.

---

## L-A: In-memory receive path uses about 2× the file size in RAM (deferred, V2)

*   **Where:** receivers without the File System Access API, which means Firefox and Safari (all iOS browsers). Reproduced in Chromium by removing `showSaveFilePicker` (LF-08…LF-10).
*   **Measured (Chromium, loopback):** receiver Chrome-tree RSS peak:

    | File size | Receiver RSS peak |
    |---|---|
    | 100 MiB | 731 MiB |
    | 500 MiB | 1,543 MiB |
    | 1 GiB | 2,613 MiB |

    The baseline is about 590 MiB, so growth is roughly 2× the file size. Integrity still passed (hashes match).
*   **Root cause:** chunks are kept in an array, then copied into a `Blob` at EOF, so up to two copies exist.
*   **Why deferred:** a streaming save path for these browsers (for example a service-worker download stream) is the V2 item "streaming fallback for browsers without the File System Access API". Even halving the peak would leave memory proportional to file size, so the honest Phase 1.5 action is to document the limit.
*   **Practical consequence:** on Firefox, Safari, and especially iPhone/iPad, practical file size is bounded by device memory. The 100 GB design target does **not** apply to these browsers. The README already says the file is held in memory in these browsers; Phase 1.5 adds the measured 2× factor.

## L-B: No receiver-to-sender backpressure (deferred, V2; tracked since Phase 1.0)

*   **Measured (LF-11):** a 400 MiB transfer with receiver disk writes throttled to 8 MiB/s.
    *   The network delivered the data in about 14 s.
    *   Receiver RSS rose from about 550 MiB to **about 845 MiB** while unwritten data queued in memory, then plateaued and drained as the disk caught up.
    *   The transfer completed in 54.9 s with a matching hash.
    *   The backlog grows at about (network rate − disk rate), with no upper bound.
*   **Consequence:** a large file sent over a fast link to a slow disk (USB stick, network share, a phone) can exhaust memory. This is not yet observed on real hardware, but it follows directly from the measured behaviour.
*   **Why deferred:** a fix requires credit-based flow control in the wire protocol, which this phase's rules forbid improvising. It stays V2 item 2.

## L-C: No timeout on a pending offer (documented behaviour)

L9 observed it: a file offer stays "pending acceptance" indefinitely, and later files queue behind it. The sender can withdraw it (Cancel) and the receiver sees it as cancelled (L9 passes). This is not a defect. A timeout would be a product decision for V2.

## L-D: Page freeze is not mobile suspension (test limitation)

In L4 the receiver page was frozen for 35 s (beyond the 20 s grace period), yet the transfer **completed** on both sides. In Chrome's freeze the network process keeps answering ICE consent checks and acknowledging SCTP data. Only JavaScript stops. A real mobile OS that suspends the whole browser behaves differently. L3/L4 therefore show only that freezing JavaScript does not corrupt or falsely complete a transfer. Real backgrounding needs owner-run tests (guide §6).
