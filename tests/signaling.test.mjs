// Integration tests for the shared signalling core (signaling-core.js).
// Each test runs a real ws server on an ephemeral port and real ws clients.
// Run with: npm test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { attachSignaling, MAX_MESSAGE_BYTES, parseMessage } from '../signaling-core.js';

let wss;
let core;
let url;
const clients = [];

async function startServer(options = {}) {
  wss = new WebSocketServer({ port: 0, maxPayload: MAX_MESSAGE_BYTES });
  await new Promise((r) => wss.once('listening', r));
  core = attachSignaling(wss, { log: () => {}, ...options });
  url = `ws://127.0.0.1:${wss.address().port}`;
}

/** A client that records every message it receives. */
async function client() {
  const ws = new WebSocket(url);
  ws.inbox = [];
  ws.waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    ws.inbox.push(msg);
    ws.waiters = ws.waiters.filter((w) => !w(msg));
  });
  ws.closed = new Promise((r) => ws.once('close', (code) => r(code)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  clients.push(ws);
  return ws;
}

/** Wait for the next message (already received or future) matching pred. */
function waitFor(ws, pred, timeoutMs = 2000) {
  const found = ws.inbox.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    ws.waiters.push((msg) => {
      if (!pred(msg)) return false;
      clearTimeout(t);
      resolve(msg);
      return true;
    });
  });
}

const sendJson = (ws, msg) => ws.send(JSON.stringify(msg));
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const join = (ws, roomId, role, token) => sendJson(ws, { type: 'join', roomId, role, token });

async function pair(roomId = 'ROOM01') {
  const a = await client();
  join(a, roomId, 'sender');
  const aJoined = await waitFor(a, (m) => m.type === 'joined');
  const b = await client();
  join(b, roomId, 'receiver');
  const bJoined = await waitFor(b, (m) => m.type === 'joined');
  await waitFor(a, (m) => m.type === 'ready');
  await waitFor(b, (m) => m.type === 'ready');
  return { a, b, aToken: aJoined.token, bToken: bJoined.token };
}

beforeEach(async () => {
  await startServer();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  core.stop();
  await new Promise((r) => wss.close(r));
});

test('two peers are paired and exactly one is the initiator', async () => {
  const { a, b } = await pair();
  const ra = a.inbox.find((m) => m.type === 'ready');
  const rb = b.inbox.find((m) => m.type === 'ready');
  assert.equal(ra.isInitiator !== rb.isInitiator, true);
  assert.equal(core.rooms.get('ROOM01').peers.size, 2);
});

test('relays signalling only to the other peer', async () => {
  const { a, b } = await pair();
  sendJson(a, { type: 'offer', payload: { sdp: 'x' } });
  const got = await waitFor(b, (m) => m.type === 'offer');
  assert.deepEqual(got.payload, { sdp: 'x' });
  await tick();
  assert.equal(a.inbox.some((m) => m.type === 'offer'), false);
});

test('a third peer is rejected when the room is full', async () => {
  const { a, b } = await pair();
  const c = await client();
  join(c, 'ROOM01', 'receiver');
  const err = await waitFor(c, (m) => m.type === 'error');
  assert.equal(err.code, 'ROOM_FULL');
  assert.equal(err.message, 'Room is full');
  assert.equal(core.rooms.get('ROOM01').peers.size, 2);
  // The legitimate receiver was not kicked out.
  await tick();
  assert.equal(b.readyState, WebSocket.OPEN);
  assert.equal(a.inbox.some((m) => m.type === 'peer-disconnected'), false);
});

test('a rejected peer cannot relay into the room and its close does not notify members', async () => {
  const { a, b } = await pair();
  const c = await client();
  join(c, 'ROOM01', 'sender');
  await waitFor(c, (m) => m.type === 'error');
  sendJson(c, { type: 'chat', payload: { id: 'evil', text: 'injected' } });
  sendJson(c, { type: 'offer', payload: { sdp: 'evil' } });
  c.close();
  await c.closed;
  await tick(150);
  for (const peer of [a, b]) {
    assert.equal(peer.inbox.some((m) => m.type === 'chat' || m.type === 'offer'), false);
    assert.equal(peer.inbox.some((m) => m.type === 'peer-disconnected'), false);
  }
});

test('same-role replacement requires the seat token', async () => {
  const { a, aToken } = await pair();
  // Without the token: rejected, original stays.
  const intruder = await client();
  join(intruder, 'ROOM01', 'sender');
  assert.equal((await waitFor(intruder, (m) => m.type === 'error')).code, 'ROOM_FULL');
  assert.equal(a.readyState, WebSocket.OPEN);

  // With the token (a reloaded tab): replaces the stale socket.
  const again = await client();
  join(again, 'ROOM01', 'sender', aToken);
  const joined = await waitFor(again, (m) => m.type === 'joined');
  assert.equal(joined.token, aToken);
  await waitFor(again, (m) => m.type === 'ready');
  assert.equal(await a.closed, 1006); // terminated
  assert.equal(core.rooms.get('ROOM01').peers.size, 2);
});

test('replacing a stale peer does not send a spurious peer-disconnected', async () => {
  const { a, b, aToken } = await pair();
  const again = await client();
  join(again, 'ROOM01', 'sender', aToken);
  await waitFor(again, (m) => m.type === 'ready');
  await a.closed;
  await tick(150);
  assert.equal(b.inbox.some((m) => m.type === 'peer-disconnected'), false);
  assert.equal(again.inbox.some((m) => m.type === 'peer-disconnected'), false);
  // Receiver gets a fresh ready so it can renegotiate with the new socket.
  assert.equal(b.inbox.filter((m) => m.type === 'ready').length, 2);
});

test('a guessed token is not accepted', async () => {
  await pair();
  const c = await client();
  join(c, 'ROOM01', 'sender', 'A'.repeat(24));
  assert.equal((await waitFor(c, (m) => m.type === 'error')).code, 'ROOM_FULL');
});

test('leaving notifies the remaining peer and empty rooms are deleted', async () => {
  const { a, b } = await pair();
  sendJson(a, { type: 'leave' });
  await waitFor(b, (m) => m.type === 'peer-disconnected');
  assert.equal(core.rooms.get('ROOM01').peers.size, 1);
  b.close();
  await b.closed;
  await tick();
  assert.equal(core.rooms.has('ROOM01'), false);
});

test('rejects malformed JSON, non-object messages and invalid join fields', async () => {
  const c = await client();
  c.send('not json');
  assert.equal((await waitFor(c, (m) => m.type === 'error')).code, 'MALFORMED');
  c.inbox.length = 0;
  c.send('[1,2,3]');
  assert.equal((await waitFor(c, (m) => m.type === 'error')).code, 'MALFORMED');
  c.inbox.length = 0;
  c.send('null');
  assert.equal((await waitFor(c, (m) => m.type === 'error')).code, 'MALFORMED');
  c.inbox.length = 0;
  join(c, '../../etc', 'sender');
  assert.equal((await waitFor(c, (m) => m.type === 'error')).code, 'INVALID_ROOM');
  c.inbox.length = 0;
  join(c, 'X'.repeat(500), 'sender');
  assert.equal((await waitFor(c, (m) => m.type === 'error')).code, 'INVALID_ROOM');
  c.inbox.length = 0;
  join(c, 'ROOM02', 'admin');
  assert.equal((await waitFor(c, (m) => m.type === 'error')).code, 'INVALID_ROLE');
  c.inbox.length = 0;
  join(c, 'ROOM02', undefined);
  assert.equal((await waitFor(c, (m) => m.type === 'error')).code, 'INVALID_ROLE');
  assert.equal(core.rooms.size, 0);
  // The socket is still usable afterwards.
  join(c, 'ROOM02', 'sender');
  await waitFor(c, (m) => m.type === 'joined');
});

test('two peers with the same role cannot share a room', async () => {
  const a = await client();
  join(a, 'ROOM03', 'sender');
  await waitFor(a, (m) => m.type === 'joined');
  const b = await client();
  join(b, 'ROOM03', 'sender');
  assert.equal((await waitFor(b, (m) => m.type === 'error')).code, 'ROOM_FULL');
  assert.equal(core.rooms.get('ROOM03').peers.size, 1);
});

test('messages before joining are not relayed anywhere', async () => {
  const { a, b } = await pair();
  const c = await client();
  sendJson(c, { type: 'chat', roomId: 'ROOM01', payload: { text: 'hi' } });
  await tick(150);
  assert.equal(a.inbox.some((m) => m.type === 'chat'), false);
  assert.equal(b.inbox.some((m) => m.type === 'chat'), false);
});

test('switching rooms leaves the previous room', async () => {
  const { a, b } = await pair();
  join(a, 'ROOM09', 'sender');
  await waitFor(a, (m) => m.type === 'joined' && m.roomId === 'ROOM09');
  await waitFor(b, (m) => m.type === 'peer-disconnected');
  assert.equal(core.rooms.get('ROOM01').peers.size, 1);
  assert.equal(core.rooms.get('ROOM09').peers.size, 1);
});

test('oversized frames close the connection', async () => {
  const c = await client();
  c.send('x'.repeat(MAX_MESSAGE_BYTES + 10));
  assert.equal(await c.closed, 1009);
});

test('message floods are rate limited', async () => {
  core.stop();
  await new Promise((r) => wss.close(r));
  await startServer({ rateBurst: 10, ratePerSec: 1 });
  const c = await client();
  for (let i = 0; i < 30; i++) sendJson(c, { type: 'typing' });
  assert.equal(await c.closed, 1008);
});

test('room creation is capped', async () => {
  core.stop();
  await new Promise((r) => wss.close(r));
  await startServer({ maxRooms: 1 });
  const a = await client();
  join(a, 'ROOMAA', 'sender');
  await waitFor(a, (m) => m.type === 'joined');
  const b = await client();
  join(b, 'ROOMBB', 'sender');
  assert.equal((await waitFor(b, (m) => m.type === 'error')).code, 'SERVER_BUSY');
});

test('inactive rooms expire and their sockets are closed', async () => {
  core.stop();
  await new Promise((r) => wss.close(r));
  await startServer({ roomTtlMs: 50, cleanupIntervalMs: 30, heartbeatMs: 60000 });
  const a = await client();
  join(a, 'ROOMTT', 'sender');
  await waitFor(a, (m) => m.type === 'joined');
  assert.equal(await a.closed, 1000);
  assert.equal(core.rooms.size, 0);
});

test('parseMessage never throws', () => {
  for (const raw of ['', '{', '1', '"s"', '{"type":1}', Buffer.from([0xff, 0xfe])]) {
    assert.equal(parseMessage(raw).ok, false);
  }
  assert.equal(parseMessage('{"type":"join"}').ok, true);
});
