// signaling-core.js
//
// The room / relay logic shared by both signalling entry points:
//   - server.ts            (Express + Vite dev/prod server, path /signaling)
//   - signaling-server.js  (standalone server deployed to Render)
//
// Keeping one implementation stops the two from drifting apart, which is how
// several of the bugs fixed here crept in (one copy was patched, the other
// was not).
//
// The server never sees file data. It pairs two sockets in a room and relays
// WebRTC signalling (offer / answer / ICE) plus a small set of application
// messages that are used as a fallback when the peer-to-peer data channel is
// not open. Those fallback messages are NOT end-to-end encrypted: they pass
// through this server in plaintext (protected only by TLS to the server).

import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

/** Largest single WebSocket frame accepted. SDP blobs are a few KB; chat text is small. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

const VALID_ROLES = new Set(['sender', 'receiver']);
// Room codes are generated as 6 upper-case hex characters, but accept a little
// more so older links keep working. Anything else is rejected outright.
const ROOM_ID_RE = /^[A-Za-z0-9_-]{4,32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Message types relayed verbatim to the other peer in the room. */
const RELAY_TYPES = new Set([
  'offer',
  'answer',
  'ice-candidate',
  'chat',
  'typing',
  'call-signal',
  'name_exchange',
]);

const DEFAULTS = {
  roomTtlMs: 30 * 60 * 1000,
  heartbeatMs: 25000,
  maxMissedPongs: 2,
  cleanupIntervalMs: 60 * 1000,
  maxRooms: 5000,
  maxJoinsPerSocket: 20,
  // Token bucket per socket: a burst of ICE candidates or typing events is
  // fine, a flood is not.
  rateBurst: 200,
  ratePerSec: 50,
  log: (...args) => console.log(...args),
};

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket is going away */
    }
  }
}

/**
 * Validate a raw incoming frame. Returns the parsed message object or an
 * error string. Never throws.
 * @param {unknown} raw
 * @returns {{ ok: true, msg: Record<string, any> } | { ok: false, error: string }}
 */
export function parseMessage(raw) {
  let text;
  try {
    text = typeof raw === 'string' ? raw : raw.toString();
  } catch {
    return { ok: false, error: 'Malformed message' };
  }
  if (text.length > MAX_MESSAGE_BYTES) return { ok: false, error: 'Message too large' };
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Malformed message' };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, error: 'Malformed message' };
  }
  if (typeof msg.type !== 'string') return { ok: false, error: 'Malformed message' };
  return { ok: true, msg };
}

export function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_RE.test(roomId);
}

export function isValidRole(role) {
  return typeof role === 'string' && VALID_ROLES.has(role);
}

/**
 * Attach room management, relaying and heartbeats to a ws WebSocketServer.
 * The server should be created with `maxPayload: MAX_MESSAGE_BYTES`.
 *
 * @param {import('ws').WebSocketServer} wss
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function attachSignaling(wss, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const log = opts.log;

  /** @type {Map<string, { id: string, peers: Set<WebSocket>, lastActivity: number }>} */
  const rooms = new Map();
  /** Per-socket state lives here rather than as ad-hoc properties on the socket. */
  const state = new WeakMap();

  function leaveRoom(ws, { notify = true } = {}) {
    const st = state.get(ws);
    if (!st || !st.roomId) return;
    const roomId = st.roomId;
    st.roomId = null;
    const room = rooms.get(roomId);
    // Only a peer that was actually admitted is removed and announced. A socket
    // that was rejected (room full, bad role) never had membership, so it must
    // not be able to tell real members that "the peer" left.
    if (!room || !room.peers.has(ws)) return;
    room.peers.delete(ws);
    room.lastActivity = Date.now();
    log(`Peer (${st.role}) left room ${roomId}. Remaining: ${room.peers.size}`);
    if (notify) {
      for (const peer of room.peers) send(peer, { type: 'peer-disconnected', roomId });
    }
    if (room.peers.size === 0) rooms.delete(roomId);
  }

  function reject(ws, message, code) {
    send(ws, { type: 'error', code, message });
  }

  function handleJoin(ws, st, msg) {
    const { roomId, role, token } = msg;
    st.joins += 1;
    if (st.joins > opts.maxJoinsPerSocket) {
      reject(ws, 'Too many join attempts', 'RATE_LIMITED');
      ws.close(1008, 'Too many join attempts');
      return;
    }
    if (!isValidRoomId(roomId)) return reject(ws, 'Invalid room code', 'INVALID_ROOM');
    if (!isValidRole(role)) return reject(ws, 'Invalid role', 'INVALID_ROLE');

    // Re-sending join for the room you are already in is harmless; switching
    // rooms leaves the old one first so the socket is never a ghost member.
    if (st.roomId && st.roomId !== roomId) leaveRoom(ws);

    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= opts.maxRooms) return reject(ws, 'Server is busy, try again shortly', 'SERVER_BUSY');
      room = { id: roomId, peers: new Set(), lastActivity: Date.now() };
      rooms.set(roomId, room);
    }

    if (!room.peers.has(ws)) {
      // A room holds exactly one sender and one receiver.
      let sameRole = null;
      for (const peer of room.peers) {
        if (state.get(peer)?.role === role) sameRole = peer;
      }

      if (sameRole) {
        // Replacing a peer with the same role is how a reloaded or reconnecting
        // device takes its seat back. It is only allowed when the newcomer
        // proves it is that device (the token handed out on first join), or
        // the seat's socket is already dead. Otherwise anyone who learned the
        // code could kick a participant out.
        const holder = state.get(sameRole);
        const tokenMatches = typeof token === 'string' && TOKEN_RE.test(token) && token === holder.token;
        const holderDead = sameRole.readyState !== WebSocket.OPEN;
        if (!tokenMatches && !holderDead) {
          if (room.peers.size === 0) rooms.delete(roomId);
          return reject(ws, 'Room is full', 'ROOM_FULL');
        }
        // Drop membership *before* terminating so the replaced socket's close
        // handler does not broadcast a spurious peer-disconnected to the room.
        room.peers.delete(sameRole);
        holder.roomId = null;
        log(`Replaced stale ${role} in room ${roomId}`);
        try { sameRole.terminate(); } catch { /* already gone */ }
        // The rightful owner keeps its token; a newcomer that only got in
        // because the old socket was dead gets a fresh one, never the old.
        if (tokenMatches) st.token = holder.token;
      } else if (room.peers.size >= 2) {
        return reject(ws, 'Room is full', 'ROOM_FULL');
      }

      if (!st.token) {
        st.token = typeof token === 'string' && TOKEN_RE.test(token)
          ? token
          : randomBytes(18).toString('base64url');
      }
      st.role = role;
      st.roomId = roomId;
      room.peers.add(ws);
    }

    room.lastActivity = Date.now();
    log(`Peer (${role}) joined room ${roomId}. Total: ${room.peers.size}`);
    send(ws, { type: 'joined', roomId, role, token: st.token });

    if (room.peers.size === 2) {
      const [first, second] = Array.from(room.peers);
      send(first, { type: 'ready', roomId, isInitiator: true });
      send(second, { type: 'ready', roomId, isInitiator: false });
    }
  }

  function takeToken(st) {
    const now = Date.now();
    const elapsed = (now - st.bucketAt) / 1000;
    st.bucketAt = now;
    st.bucket = Math.min(opts.rateBurst, st.bucket + elapsed * opts.ratePerSec);
    if (st.bucket < 1) return false;
    st.bucket -= 1;
    return true;
  }

  wss.on('connection', (ws) => {
    const st = {
      roomId: null,
      role: null,
      token: null,
      joins: 0,
      missedPongs: 0,
      bucket: opts.rateBurst,
      bucketAt: Date.now(),
    };
    state.set(ws, st);

    ws.on('pong', () => {
      st.missedPongs = 0;
      const room = st.roomId && rooms.get(st.roomId);
      if (room) room.lastActivity = Date.now();
    });

    ws.on('message', (raw, isBinary) => {
      try {
        if (!takeToken(st)) {
          reject(ws, 'Too many messages', 'RATE_LIMITED');
          ws.close(1008, 'Rate limit exceeded');
          return;
        }
        if (isBinary) return reject(ws, 'Binary frames are not accepted', 'MALFORMED');
        const parsed = parseMessage(raw);
        if (!parsed.ok) return reject(ws, parsed.error, 'MALFORMED');
        const msg = parsed.msg;

        if (msg.type === 'join') return handleJoin(ws, st, msg);
        if (msg.type === 'leave') return leaveRoom(ws);

        if (RELAY_TYPES.has(msg.type)) {
          if (!st.roomId) return; // not admitted to any room: nothing to relay to
          const room = rooms.get(st.roomId);
          if (!room || !room.peers.has(ws)) return;
          room.lastActivity = Date.now();
          for (const peer of room.peers) {
            if (peer !== ws) send(peer, { type: msg.type, payload: msg.payload, roomId: st.roomId });
          }
          return;
        }
        // Unknown types are ignored (forward compatibility).
      } catch (err) {
        // Never echo internal details back to the client.
        log('Signalling error:', err && err.message);
      }
    });

    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => leaveRoom(ws));
  });

  // Browsers answer pings automatically, but a backgrounded tab is frozen and
  // cannot. Count misses rather than dropping on the first one, and treat a
  // pong as room activity so a quiet room is not reaped while peers are live.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const st = state.get(ws);
      if (!st) continue;
      if (st.missedPongs >= opts.maxMissedPongs) {
        ws.terminate();
        continue;
      }
      st.missedPongs += 1;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }, opts.heartbeatMs);

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
      if (now - room.lastActivity > opts.roomTtlMs) {
        rooms.delete(roomId);
        for (const peer of room.peers) {
          const st = state.get(peer);
          if (st) st.roomId = null;
          try { peer.close(1000, 'Room expired'); } catch { /* already closing */ }
        }
        log(`Cleaned up inactive room ${roomId}`);
      }
    }
  }, opts.cleanupIntervalMs);

  const stop = () => {
    clearInterval(heartbeat);
    clearInterval(cleanup);
  };
  wss.on('close', stop);

  return { rooms, stop };
}
