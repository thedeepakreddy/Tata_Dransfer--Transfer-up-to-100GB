# Phase 1.0: Critical Bug Fixing and Engineering Hardening Report

**Overall status: PARTIAL.** All verified critical defects in scope are fixed and covered by tests that ran and passed: 29 unit/integration tests and 10 real two-browser end-to-end tests. The status is PARTIAL, not PASS, for three reasons. Testing used headless Chromium on one machine only (no Firefox, Safari or mobile, and no real network conditions). Transfers far larger than 400 MB were not exercised. And a few architectural limits (listed below) were deliberately deferred to V2.

## 1. Verified defects and root causes

Each item was confirmed by reading the code, and where possible by a failing test against the original code. The end-to-end suite was run against the original code too: 8 of 10 tests failed. Tests 4, 6, 7 and 10 failed on behaviour. Tests 1, 2, 3 and 5 also fail partly because the sender's label changed from "sent" to "delivered".

### Transfers

| # | Defect | Root cause |
|---|---|---|
| T1 | **False success.** The sender marked a file "complete" as soon as its send loop ended, even when the loop exited early because the channel closed. | `streamFile` set `status: 'complete'` unconditionally after the loop. No receiver acknowledgment existed. |
| T2 | **Disk write failures never surfaced.** A failed write on the receiver left the file stuck at "receiving N%", and the sender still showed success. | Writes were chained promises with no `catch`. `handleFileEof` threw an unhandled rejection, and nothing was sent back to the sender. |
| T3 | **No completeness check.** The receiver accepted EOF without checking the byte count, and accepted more bytes than announced. | No size verification in `handleFileChunk` / `handleFileEof`. |
| T4 | **Chunk misrouting.** Chunks arriving with no accepted file were routed to "the first incomplete buffer", including files still waiting for acceptance. | A fallback `Object.keys(...).find(...)` in `handleFileChunk`. |
| T5 | **Hung transfers on connection loss.** A peer vanishing mid-transfer left both sides showing "sending/receiving" forever. Root cause, found by the E2E test: when the other device disappears, ICE fails but `RTCDataChannel.readyState` can keep reporting `open` indefinitely. The grace timer treated "channel open" as "peer alive", so the session was never declared lost. The send loop waited for a buffer that never drained. | `dc.onclose` only logged. The grace timer checked `isPeerLive()` (data channel state) instead of the peer connection state. |
| T6 | **Duplicate-ID corruption.** Selecting the same `File` object twice overwrote the id stored on it, so queue entries no longer matched their offers. | The file id was stored as `(file as any)._fileId` on the shared `File` object. |
| T7 | **Progress barely updated.** Sender progress only updated when `bytesSent` was an exact multiple of 160 KB, which with real stream chunk sizes rarely happens. The receiver triggered a React render for every 16 KB chunk (about 6 million renders for 100 GB). | A modulo-based throttle on the sender; no throttle on the receiver. |
| T8 | **Per-chunk disk writes.** One `write()` per 16 KB chunk, each holding its buffer in a promise chain. | No batching. |
| T9 | **Leaks.** Blob URLs were never revoked. Writable file handles and queued buffers survived leaving the room. | `disconnect()` did not release transfer resources. |
| T10 | **No cancellation.** | Not implemented. |
| T11 | **Unguarded parsing.** Malformed data-channel JSON threw inside the message handler. | Bare `JSON.parse`. |
| T12 | **Zero-byte files** rendered `NaN` progress. | `bytes / size` with `size = 0`. |

### File safety

| # | Defect | Root cause |
|---|---|---|
| F1 | Peer-supplied file names went straight into the save picker and download name: path parts, control characters, bidi-override extension spoofing (`invoice‮gpj.exe`), reserved Windows names. A name the picker rejects also silently fell back to in-memory buffering. | No sanitisation. |
| F2 | Peer-supplied `size` / `fileId` / `mimeType` were not validated (negative, fractional or `NaN` sizes, arbitrary ids). | No validation of `meta`. |

### Signalling server (`server.ts` and `signaling-server.js`)

| # | Defect | Root cause |
|---|---|---|
| S1 | **Rejected peers could inject messages and fake disconnects** (`server.ts`). A socket refused with "Room is full" still had `currentRoomId` set, so it could relay offers, ICE candidates and chat into the room, and its disconnect broadcast `peer-disconnected` to the real members. | `currentRoomId = roomId` was assigned before the capacity check. |
| S2 | **Anyone with the code could kick a participant.** Same-role replacement terminated the existing peer for any newcomer claiming the same role, and roles were not validated at all. | Replacement had no proof of identity. |
| S3 | **Spurious `peer-disconnected` after a legitimate replacement.** The terminated socket's close handler still had its room id, so it announced a disconnect to the new pair right after `ready`, and the new joiner's UI showed "Disconnected". | Membership was not cleared before `terminate()`. |
| S4 | **Ghost membership.** Joining a second room did not leave the first. | No leave-before-join. |
| S5 | **No input limits.** No validation of message shape, room id or role; the ws default 100 MB frame limit; no rate limit; unlimited rooms. | Missing validation and limits. |
| S6 | **Two diverging implementations.** Earlier fixes had been applied to one copy and not the other. | Duplicated code. |

### Chat and privacy

| # | Defect | Root cause |
|---|---|---|
| C1 | The UI said "End-to-End Encrypted" for all chat, but the fallback sends plaintext JSON through the signalling server. The README claimed AES-GCM encryption, which does not exist anywhere in the code. | Inaccurate copy. |
| C2 | **A peer could crash the other side's UI or spoof system notices.** Chat relayed via the server was inserted verbatim: a non-string `text` crashes React rendering, and `senderRole: 'system'` / `isSystemMessage` rendered as an app notice. Non-string names crashed `.substring`. | No validation of peer payloads. |
| C3 | Failed chat sends were silent. | No feedback. |

### Calls and media

| # | Defect | Root cause |
|---|---|---|
| M1 | **Microphone left live after a call that used screen sharing.** Sharing replaced the tracked local stream with the screen stream, so cleanup never stopped the original microphone track. | One ref was used both for "what is previewed" and "what must be stopped". |
| M2 | **Stopping a share from the browser's own "Stop sharing" button did nothing.** | `onended` captured a stale `stopScreenShare` whose `isScreenSharing` was `false`. |
| M3 | Ending a screen share previewed the dead screen stream instead of the camera, and mute stopped working while sharing (the screen stream has no audio). | Same as M1. |
| M4 | Starting a share in an audio-only call left the screen capture running. | Returned before stopping the capture. |
| M5 | **Camera/mic left running if the call ended while the permission prompt was open**, or if cleanup ran before React re-rendered. | `localStreamRef` was only synced by an effect, and the call state was not re-checked after `getUserMedia`. |
| M6 | **Calls never ended when the peer vanished.** Camera and mic stayed on with frozen video. | No link between connection loss and the call. |
| M7 | Unanswered calls rang forever; a caller hanging up showed "ended" instead of "missed" to the callee. | No ring timeout; no `incoming` case on `call-end`. |
| M8 | **Recording outlived the call.** The canvas render loop, AudioContext and MediaRecorder kept running and the recording was lost. An unsupported MediaRecorder threw an unhandled error. | The recorder belonged to the component, not the call lifecycle. |
| M9 | Late tracks after hang-up could flip the UI back to "active". Peer-supplied call `mode` and SDP were not validated, and `call-offer` was accepted while idle. | Missing state guards. |
| M10 | A server error (for example "Room is full" on a reconnect) tore down a session whose peer link was still working. | The `error` handler did not check link state. |

## 2. Fixes implemented

**Transfer protocol v2** (backward compatible, documented in `src/lib/transferProtocol.ts`):

*   New messages `file-ack {fileId, ok, bytes, reason?}` and `file-cancel {fileId, reason?, error?}`. Old peers ignore unknown message types.
*   Versions are negotiated through a `proto` field added to `name_exchange`.
*   The sender's states are: pending → offered → transferring → **verifying** → complete. "Delivered" only appears after a positive ack with the exact byte count. A legacy (v1) peer yields **unconfirmed** instead of a false "complete".
*   The ack timeout is 10 minutes, to allow for finalising very large files.
*   Status transitions are enforced in one place (`updateFile` + `canTransition`). Terminal states are final, so late or duplicate events cannot revive a failed transfer.
*   Chunks are routed only to the accepted file on the channel it was accepted on; stray chunks are dropped. Overflow and short files fail with a reason sent back to the sender.
*   Disk write errors abort the partial file, mark it failed and notify the sender.
*   Losing the channel, or the 20-second grace period expiring, fails in-flight transfers. Offers that were never accepted survive and are re-offered on a new channel.
*   Cancel works from either side, for queued, offered or running transfers.
*   Disk writes are batched to 1 MB and progress updates are throttled to 200 ms.
*   `disconnect()` releases queues, timers, writable handles and Blob URLs.

**Signalling:** `signaling-core.js` now holds all room logic, used by both servers. It adds:

*   strict message, room code and role validation, a 64 KB frame limit, a per-socket token-bucket rate limit, a join-attempt cap and a room cap;
*   at most one sender and one receiver per room;
*   same-role replacement only with the **seat token** issued at join (or when the old socket is already dead). The client stores the token in `sessionStorage` for reloads;
*   no membership, relaying or disconnect broadcasts for rejected sockets, and no spurious disconnects on replacement;
*   no internal error details sent to clients.

**Calls:** a separate camera stream ref, a ref-based screen-share state, re-checking the call state after `getUserMedia`, `handleConnectionLost()` (called on data-channel close, peer-connection replacement and grace expiry), a 45-second ring timeout, "missed call" logging, a recorder owned by the call lifecycle (stopped and saved on hang-up), and validation of peer call messages.

**Chat:** peer payloads are validated; the sender role is always decided locally; relayed messages are labelled "via server relay"; undelivered messages produce a system notice; the encryption wording is accurate.

**Docs and UI copy:** the README and home page now describe the encryption, the large-file behaviour per browser, resumability and the fallback accurately. The product positioning (100 GB design target, P2P, no storage) is kept.

## 3. Files modified

| File | Change |
|---|---|
| `signaling-core.js` | **new**: shared signalling logic |
| `server.ts`, `signaling-server.js` | thin wrappers around the core |
| `src/lib/transferProtocol.ts` | **new**: pure protocol rules |
| `src/lib/useWebRTC.ts` | transfer engine, signalling client and chat fixes |
| `src/lib/useCallManager.ts` | call, media and recording lifecycle fixes |
| `src/components/ChatRoom.tsx` | status labels, cancel button, relay marker, encryption note |
| `src/components/Home.tsx`, `src/components/Sender.tsx` | accurate copy and statuses |
| `README.md`, `package.json` | `test` and `test:e2e` scripts |
| `tests/signaling.test.mjs`, `tests/transferProtocol.test.ts`, `tests/e2e/transfer.e2e.mjs` | **new** tests |

No new dependencies were added. Tests use Node's built-in `node:test`, with `tsx` (already a dev dependency) to load TypeScript. The E2E suite uses a Playwright install if one is present.

## 4. Tests executed (all actually run)

*   `npm run lint` (`tsc --noEmit`): **pass**
*   `npm run build` (Vite + esbuild): **pass** (the existing warning about a chunk over 500 kB is unchanged)
*   `npm test`: **29/29 pass**
    *   17 signalling integration tests against a real ws server: pairing and initiator, relay isolation, room full, rejected-peer injection and fake disconnect, token-gated replacement, no spurious disconnect on replacement, guessed tokens refused, leave and cleanup, malformed / invalid room / invalid role, duplicate role, pre-join messages, room switching, oversize frames, rate limit, room cap, room expiry, `parseMessage` robustness
    *   12 protocol unit tests: transitions, filename sanitisation, metadata validation, overflow, completion verification, ack evaluation, chat/name/mode validation
*   `npm run test:e2e`: **10/10 pass** (headless Chromium, two pages, production build). Covers successful 5 MB transfer (SHA-256 verified, writes batched), in-memory fallback download (SHA-256 verified), zero-byte file, disk write failure (both sides fail, partial file aborted), decline then next file, sender cancel mid-transfer (400 MB), receiver disconnect mid-transfer (400 MB), chat over the data channel, video-call teardown releasing all tracks, peer loss during a call.

**Not tested:** Firefox, Safari, mobile browsers, real NAT / TURN paths, transfers above 400 MB, screen sharing (it cannot be driven headlessly without extra flags), the recording UI, and session restore across a real reload.

## 5. Remaining known bugs and limitations

*   No transfer resume after disconnect or reload (documented).
*   **No receiver-to-sender flow control:** if the receiver's disk is slower than the network, pending writes pile up in memory. This is rare on LAN-speed WebRTC, but unbounded.
*   The in-memory fallback (Firefox, Safari) cannot handle very large files.
*   If the data channel closes while the receiver is finalising a file, the receiver can show "received" while the sender shows "failed". This is conservative, but inconsistent.
*   Mute / camera buttons only re-render on the next state change (they update within about a second during a call).
*   Call renegotiation and ICE-restart offers share one peer connection without "perfect negotiation" glare handling.
*   Recording freezes while its tab is in the background (`requestAnimationFrame` is throttled).
*   A replacement without a token is refused until the server's heartbeat drops a half-open old socket (about 50 s), for example when reopening a room in a different tab.

## 6. Security issues that remain

*   **Short room codes:** 6 hex characters (about 16.7M) and no global brute-force protection beyond the per-socket join cap and rate limit. Someone guessing codes across many sockets could land in a waiting room.
*   **Fallback chat is readable by the signalling server** (now clearly labelled).
*   **No key verification:** DTLS fingerprints are exchanged through the signalling server, so a malicious server could man-in-the-middle the connection.
*   The TURN credentials are a public shared relay (`openrelay`), with no availability or privacy guarantee.
*   No per-IP connection limit (left out to avoid penalising shared NATs).
*   The signalling server does not check origins on upgrade.

## 7. Architectural items for V2 planning

1.  A framed binary protocol: a file id and offset header on each chunk, enabling concurrent files, integrity checks and resume.
2.  Credit-based flow control from receiver to sender, tied to disk write progress.
3.  Resumable transfers (offset negotiation, re-opening the file handle).
4.  End-to-end integrity (a streaming hash in the ack) and optional key verification (a short authentication string comparing DTLS fingerprints).
5.  Longer or higher-entropy room codes, server-side join throttling, an origin allow-list.
6.  Splitting `useWebRTC` (about 1,400 lines) into transport, transfer and chat modules with a testable transfer engine behind a channel interface.
7.  Perfect negotiation for media and ICE-restart renegotiation.
8.  A streaming fallback for browsers without the File System Access API (for example a service-worker download stream).
9.  Hosted TURN with short-lived credentials.

## 8. Deliberately deferred

*   Everything in section 7. Each needs a wire-protocol or architecture change beyond this phase.
*   A hard size cap for the in-memory fallback. This would refuse files that might currently succeed; it should be decided together with item 8 above.
*   Removing the old ad-hoc `test_*.mjs` scripts in the repository root. They still work against the new server and were left in place.

## Deployment note

`signaling-server.js` now imports `./signaling-core.js`. The Render service must deploy the repository root (as it does today) so both files are present. The client sends an extra `token` field on join and receives a new `joined` message. Older clients ignore `joined` and simply cannot reclaim a seat with a token, which is the old "Room is full" behaviour for a live seat.
