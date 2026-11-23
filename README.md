# Tata Dransfer

Tata Dransfer is a peer-to-peer (P2P) file sharing and real-time communication app. Files, chat and audio/video calls go directly between two browsers over WebRTC. No server ever stores your files.

## Key Features

*   **Large file transfers, direct to disk:** In Chrome and Edge (File System Access API), incoming data is written to disk as it arrives, so memory use stays flat however big the file is. The app is designed for files up to 100 GB, but transfers of that size have not been formally tested yet. In browsers without that API (Firefox, Safari), the received file is held in memory until it finishes, which limits practical file size to what the browser can hold.
*   **Verified delivery:** The sender only shows a file as *delivered* once the receiver confirms it received every byte and finished writing it. A write failure, a short or oversized file, a cancellation or a lost connection is reported as a failure on both sides, never as success.
*   **Cancellable transfers:** Either side can cancel a queued or running transfer. A partly written file is discarded.
*   **Encrypted direct link:** Files, chat and call media on the peer-to-peer connection are encrypted in transit by WebRTC's built-in DTLS/SRTP. There is no extra application-level encryption layer. The two devices do not verify each other's keys out of band, so the encryption relies on the signalling server passing the connection setup through faithfully.
*   **Signalling fallback for chat:** If the direct link is down, chat messages, typing indicators and call setup messages fall back to the signalling server's WebSocket. **Those fallback messages are not end-to-end encrypted:** they are protected only by TLS to the server, and the server can read them. The chat marks such messages "via server relay". Files never use this fallback.
*   **Real-time communication:** Text chat with typing indicators, audio/video calls, screen sharing (in video calls) and local call recording.
*   **Connection recovery:** The signalling socket reconnects on its own, and a dropped peer connection gets an ICE restart and a 20-second grace period. A transfer that was running when the connection was lost is **not resumed**. It is marked failed and has to be sent again.

## Technology Stack

*   **Frontend:** React, TypeScript, Vite, Tailwind CSS
*   **Backend / Signalling:** Node.js, Express, WebSockets (ws)
*   **Networking:** WebRTC (RTCPeerConnection, RTCDataChannel), public STUN servers and a public TURN relay

## Getting Started

### Prerequisites

*   Node.js 18 or newer (the test suite uses Node 20+ features; Node 22 is recommended)
*   npm

### Installation

1.  Clone the repository and go into the project directory:
    ```bash
    git clone <repository-url>
    cd Tata_Dransfer--Transfer-up-to-100GB
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Start the development server (Express serves the Vite frontend and the `/signaling` WebSocket on one port):
    ```bash
    npm run dev
    ```

4.  Open `http://localhost:3000` in your browser.

### Building for Production

```bash
npm run build   # frontend into dist/, server into dist/server.cjs
npm run start
```

The deployed frontend connects to the standalone signalling server (`signaling-server.js`, started with `node signaling-server.js`). That file needs `signaling-core.js` next to it. `server.ts` and `signaling-server.js` share all their room logic through `signaling-core.js`, so they behave the same.

## Testing

```bash
npm run lint       # TypeScript type check
npm test           # signalling server + transfer protocol tests (Node's built-in test runner)
npm run build && npm run test:e2e   # real two-browser tests (needs Playwright + Chromium installed)
```

The end-to-end suite starts the production server and drives two headless Chromium pages over a real WebRTC data channel. It covers successful transfers (byte-for-byte checked), zero-byte files, the in-memory download fallback, receiver disk-write failure, decline, cancellation from either side, either device disconnecting mid-transfer, chat over the data channel and through the relay fallback, reload and crashed-tab recovery, call teardown, and scripted hostile peers sending malformed, duplicate and out-of-order protocol messages. Playwright is not a package dependency, so the suite skips itself if it is not installed.

## Security and Privacy

*   Files go only over the peer-to-peer data channel. The signalling server never receives file data, and nothing is stored on any server.
*   When a direct connection is impossible, WebRTC may route the (still DTLS-encrypted) traffic through a public TURN relay.
*   The signalling server validates every message (structure, room code format, role), limits message size and rate, caps the number of rooms, and lets a device reclaim its seat in a room only with the token it was given when it joined.
*   Room codes are short (6 hexadecimal characters). Anyone who learns or guesses a code while the room is waiting for its second device can join it. Share codes only with the person you are sending to.
*   File names from the other device are sanitised before use (path parts, control and bidirectional-override characters, reserved names).

## Known Limitations

*   Transfers do not resume after a disconnect or reload.
*   Very large files have not been tested end to end at 100 GB.
*   The receiver cannot slow the sender down if its disk is slower than the network; writes are batched but not flow-controlled.
*   Screen sharing is only available during video calls.

## License
MIT license
