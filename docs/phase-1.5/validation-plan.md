# Phase 1.5: Validation Plan

**Scope:** a validation campaign before V2 planning. It tests the Phase 1.0 build on real browsers, devices, networks and file sizes, collects reproducible evidence, and fixes only verified defects that fit this phase. It is not a redesign.

**Baseline:** branch `claude/new-session-3xymt9` (the brief writes it as `…3xymt`; it is the same branch), commit `2b56ca2`, and the Phase 1.0 report `docs/phase-1.0-engineering-report.md`.

## 1. Status labels

| Label | Meaning |
|---|---|
| **PASS** | Executed here, every expected result observed, with evidence recorded. |
| **PARTIAL** | Executed, but only part of the scope (for example Chromium only, or loopback only), or only some expectations were met. |
| **FAIL** | Executed and an expected result was not met. |
| **BLOCKED** | Cannot be executed in this environment (no browser, device or network access). Needs the owner or other infrastructure. Never counted as a pass. |
| **NOT RUN** | Possible in principle but not executed in this campaign. Never counted as a pass. |
| **SIMULATED** | Executed with an approximation of the real condition (stated each time). Evidence of app behaviour under the approximation only. |

## 2. What this environment can and cannot execute

Established in Stage 0 (see `test-results.md` §0):

| Capability | Available here | Consequence |
|---|---|---|
| Chromium (Chrome for Testing 153, headless) on Linux x86-64 | Yes | Chromium-only automated evidence |
| Firefox, Safari / WebKit | No (not installed; no network to install) | BLOCKED; owner guide |
| iOS, Android, any physical device | No | BLOCKED; owner guide |
| External network (DNS, STUN, TURN, the production signalling host) | No: DNS does not resolve; only loopback | No cross-network or TURN evidence; owner guide |
| Two peers on one machine over a real WebRTC data channel | Yes (host candidates, UDP) | Same-machine loopback evidence only |
| Disk / memory for large files | 59 GB free disk, 16 GB RAM, 4 CPUs | Up to 8 GiB transfers feasible |
| Real camera / microphone / screen | No; Chromium fake devices only | Call lifecycle testable; media quality is not |
| Mobile backgrounding / OS suspension | No; Chrome page-freeze only | SIMULATED |

## 3. Test matrix

### 3.1 Automated (executed in this environment)

| Area | Test IDs | Tool |
|---|---|---|
| Baseline | B-01 … B-06 | `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`, network probes |
| Regression suite (Phase 1.0) | E2E-01 … E2E-18 | `npm run test:e2e` |
| Progressive large files, real disk path | LF-01 … LF-07 (100 MiB → 8 GiB) | `npm run validate:large -- --sizes=…` |
| In-memory fallback (Firefox/Safari code path, in Chromium) | LF-08 … LF-10 | `--mode=memory` |
| Slow receiver disk (backpressure limitation) | LF-11 | `--throttle=8M` |
| Lifecycle / failure campaign | L1 … L10 | `npm run test:validation` |
| Unit / server | 35 tests | `npm test` |

### 3.2 Browser and device matrix (Stage 1)

| ID | Environment | Planned coverage | Executor |
|---|---|---|---|
| BR-01 | Chromium 153 headless, Linux (this sandbox) | E2E, lifecycle, large files | Automated here |
| BR-02 | Chrome desktop (Windows / macOS), current stable | Owner guide §3 (all) | Owner |
| BR-03 | Edge desktop | Owner guide §3 | Owner |
| BR-04 | Firefox desktop | Owner guide §3 (in-memory receive path) | Owner |
| BR-05 | Safari macOS | Owner guide §3 (in-memory receive path) | Owner |
| BR-06 | Safari iPhone / iPad | Owner guide §3 and §6 (backgrounding, sleep) | Owner |
| BR-07 | Chrome Android | Owner guide §3 and §6 | Owner |
| BR-08 | Other available devices (Samsung Internet, etc.) | Owner guide §3 smoke subset | Owner |

Per environment, the record covers: browser and version, OS and version, device, network, procedure, expected result, actual result, evidence, status, and notes (template in the owner guide).

Coverage per environment: file picker and save/write, reload / tab close / session recovery, background / foreground, sleep / recovery, calls and permissions, screen share, native stop-sharing, recording cleanup, peer loss, UI state accuracy, failure messages.

### 3.3 Large files (Stage 2)

Graduated: 100 MiB → 400 MiB → 500 MiB → 1 GiB → 2 GiB, then 4 GiB and 8 GiB only after every smaller size passed (justified by disk headroom). No direct jump to 100 GB.

Per run, record:

*   size and type
*   generation method: deterministic AES-256-CTR keystream, so the same size gives the same bytes on any machine; see `tests/validation/harness.mjs`
*   source SHA-256
*   browser and OS
*   memory samples: JS heap via CDP, plus summed RSS of each Chrome process tree
*   throughput and duration
*   final UI states and whether the receiver acknowledged
*   the selected ICE candidate pair from `getStats()`
*   SHA-256 of the bytes actually on the receiver's disk
*   hash comparison
*   limitations

The synthetic files and browser profiles are deleted after each run.

Owner-run sizes on real hardware (same procedure, real save dialog) are in the owner guide §4.

### 3.4 Network and TURN (Stage 3)

| ID | Scenario | Here | Owner |
|---|---|---|---|
| NET-01 | Same machine, loopback/host candidates | Executed | n/a |
| NET-02 | Same Wi-Fi / LAN, two devices | BLOCKED | Guide §5.1 |
| NET-03 | Two independent networks (two homes / ISPs) | BLOCKED | Guide §5.2 |
| NET-04 | Wi-Fi ↔ mobile data | BLOCKED | Guide §5.3 |
| NET-05 | VPN on / off | BLOCKED | Guide §5.4 |
| NET-06 | Restricted / firewalled (UDP blocked → TURN over TCP/TLS) | BLOCKED | Guide §5.5 |
| NET-07 | Network switch during an active session | BLOCKED | Guide §5.6 |
| NET-08 | Signalling server outage (QR waiting / paired session) | Executed (L1, L2) | Guide §5.7 (production) |

Each records: connection establishment, transfer, chat fallback, calls, teardown, reconnection. The path (direct / relay) is recorded **only** from `chrome://webrtc-internals` / `about:webrtc` evidence, never guessed.

### 3.5 Failure and lifecycle (Stage 4)

| Brief item | Test ID(s) | Mode |
|---|---|---|
| Sender disconnect mid-transfer | E2E-11 | Automated |
| Receiver disconnect mid-transfer | E2E-07 | Automated |
| Receiver rejection | E2E-05 | Automated |
| Cancellation from either side | E2E-06, E2E-12, L9 | Automated |
| Reload | E2E-14 | Automated |
| Tab closure / eviction | E2E-18 (renderer crash) | Automated (approximation) |
| Mobile backgrounding | L3, L4 | SIMULATED (page freeze); real devices: guide §6 |
| Network interruption and restoration | L2 (signalling); NET-07 | Partial here; owner |
| Peer loss during chat | L5 | Automated |
| Peer loss during calls | E2E-10 | Automated |
| Screen-share stop, native control | L6 | SIMULATED native control |
| Screen-share stop, app | L6 | Automated |
| Call hang-up | E2E-09, L8 | Automated |
| Recording cleanup | L8 | Automated |
| Invalid / duplicate / oversized / early messages | E2E-15, E2E-16, server unit tests | Automated |
| Slow receiver / write path | LF-11 | Automated (throttled writer) |
| Memory pressure | LF-08…LF-11 (measured) | Measured, not induced |
| Pending acceptance timeout | L9 (observed: none exists) | Automated |
| Reconnection and seat reclaim | E2E-14, E2E-18, server unit tests | Automated |
| QR / session during signalling loss | L1 | Automated |

## 4. Limitations of this plan

*   Everything automated runs in **one browser engine on one machine**. Loopback results say nothing about NAT traversal, TURN, real latency or packet loss.
*   Throughput figures are for loopback on a 4-CPU VM and are not predictions for real networks.
*   RSS is summed across each Chrome process tree, which double-counts shared pages. Treat it as a relative measure between runs.
*   Page freeze is not a mobile OS suspending a browser: the network thread keeps running (see L4).
*   Fake camera / microphone / screen devices test lifecycle, not media quality.
