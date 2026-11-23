# Phase 1.5: Owner Device and Network Test Guide

These tests need real devices, real browsers and real networks that the automated environment does not have. Nothing in this guide has been run yet; every result starts as **NOT RUN**.

Please fill in the templates and add them to `docs/phase-1.5/test-results.md` §8 (or send them back). Mark anything you could not do as **BLOCKED** with the reason. Never mark a step PASS unless you saw the expected result yourself.

---

## 0. Before you start

1. **Deploy the build under test.** It must be the commit from `final-report.md` (or later), deployed to **both**:
   *   the frontend, and
   *   the standalone signalling server: `signaling-server.js`, which needs `signaling-core.js` next to it.

   Note the commit hash in every result template.
2. Have at least **two devices**. Ideally:
   *   a desktop / laptop with Chrome, Firefox and (macOS) Safari;
   *   an iPhone or iPad;
   *   an Android phone.
3. Use **only synthetic test files** (§2). Never use private files.
4. Free disk space: at least 2× the largest file you will test, on each device.
5. Close other heavy apps before the large-file and memory tests.
6. **Privacy:** `chrome://webrtc-internals` dumps and screenshots contain IP addresses and the ICE server configuration, including TURN usernames and passwords.
    *   Do not post them publicly or commit them.
    *   For evidence, write down only the candidate *types* (host / srflx / prflx / relay) and protocol (udp / tcp).

## 1. How to read the connection path (direct or relayed)

The app's header now says **Local network**, **Direct** or **Relayed** (Phase 1.5 fix D2), based on the pair WebRTC selected. Still, record the path from the browser's own internals where possible. That is the evidence; the label is what you are checking.

*   **Chrome / Edge (desktop):**
    1. Open a new tab at `chrome://webrtc-internals` (`edge://webrtc-internals`) **before** pairing.
    2. After pairing, expand the RTCPeerConnection entry, then *Stats Tables*.
    3. Find the `transport` row and its `selectedCandidatePairId`.
    4. Open that `candidate-pair`. Its `localCandidateId` / `remoteCandidateId` lead to `local-candidate` / `remote-candidate` rows. Read `candidateType` (host / srflx / prflx / relay) and `protocol`.
*   **Firefox (desktop):** open `about:webrtc` and expand the connection. In *ICE Stats*, the selected / nominated pair shows local and remote candidate types.
*   **Chrome Android:** use `chrome://inspect` from a desktop Chrome over USB, or `chrome://webrtc-internals` on the phone.
*   **Safari (macOS / iOS):** there is no internals page. Record the app label only and mark the path evidence as **"label only (unverified)"**.

Meaning: `relay` on either side means TURN relay. host+host means the same local network. Anything else (srflx / prflx) means direct through NAT.

## 2. Synthetic test files and hashes

Generate the same file on any machine with these commands. Record the SHA-256 **before** sending.

**macOS / Linux** (reproducible bytes):

```bash
# SIZE in bytes: 104857600 (100 MiB), 1073741824 (1 GiB), 4294967296 (4 GiB)
SIZE=1073741824
openssl enc -aes-256-ctr -nosalt \
  -K 5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a \
  -iv 00000000000000000000000000000000 -in /dev/zero 2>/dev/null \
  | head -c $SIZE > td-test-$SIZE.bin
shasum -a 256 td-test-$SIZE.bin        # macOS
sha256sum td-test-$SIZE.bin            # Linux
```

Reference hashes for the macOS/Linux command. If yours differs, the file was generated wrongly. Verified in the automated environment with OpenSSL 3.0.13.

| Size (bytes) | SHA-256 |
|---|---|
| 104857600 (100 MiB) | `9e55f4eb077bac42b9b28c8de469ae0207cc644fa3d11cb82119daae63e618e2` |
| 1073741824 (1 GiB) | `6e3ac1482e64c6a207c9d3fa18cd5193c584556c7f1c9a34f69a49bd995be7f5` |
| 4294967296 (4 GiB) | `d414b4b5e26553c60e4030626589388f2cabd91322e6590083640d2d2aeb92ea` |

**Windows (PowerShell)** (reproducible bytes, seeded generator; a different byte stream from the OpenSSL one, so record its own hash). *Not executed in the automated environment, which has no PowerShell.*

```powershell
$size = 1073741824; $path = "$PWD\td-test-$size.bin"
$rng = New-Object System.Random 42; $buf = New-Object byte[] (4MB)
$fs = [System.IO.File]::Create($path)
for ($left = $size; $left -gt 0; $left -= $n) { $n = [Math]::Min($left, $buf.Length); $rng.NextBytes($buf); $fs.Write($buf, 0, $n) }
$fs.Close(); Get-FileHash $path -Algorithm SHA256
```

**Phones:** you cannot easily hash on a phone. Use a **round trip**:

1. Send the file computer → phone.
2. Send the received file phone → computer.
3. Hash it on the computer and compare with the original.

If the hashes match, both directions were intact.

Delete test files afterwards (and clear the browser's Downloads).

## 3. Browser and device checklist (Stage 1)

Run this checklist once per environment:

*   BR-02 Chrome desktop
*   BR-03 Edge
*   BR-04 Firefox
*   BR-05 Safari macOS
*   BR-06 Safari iOS / iPadOS
*   BR-07 Chrome Android
*   BR-08 any other

Use two devices on the **same Wi-Fi** unless the step says otherwise. Device A sends and device B receives, unless noted.

| Step | Procedure | Expected result |
|---|---|---|
| C1 | A: *Send files*. B: scan the QR code | Both reach the chat screen within a few seconds; the header shows a path label |
| C2 | Repeat pairing using the 6-character code by hand | Same as C1 |
| C3 | Chat both ways | Messages appear on the other side with no "via server relay" tag |
| C4 | A sends a 1 MB synthetic file; B accepts | **Chrome / Edge:** a save dialog opens. **Firefox / Safari:** the file downloads automatically. B shows *received*; A shows *delivered* (A shows *delivered* only after B finishes) |
| C5 | Hash the received file (§2) | Hash matches the original |
| C6 | B sends a file to A (reverse direction) | Same as C4/C5 |
| C7 | A offers a file; B taps **Decline** | A shows *declined*; the next queued file is offered |
| C8 | A offers a file and taps **Cancel** before B answers | Both sides show *cancelled* |
| C9 | 100 MB transfer; A taps **Cancel** midway | Both sides show *cancelled*; no partial file left (Chrome / Edge) |
| C10 | 100 MB transfer; B taps **Cancel** midway | Both sides show *cancelled* |
| C11 | Mid-session, reload A's tab | A returns to the same chat room (not the home page) and a new file transfers |
| C12 | Mid-session, reload B's tab | B rejoins; a new file transfers |
| C13 | 100 MB transfer; close B's tab midway | A shows *failed* (within about 30 s), never *delivered* |
| C14 | Idle session; B taps **Back** | A shows *Disconnected* within about 10 s. A chat sent now says "not delivered" |
| C15 | Audio call: A calls, B accepts (allow the mic) | Both hear audio; timer runs. A hangs up: the microphone indicator turns off on both |
| C16 | Video call: mute / camera toggles | Toggles take effect; after hang-up the camera light turns **off** on both |
| C17 | Desktop only: during a video call A taps **Share**, picks a window, then taps **Share** again to stop | B sees the screen, then A's camera again; A's camera is still live |
| C18 | Desktop only: share again, then stop with the **browser's own "Stop sharing" bar** | B sees A's camera again; the app's Share button is no longer highlighted |
| C19 | Audio call: tap **Share** | A notice says screen sharing needs a video call; no screen picker appears |
| C20 | Video call: A taps **Record**, waits 10 s, then **B** hangs up | A gets a `call-recording-*.webm` download that plays; the camera light goes off |
| C21 | During a call, turn off Wi-Fi on B | A's call ends within about 30 s with "connection lost"; A's camera light goes off |
| C22 | Deny the camera / mic permission when accepting a call | Clear message ("camera or microphone unavailable"); the caller is told it was declined |
| C23 | Compare the header label with §1 internals | Label matches the candidate types (relay → Relayed, host+host → Local network, otherwise Direct) |

**Template, one per environment:**

```text
Environment ID: BR-__        Date: ____     Commit: ______
Browser + version: __________   OS + version: __________   Device: __________
Peer device / browser: __________   Network: __________ (e.g. same home Wi-Fi)
Path evidence (§1): local=____ remote=____ protocol=____  App label: ________

Step | Result (PASS / FAIL / BLOCKED / NOT RUN) | Actual result / notes | Evidence (screenshot name, hash)
C1   |        |        |
C2   |        |        |
...  |        |        |
C23  |        |        |
Problems seen (describe exactly, with time and what was on screen):
```

## 4. Large files on real hardware (Stage 2)

Automated runs here reached **8 GiB in Chromium on one machine**. On real devices, go up in steps and stop at the first failure.

**Plan:**

| Step | Size | Route |
|---|---|---|
| 1 | 100 MiB | Chrome → Chrome, two computers, same LAN |
| 2 | 1 GiB | Chrome → Chrome, two computers, same LAN |
| 3 | 4 GiB | Chrome → Chrome, two computers, same LAN |
| 4 | 10 GiB | Chrome → Chrome, two computers, same LAN |
| 5 | Larger | Only if all above pass and disk space allows |
| 6 | 500 MiB, then 1 GiB | **Firefox or Safari as receiver** (the in-memory path, see defect L-A) |
| 7 | 100 MiB | **Phone as receiver** (memory-bound) |

**For the in-memory path (step 6):** watch memory and **stop if the machine starts swapping**. Expect the receiving tab to use about 2× the file size.

**For each run:**

1. Generate the file and record its hash (§2).
2. Open the receiver's memory view:
    *   Chrome: *Task Manager* (Shift+Esc) → the tab's *Memory footprint*
    *   Firefox: `about:processes`
    *   Safari: *Activity Monitor*
3. Pair; open the internals page (§1).
4. Start the transfer, note the start time, and accept.
5. Every minute, note the receiver memory and the % shown.
6. At the end, note the time, both final statuses, and the received file's hash.
7. **Slow-disk variant** (Chrome receiver): save to a USB 2.0 stick. Watch receiver memory during the transfer; per defect L-B it may grow while the disk lags.

**Template:**

```text
Run ID: LF-O-__   Date: ____   Commit: ______
Size: ______ bytes   Source SHA-256: ______________________________
Sender: browser/OS/device ______   Receiver: browser/OS/device ______   Save location (disk / USB / downloads): ______
Network: ______   Path evidence: local=____ remote=____ proto=____   App label: ______
Start time: ____   Receiver "received" at: ____   Sender "delivered" at: ____   Duration: ____ s   Throughput: ____ MB/s
Receiver memory (start / peak / end): ____ / ____ / ____    Sender memory peak: ____
Received SHA-256: ______________________________   Match: YES / NO
Receiver acknowledged (sender showed "delivered"): YES / NO
Result: PASS / FAIL / BLOCKED     Notes / errors on screen:
```

## 5. Network and TURN (Stage 3)

Repeat a short set for each scenario: C1, C3, C4 + C5 with a 100 MiB file, C15, C14, and path evidence (§1). Use the template from §3, and fill the *Network* line precisely (ISP / carrier, Wi-Fi or cellular, VPN product).

**5.1 Same Wi-Fi / LAN (NET-02).** Expected path: host+host ("Local network"), possibly srflx if client isolation is on.

**5.2 Two independent networks (NET-03).** One device at home and one at another location or on a friend's Wi-Fi with a different ISP. Expected: usually srflx / prflx ("Direct"); sometimes relay.

**5.3 Wi-Fi ↔ mobile data (NET-04).** A on Wi-Fi, B on cellular with Wi-Fi turned **off**.

**5.4 VPN (NET-05).** Repeat 5.2 with a VPN on one side, then both. Some VPNs block UDP or peer-to-peer; record what happens.

**5.5 Restricted network: force the TURN path (NET-06).** Block outbound UDP (except DNS) on **one computer** so direct UDP cannot work. Then test. **Remove the rule afterwards.**

These firewall commands could not be executed in the automated environment (Linux sandbox, no macOS or Windows). Confirm the undo step works before relying on them, and run them only on a machine you control.

*   **macOS:**
    ```bash
    echo "block drop out proto udp from any to any port != 53" | sudo pfctl -ef -
    # ... run the test ...
    sudo pfctl -d          # undo
    ```
*   **Windows (admin PowerShell):**
    ```powershell
    New-NetFirewallRule -DisplayName "TD-test-block-udp" -Direction Outbound -Protocol UDP -RemotePort 1-52,54-65535 -Action Block
    # ... run the test ...
    Remove-NetFirewallRule -DisplayName "TD-test-block-udp"   # undo
    ```

Expected: either the connection succeeds with a **relay** candidate over **tcp** ("Relayed"), or it fails to connect. **Both are valid findings: record which.** The app uses a free public TURN service with no availability guarantee, so a failure here is important evidence, not a test mistake.

**5.6 Network switch during a session (NET-07).** Phone B on Wi-Fi, idle session:

1. Turn Wi-Fi off, so the phone moves to cellular.
2. Wait 30 s; send a chat and a small file.
3. Repeat **during** a 500 MiB transfer.

Expected: either the session recovers (ICE restart) and new transfers work, or the in-flight transfer shows *failed* on **both** sides. The sender must never show *delivered* for a file the receiver did not finish. Transfers do **not** resume (by design, see the README).

**5.7 Signalling outage in production (NET-08).** With an idle paired session, restart the signalling service (Render dashboard → Manual Deploy / Restart):

1. During the restart, send a chat and a small file. Expected: both still work over the direct link.
2. After the restart, pair a **new** pair of devices. Expected: works.
3. Also try with a sender still on the QR screen. Expected: it keeps the QR code and the code still works after the restart.

## 6. Mobile background, sleep and eviction (Stage 4)

On iPhone (Safari) and Android (Chrome), paired with a desktop:

| Step | Procedure | Expected (any honest outcome is acceptable; record which) |
|---|---|---|
| M1 | Idle session; switch to another app for 10 s, then return | Session still connected, or reconnects within about 10 s |
| M2 | Same, for 60 s | Reconnects, or shows Disconnected / reconnecting; a new chat or file works after reconnecting, or a clear state is shown |
| M3 | Lock the screen for 1 min, then 5 min | As M2 |
| M4 | During a 200 MiB transfer **to** the phone, switch apps for 10 s | The transfer completes and the hash matches (round trip §2), or **both** sides show *failed* |
| M5 | Same as M4 for 60 s | As M4; never *delivered* without *received* |
| M6 | Open many heavy apps until the OS evicts the browser tab, then reopen it | Phone as sender: returns to its room and can re-pair. Phone as receiver: rejoins through the link |
| M7 | During a call, switch apps for 30 s | Record exactly: does audio continue, does the call end, are camera / mic indicators released? |

Use the §3 template, steps M1–M7.

## 7. Returning results

*   Paste the filled templates into `docs/phase-1.5/test-results.md` §8, one block per environment / run, or send them for transcription.
*   Attach screenshots with file names referenced in the *Evidence* column. Screenshots must not show `webrtc-internals` server configuration or IP addresses.
*   Report any FAIL with:
    *   exact steps;
    *   time;
    *   what both screens showed;
    *   whether it reproduces on a second try.

Each FAIL becomes a defect entry in `defects.md`.
