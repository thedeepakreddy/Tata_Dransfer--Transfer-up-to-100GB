// signaling-server.js
// Deploy this to Render as a Node.js Web Service.
// Start command: node signaling-server.js
// Requires the "ws" dependency and signaling-core.js next to this file.
//
// All room / relay logic lives in signaling-core.js and is shared with
// server.ts, so the local dev server and the deployed server behave the same.

import { WebSocketServer } from 'ws';
import { attachSignaling, MAX_MESSAGE_BYTES } from './signaling-core.js';

const PORT = Number(process.env.PORT) || 8080;
const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_BYTES });

attachSignaling(wss);

console.log(`Signaling server running on port ${PORT}`);
