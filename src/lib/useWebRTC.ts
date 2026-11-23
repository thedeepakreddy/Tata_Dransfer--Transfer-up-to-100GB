import { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useCallManager } from './useCallManager';
import {
  PROTOCOL_VERSION,
  canTransition,
  cleanReason,
  evaluateAck,
  isTerminal,
  isValidFileId,
  parseControlMessage,
  sanitizePeerName,
  validateChatPayload,
  validateFileMeta,
  verifyReceived,
  type FileMetadata,
  type FileStatus,
} from './transferProtocol';

export type Role = 'sender' | 'receiver' | null;
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'transferring' | 'complete' | 'error' | 'reconnecting' | 'disconnected';
// The signalling socket is a separate transport from the peer connection.
// It is only needed to introduce the two devices; once the data channel is
// open, losing it does not end the session.
export type SignalingState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export type ConnectionType = 'local' | 'relayed' | 'unknown';
export type CallState = 'idle' | 'ringing' | 'incoming' | 'connecting' | 'active' | 'rejected' | 'ended';
export type CallMode = 'audio' | 'video' | null;
export interface CallQuality {
  qualityTier: string;
  pathLabel: string;
}

export type { FileMetadata } from './transferProtocol';

export interface FileProgress {
  fileId: string;
  name: string;
  size: number;
  bytesTransferred: number;
  status: FileStatus;
  blobUrl?: string;
  /** Human-readable reason when status is 'error'. */
  error?: string;
}

export interface ChatMessage {
  id: string;
  senderRole: Role | 'system';
  text?: string;
  fileId?: string;
  isSystemMessage?: boolean;
  timestamp: number;
  /**
   * True when the message went through the signalling server because the
   * peer-to-peer channel was down. Such messages are protected only by TLS to
   * the server and are visible to the server; they are not end-to-end encrypted.
   */
  viaRelay?: boolean;
}

const CHUNK_SIZE = 16384; // 16 KB
// Pause sending while this much is queued in the data channel's buffer.
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1 MB
// Receiver: coalesce chunks into larger disk writes (fewer, bigger writes are
// far cheaper than one write per 16 KB chunk on a multi-GB file).
const WRITE_BATCH_BYTES = 1024 * 1024; // 1 MB
// Throttle React progress updates; one setState per 16 KB chunk is ~6 million
// renders for a 100 GB file.
const PROGRESS_INTERVAL_MS = 200;
// How long a sender waits, after its last byte, for the receiver to confirm
// the file was written and verified. Finalising a very large file on disk can
// take a while, so this is generous.
const ACK_TIMEOUT_MS = 10 * 60 * 1000;

interface OutgoingFile {
  fileId: string;
  file: File;
  /** Channel the offer ('meta') was last sent on. */
  offeredOn?: RTCDataChannel;
}

interface ActiveSend {
  fileId: string;
  dc: RTCDataChannel;
  cancelled: boolean;
  /** Set when the peer aborted the transfer; shown as the failure reason. */
  peerReason?: string;
  peerError?: boolean;
  wake: (() => void) | null;
}

interface PendingAck {
  size: number;
  dc: RTCDataChannel;
  timer: ReturnType<typeof setTimeout>;
}

interface IncomingFile {
  meta: FileMetadata;
  receivedBytes: number;
  /** In-memory fallback when the File System Access API is unavailable. */
  chunks: ArrayBuffer[];
  writable?: any; // FileSystemWritableFileStream
  pending: ArrayBuffer[];
  pendingBytes: number;
  writeChain: Promise<void>;
  /** The channel this transfer was accepted on; chunks on any other are ignored. */
  dc?: RTCDataChannel;
  accepting?: boolean;
  eofReceived?: boolean;
  failed?: string;
  lastProgressAt: number;
}

/** dc.send that reports failure instead of throwing. */
function safeSend(dc: RTCDataChannel | null | undefined, data: string | ArrayBuffer | ArrayBufferView): boolean {
  if (!dc || dc.readyState !== 'open') return false;
  try {
    dc.send(data as any);
    return true;
  } catch (e) {
    console.error('Data channel send failed', e);
    return false;
  }
}

const VIDEO_CONSTRAINTS_HD = {
  width: { ideal: 1280, min: 640 },
  height: { ideal: 720, min: 480 },
  frameRate: { ideal: 30, min: 20 },
};

const VIDEO_CONSTRAINTS_FALLBACK = {
  width: { ideal: 854, min: 480 },
  height: { ideal: 480, min: 360 },
  frameRate: { ideal: 24, min: 15 },
};

const BITRATE_720P = 2_500_000; // 2.5 Mbps
const BITRATE_480P = 1_200_000; // 1.2 Mbps
const AUDIO_BITRATE = 64_000;   // 64 kbps Opus

export function useWebRTC(userName: string = '') {
  const [role, setRole] = useState<Role>(null);
  const [roomId, setRoomId] = useState<string>('');
  const [status, setStatus] = useState<ConnectionState>('idle');
  const [signalingState, setSignalingState] = useState<SignalingState>('idle');
  const [connectionType, setConnectionType] = useState<ConnectionType>('unknown');
  const [filesProgress, setFilesProgress] = useState<Record<string, FileProgress>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [peerName, setPeerName] = useState<string>('');
  const [isPeerTyping, setIsPeerTyping] = useState(false);

  // Call state
  const [callState, setCallState] = useState<CallState>('idle');
  const [callMode, setCallMode] = useState<CallMode>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callQuality, setCallQuality] = useState<CallQuality | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // Call refs
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const qualityMonitorHandleRef = useRef<NodeJS.Timeout | null>(null);
  const activeResolutionTierRef = useRef<'720p'|'480p'>('720p');
  const callManagerRef = useRef<ReturnType<typeof useCallManager> | null>(null);

  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);


  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Signalling socket lifecycle
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isInitiatorRef = useRef(false);
  // Peer connection recovery
  const peerGraceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastIceRestartRef = useRef(0);

  // Refs for state accessed inside callbacks
  const roomIdRef = useRef<string>('');
  const roleRef = useRef<Role>(null);
  const statusRef = useRef<ConnectionState>('idle');
  const userNameRef = useRef(userName);

  // Sync refs
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => { roleRef.current = role; }, [role]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { userNameRef.current = userName; }, [userName]);
  
  // File transfer state
  const sendQueueRef = useRef<OutgoingFile[]>([]);
  const activeSendRef = useRef<ActiveSend | null>(null);
  const pendingAcksRef = useRef<Map<string, PendingAck>>(new Map());
  const receiveBufferRef = useRef<Record<string, IncomingFile>>({});
  // The file this peer has accepted and is currently receiving chunks for.
  const activeReceiveIdRef = useRef<string | null>(null);
  // Synchronous mirror of each file's status, used to enforce legal state
  // transitions (React state lands a render later, too late to reject a
  // duplicate or late event that arrives in the same tick).
  const fileStatusRef = useRef<Record<string, FileStatus>>({});
  const blobUrlsRef = useRef<Set<string>>(new Set());
  // Protocol version the peer advertised in name_exchange (1 = legacy, no acks).
  const peerProtoRef = useRef(1);
  // Signalling seat token, proves this device owns its seat when rejoining.
  const seatTokenRef = useRef<string | null>(null);

  const callManager = useCallManager(
    pcRef, wsRef, dcRef, userNameRef, setMessages, roleRef,
    callState, setCallState, callMode, setCallMode,
    localStream, setLocalStream, remoteStream, setRemoteStream,
    callQuality, setCallQuality, isScreenSharing, setIsScreenSharing,
    isRecording, setIsRecording
  );
  callManagerRef.current = callManager;

  const getWsUrl = () => {
    const loc = window.location;
    if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      return `ws://${loc.host}/signaling`;
    }
    // In production, always point to the dedicated Render signaling server
    return `wss://tata-dransfer-by-askdeepakai.onrender.com`;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  // The session lives on the peer-to-peer channel, not the signalling socket.
  // The socket only introduces the two devices; once the data channel is open,
  // losing the socket is recoverable and must not end the session.
  const isPeerLive = () => dcRef.current?.readyState === 'open';

  function scheduleReconnect() {
    if (!shouldReconnectRef.current || !roomIdRef.current) return;
    if (reconnectTimerRef.current) return;
    const attempt = reconnectAttemptsRef.current;
    // 1s, 2s, 4s, 8s, then capped at 15s.
    const delay = Math.min(1000 * 2 ** attempt, 15000);
    reconnectAttemptsRef.current = attempt + 1;
    setSignalingState('reconnecting');
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectSocket();
    }, delay);
  }

  function connectSocket() {
    const room = roomIdRef.current;
    const clientRole = roleRef.current;
    if (!room || !clientRole) return;

    clearReconnectTimer();
    setSignalingState(reconnectAttemptsRef.current > 0 ? 'reconnecting' : 'connecting');

    if (wsRef.current) {
      const stale = wsRef.current;
      wsRef.current = null;
      try { stale.close(); } catch { /* already closing */ }
    }

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      reconnectAttemptsRef.current = 0;
      setSignalingState('open');
      ws.send(JSON.stringify({
        type: 'join',
        roomId: room,
        role: clientRole,
        // Lets a reloaded or reconnecting device reclaim its own seat. The
        // server refuses same-role replacement without it.
        ...(seatTokenRef.current ? { token: seatTokenRef.current } : {}),
      }));
    };

    ws.onmessage = async (event) => {
      try {
        const msg = parseControlMessage(typeof event.data === 'string' ? event.data : '');
        if (!msg) return;
        if (msg.type === 'joined') {
          if (typeof msg.token === 'string' && msg.token.length <= 64) {
            seatTokenRef.current = msg.token;
            persistSession();
          }
        } else if (msg.type === 'ready') {
          // Re-joining after a socket reconnect also produces 'ready'. If the
          // peer channel is already up this is not a fresh pairing, and starting
          // a new handshake would destroy the working connection.
          if (isPeerLive()) {
            if (statusRef.current === 'reconnecting') setStatus('connected');
            return;
          }
          isInitiatorRef.current = !!msg.isInitiator;
          setStatus('connected');
          if (msg.isInitiator) {
            await startWebRTC(true);
          }
        } else if (msg.type === 'offer') {
          await handleOffer(msg.payload);
        } else if (msg.type === 'answer') {
          await handleAnswer(msg.payload);
        } else if (msg.type === 'ice-candidate') {
          await handleIceCandidate(msg.payload);
        } else if (msg.type === 'chat') {
          // Relayed through the signalling server: not end-to-end encrypted.
          receiveChat(msg.payload, true);
        } else if (msg.type === 'typing') {
          setIsPeerTyping(true);
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = setTimeout(() => setIsPeerTyping(false), 2500);
        } else if (msg.type === 'name_exchange') {
          setPeerName(sanitizePeerName(msg.payload?.userName));
        } else if (msg.type === 'call-signal') {
          const payload = msg.payload;
          if (payload && typeof payload === 'object' && typeof payload.type === 'string' && payload.type.startsWith('call-')) {
            callManagerRef.current?.handleCallMessage(payload);
          }
        } else if (msg.type === 'peer-disconnected') {
          // Only the other device's *socket* dropped. They may simply have
          // backgrounded the app; the peer-to-peer link can be perfectly fine.
          if (isPeerLive()) return;
          setStatus('disconnected');
          setErrorMsg('Peer disconnected');
        } else if (msg.type === 'error') {
          const text = cleanReason(msg.message) || 'Signalling error';
          // A refused rejoin must not tear down a session whose peer-to-peer
          // link is still working; the socket is only needed for introductions.
          if (isPeerLive()) {
            console.warn('Signalling server error while peer link is live:', text);
            return;
          }
          setErrorMsg(text);
          setStatus('error');
        }
      } catch (err) {
        console.error("Error parsing WS message", err);
      }
    };

    ws.onerror = (error) => {
      // A socket that has already been replaced (React StrictMode remounts, or a
      // reconnect) still fires onerror as it tears down. Ignore those so a dead
      // socket cannot raise an error banner over a live connection.
      if (wsRef.current !== ws) return;
      console.error('WebSocket error:', error);
      // Only surface this if we never got connected at all. Once the peer link
      // exists, or a retry is already in flight, it is not the user's problem.
      if (!isPeerLive() && reconnectAttemptsRef.current === 0 && statusRef.current === 'connecting') {
        setErrorMsg('Signaling server connection error. If you are in a preview iframe, please open the app in a new tab.');
        setStatus('error');
      }
    };

    ws.onclose = (event) => {
      if (wsRef.current !== ws) return;
      console.log('WebSocket closed:', event.code, event.reason);
      setSignalingState('closed');
      // Backgrounding a tab routinely kills this socket. Keep the session alive
      // while the peer channel is up, and try to bring the socket back.
      if (!isPeerLive() && statusRef.current !== 'error' && statusRef.current !== 'idle') {
        setStatus('reconnecting');
      }
      scheduleReconnect();
    };
  }

  const initSignaling = useCallback((room: string, clientRole: Role) => {
    setStatus('connecting');
    setRole(clientRole);
    setRoomId(room);
    roomIdRef.current = room;
    roleRef.current = clientRole;
    statusRef.current = 'connecting';
    shouldReconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    // Reuse the seat token only if it belongs to this exact room and role.
    seatTokenRef.current = null;
    try {
      const saved = JSON.parse(sessionStorage.getItem('td:session') || 'null');
      if (saved?.room === room && saved?.role === clientRole && typeof saved.token === 'string') {
        seatTokenRef.current = saved.token;
      }
    } catch { /* private mode or corrupt entry */ }
    // Remember the room so a discarded or reloaded page can rejoin it.
    persistSession();
    connectSocket();
  }, []);

  function persistSession() {
    try {
      sessionStorage.setItem('td:session', JSON.stringify({
        room: roomIdRef.current,
        role: roleRef.current,
        ...(seatTokenRef.current ? { token: seatTokenRef.current } : {}),
      }));
    } catch { /* private mode */ }
  }

  const clearPeerGraceTimer = () => {
    if (peerGraceTimerRef.current) {
      clearTimeout(peerGraceTimerRef.current);
      peerGraceTimerRef.current = null;
    }
  };

  // How long a wobbling peer connection is given to recover before the session
  // is called dead. Backgrounded tabs routinely take several seconds.
  const PEER_GRACE_MS = 20000;

  function startPeerGraceTimer() {
    if (peerGraceTimerRef.current) return;
    peerGraceTimerRef.current = setTimeout(() => {
      peerGraceTimerRef.current = null;
      // Judge by the peer connection, not the data channel: when the other
      // device vanishes, ICE fails but the channel can keep reporting 'open'
      // indefinitely, which used to leave transfers and calls hanging forever.
      // The connection is not closed here, so if ICE recovers later the
      // session (chat, new transfers) comes back; in-flight work cannot.
      if (pcRef.current?.connectionState === 'connected') return;
      setStatus('disconnected');
      failTransfersOnChannel(null, 'Connection lost');
      callManagerRef.current?.handleConnectionLost();
    }, PEER_GRACE_MS);
  }

  // 'failed' is recoverable: ICE can be restarted over the existing connection,
  // which keeps the data channel and any in-flight transfer intact.
  async function attemptIceRestart() {
    const pc = pcRef.current;
    if (!pc || pc.signalingState === 'closed') return;
    // Only the side that made the original offer drives renegotiation.
    if (!isInitiatorRef.current) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastIceRestartRef.current < 8000) return;
    lastIceRestartRef.current = now;
    try {
      if (typeof pc.restartIce === 'function') pc.restartIce();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      wsRef.current?.send(JSON.stringify({
        type: 'offer',
        roomId: roomIdRef.current,
        payload: offer,
      }));
    } catch (e) {
      console.error('ICE restart failed', e);
    }
  }

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) {
      // Media tracks belong to the old connection; a call cannot survive this.
      callManagerRef.current?.handleConnectionLost();
      pcRef.current.close();
    }
    iceCandidateQueueRef.current = [];
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        { urls: 'stun:openrelay.metered.ca:80' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'ice-candidate',
          roomId: roomIdRef.current,
          payload: event.candidate,
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
      if (pcRef.current !== pc) return;

      if (pc.connectionState === 'connected') {
        clearPeerGraceTimer();
        setStatus('connected');
        checkConnectionType(pc);
        return;
      }

      if (pc.connectionState === 'disconnected') {
        // Transient by definition: ICE keeps probing and usually recovers on its
        // own. This is exactly what a backgrounded tab looks like, so give it a
        // grace window instead of declaring the session over.
        setStatus('reconnecting');
        startPeerGraceTimer();
        return;
      }

      if (pc.connectionState === 'failed') {
        setStatus('reconnecting');
        void attemptIceRestart();
        startPeerGraceTimer();
        return;
      }

      if (pc.connectionState === 'closed') {
        clearPeerGraceTimer();
        setStatus('disconnected');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        setConnectionType('relayed');
      }
    };

    pcRef.current = pc;
    callManagerRef.current?.attachTrackHandler();
    return pc;
  }, []);

  const checkConnectionType = async (pc: RTCPeerConnection) => {
    try {
      const stats = await pc.getStats();
      let type: ConnectionType = 'unknown';
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localCandidate = stats.get(report.localCandidateId);
          if (localCandidate) {
            type = localCandidate.candidateType === 'host' ? 'local' : 'relayed';
          }
        }
      });
      setConnectionType(type);
    } catch (e) {
      console.error(e);
    }
  };

  const startWebRTC = async (isInitiator: boolean) => {
    if (!isInitiator) {
      console.log('Not initiator, waiting for offer...');
      return;
    }
    
    console.log('Is initiator, creating offer...');
    const pc = createPeerConnection();
    
    // Create DataChannel (Sender)
    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    setupDataChannel(dc);
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    wsRef.current?.send(JSON.stringify({
      type: 'offer',
      roomId: roomIdRef.current,
      payload: offer
    }));
  };

  const flushIceQueue = async () => {
    if (pcRef.current && iceCandidateQueueRef.current.length > 0) {
      const queue = [...iceCandidateQueueRef.current];
      iceCandidateQueueRef.current = [];
      for (const candidate of queue) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error flushing ice candidate', e);
        }
      }
    }
  };

  const handleOffer = async (offer: RTCSessionDescriptionInit) => {
    const existing = pcRef.current;
    // An offer arriving while the session is live is a renegotiation (an ICE
    // restart), not a new pairing. Reusing the connection keeps the open data
    // channel and any in-flight transfer alive; rebuilding it would kill both.
    const isRenegotiation = !!existing && isPeerLive() && existing.signalingState !== 'closed';
    const pc = isRenegotiation ? existing! : createPeerConnection();

    if (!isRenegotiation) {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };
    }

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushIceQueue();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    wsRef.current?.send(JSON.stringify({
      type: 'answer',
      roomId: roomIdRef.current,
      payload: answer
    }));
  };

  const handleAnswer = async (answer: RTCSessionDescriptionInit) => {
    if (pcRef.current) {
      await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      flushIceQueue();
    }
  };

  const handleIceCandidate = async (candidate: RTCIceCandidateInit) => {
    if (pcRef.current) {
      if (pcRef.current.remoteDescription && pcRef.current.remoteDescription.type) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding received ice candidate', e);
        }
      } else {
        iceCandidateQueueRef.current.push(candidate);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // File status bookkeeping
  // ---------------------------------------------------------------------------

  const addFile = (entry: FileProgress) => {
    fileStatusRef.current[entry.fileId] = entry.status;
    setFilesProgress(prev => ({ ...prev, [entry.fileId]: entry }));
  };

  /**
   * Apply a change to a file's progress, enforcing the transition rules in
   * transferProtocol.ts. Returns false (and changes nothing) for an illegal
   * transition, e.g. a late event trying to revive a failed transfer.
   */
  const updateFile = (fileId: string, patch: Partial<FileProgress>): boolean => {
    const current = fileStatusRef.current[fileId];
    if (!current) return false;
    if (patch.status) {
      if (!canTransition(current, patch.status)) {
        console.warn(`Ignoring illegal file transition ${current} -> ${patch.status} for ${fileId}`);
        return false;
      }
      fileStatusRef.current[fileId] = patch.status;
    } else if (isTerminal(current)) {
      return false; // no progress updates after a final state
    }
    setFilesProgress(prev => (prev[fileId] ? { ...prev, [fileId]: { ...prev[fileId], ...patch } } : prev));
    return true;
  };

  const hasTransfersInFlight = () =>
    !!activeSendRef.current ||
    sendQueueRef.current.length > 0 ||
    pendingAcksRef.current.size > 0 ||
    Object.values<IncomingFile>(receiveBufferRef.current).some(b => !!b.dc);

  // The overall status flips back from 'transferring' once nothing is moving.
  // It never overrides 'reconnecting' / 'disconnected'.
  const settleStatus = () => {
    if (statusRef.current === 'transferring' && !hasTransfersInFlight()) setStatus('complete');
  };

  // ---------------------------------------------------------------------------
  // Data channel
  // ---------------------------------------------------------------------------

  const setupDataChannel = (dc: RTCDataChannel) => {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1024 * 512; // 512 KB threshold

    const handleOpen = () => {
      setStatus('connected');
      peerProtoRef.current = 1; // until the peer says otherwise
      safeSend(dc, JSON.stringify({ type: 'name_exchange', userName: userNameRef.current, proto: PROTOCOL_VERSION }));
      // Either side can send files. Re-offer the head of the queue (an offer
      // made on a previous, now dead channel never reached the peer).
      if (sendQueueRef.current.length > 0 && !activeSendRef.current) {
        processSendQueue();
      }
    };

    if (dc.readyState === 'open') {
      handleOpen();
    } else {
      dc.onopen = handleOpen;
    }

    dc.onclose = () => {
      console.log('Data channel closed');
      // Anything that was streaming over this channel is lost. Pending offers
      // survive and are re-sent if a new channel opens.
      failTransfersOnChannel(dc, 'Connection lost during transfer');
      if (dcRef.current === dc) callManagerRef.current?.handleConnectionLost();
    };

    dc.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        handleFileChunk(event.data as ArrayBuffer, dc);
        return;
      }
      const msg = parseControlMessage(event.data);
      if (!msg) {
        console.warn('Ignoring malformed data channel message');
        return;
      }
      switch (msg.type) {
        case 'name_exchange':
          setPeerName(sanitizePeerName(msg.userName));
          peerProtoRef.current = typeof msg.proto === 'number' && msg.proto >= 2 ? msg.proto : 1;
          break;
        case 'meta':
          handleFileMetadata(msg);
          break;
        case 'file-accept':
          handleFileAccept(msg.fileId, dc);
          break;
        case 'file-decline':
          handleFileDecline(msg.fileId);
          break;
        case 'file-cancel':
          handlePeerCancel(msg);
          break;
        case 'file-ack':
          handleFileAck(msg);
          break;
        case 'eof':
          void handleFileEof(msg.fileId, dc);
          break;
        case 'typing':
          setIsPeerTyping(true);
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = setTimeout(() => setIsPeerTyping(false), 2500);
          break;
        case 'chat':
          receiveChat(msg, false);
          break;
        default:
          if (msg.type.startsWith('call-')) callManagerRef.current?.handleCallMessage(msg);
      }
    };

    dcRef.current = dc;
  };

  /**
   * Fail every transfer bound to a channel that is gone (or, with dc = null,
   * every in-flight transfer). Offers not yet accepted are left alone.
   */
  function failTransfersOnChannel(dc: RTCDataChannel | null, reason: string) {
    const active = activeSendRef.current;
    if (active && (dc === null || active.dc === dc)) {
      if (dc === null) {
        // Declared dead while the channel may still report 'open': stop now.
        active.cancelled = true;
        active.peerError = true;
        active.peerReason = reason;
      }
      // Otherwise the streaming loop notices the closed channel itself.
      active.wake?.();
    }
    for (const [fileId, pending] of pendingAcksRef.current) {
      if (dc === null || pending.dc === dc) {
        clearTimeout(pending.timer);
        pendingAcksRef.current.delete(fileId);
        updateFile(fileId, { status: 'error', error: `${reason} before the receiver confirmed the file` });
      }
    }
    for (const [fileId, buf] of Object.entries<IncomingFile>(receiveBufferRef.current)) {
      // Transfers already finalising (EOF received) are allowed to finish.
      if (buf.dc && !buf.eofReceived && (dc === null || buf.dc === dc)) {
        failReceive(fileId, reason, false);
      }
    }
    settleStatus();
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  const sendFiles = useCallback((files: File[]) => {
    files.forEach(file => {
      // The id lives beside the File, not on it: the same File object can be
      // selected twice, and tagging it would make both entries share one id.
      const fileId = uuidv4();
      sendQueueRef.current.push({ fileId, file });
      addFile({ fileId, name: file.name, size: file.size, bytesTransferred: 0, status: 'pending' });
      setMessages(prev => [...prev, {
        id: uuidv4(),
        senderRole: roleRef.current,
        fileId,
        timestamp: Date.now()
      }]);
    });

    if (dcRef.current?.readyState === 'open' && !activeSendRef.current) {
      processSendQueue();
    }
  }, []);

  /** Offer the file at the head of the queue, unless one is already in progress. */
  function processSendQueue() {
    if (activeSendRef.current) return;
    const next = sendQueueRef.current[0];
    if (!next) {
      settleStatus();
      return;
    }
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return; // resumes when a channel opens
    // Already offered on this channel: wait for the answer, do not re-offer.
    if (next.offeredOn === dc && fileStatusRef.current[next.fileId] === 'waiting_for_accept') return;

    const meta: FileMetadata = {
      type: 'meta',
      fileId: next.fileId,
      name: next.file.name,
      size: next.file.size,
      mimeType: next.file.type || 'application/octet-stream'
    };
    if (!safeSend(dc, JSON.stringify(meta))) return;
    next.offeredOn = dc;
    setStatus('transferring');
    updateFile(next.fileId, { status: 'waiting_for_accept' });
  }

  function handleFileAccept(fileId: unknown, dc: RTCDataChannel) {
    const next = sendQueueRef.current[0];
    // Only the file currently on offer can be accepted, once. A duplicate or
    // stale accept (e.g. for a cancelled offer) is ignored.
    if (!next || next.fileId !== fileId || activeSendRef.current) return;
    if (fileStatusRef.current[next.fileId] !== 'waiting_for_accept') return;
    sendQueueRef.current.shift();
    void streamFile(next, dc);
  }

  function handleFileDecline(fileId: unknown) {
    const idx = sendQueueRef.current.findIndex(f => f.fileId === fileId);
    if (idx === -1) return;
    const [entry] = sendQueueRef.current.splice(idx, 1);
    updateFile(entry.fileId, { status: 'declined' });
    if (idx === 0) processSendQueue();
  }

  /** Resolve when the channel has drained, closed, or the transfer was cancelled. */
  const waitForDrain = (dc: RTCDataChannel, ctl: ActiveSend) =>
    new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(poll);
        dc.removeEventListener('bufferedamountlow', done);
        dc.removeEventListener('close', done);
        dc.removeEventListener('error', done);
        ctl.wake = null;
        resolve();
      };
      // Some browsers occasionally miss 'bufferedamountlow'; re-check periodically.
      const poll = setTimeout(done, 1000);
      dc.addEventListener('bufferedamountlow', done);
      dc.addEventListener('close', done);
      dc.addEventListener('error', done);
      ctl.wake = done;
    });

  async function streamFile(entry: OutgoingFile, dc: RTCDataChannel) {
    const { fileId, file } = entry;
    const ctl: ActiveSend = { fileId, dc, cancelled: false, wake: null };
    activeSendRef.current = ctl;
    setStatus('transferring');
    updateFile(fileId, { status: 'transferring', bytesTransferred: 0 });

    let bytesSent = 0;
    let lastProgressAt = 0;
    let failure: string | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      reader = file.stream().getReader();
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength; offset += CHUNK_SIZE) {
          // Backpressure: never queue more than MAX_BUFFERED_AMOUNT in the channel.
          while (!ctl.cancelled && dc.readyState === 'open' && dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
            await waitForDrain(dc, ctl);
          }
          if (ctl.cancelled) break outer;
          if (dc.readyState !== 'open') {
            failure = 'Connection lost during transfer';
            break outer;
          }
          const chunk = value.slice(offset, offset + CHUNK_SIZE);
          if (!safeSend(dc, chunk)) {
            failure = 'Could not send data to the other device';
            break outer;
          }
          bytesSent += chunk.byteLength;
          const now = Date.now();
          if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
            lastProgressAt = now;
            updateFile(fileId, { bytesTransferred: bytesSent });
          }
        }
      }
    } catch (e) {
      console.error('Reading file failed', e);
      failure = 'Could not read the file on this device';
    } finally {
      try { await reader?.cancel(); } catch { /* already finished */ }
    }

    if (activeSendRef.current === ctl) activeSendRef.current = null;

    if (ctl.cancelled) {
      if (ctl.peerError) {
        updateFile(fileId, { status: 'error', bytesTransferred: bytesSent, error: ctl.peerReason || 'The receiver aborted the transfer' });
      } else {
        updateFile(fileId, { status: 'cancelled', bytesTransferred: bytesSent });
      }
    } else if (!failure && bytesSent !== file.size) {
      failure = 'The file changed while it was being sent';
    }

    if (!ctl.cancelled && failure) {
      safeSend(dc, JSON.stringify({ type: 'file-cancel', fileId, reason: failure, error: true }));
      updateFile(fileId, { status: 'error', bytesTransferred: bytesSent, error: failure });
    } else if (!ctl.cancelled) {
      // Every byte has been handed to the channel. That is NOT success: the
      // receiver still has to get, write and verify it.
      if (!safeSend(dc, JSON.stringify({ type: 'eof', fileId }))) {
        updateFile(fileId, { status: 'error', bytesTransferred: bytesSent, error: 'Connection lost before the transfer finished' });
      } else if (peerProtoRef.current >= 2) {
        updateFile(fileId, { status: 'verifying', bytesTransferred: bytesSent });
        const timer = setTimeout(() => {
          if (!pendingAcksRef.current.delete(fileId)) return;
          updateFile(fileId, { status: 'error', error: 'The receiver did not confirm the file' });
          settleStatus();
        }, ACK_TIMEOUT_MS);
        pendingAcksRef.current.set(fileId, { size: file.size, dc, timer });
      } else {
        // A legacy peer cannot acknowledge; do not claim success we cannot know.
        updateFile(fileId, { status: 'unconfirmed', bytesTransferred: bytesSent });
      }
    }

    processSendQueue();
    settleStatus();
  }

  function handleFileAck(msg: Record<string, any>) {
    const fileId = msg.fileId;
    if (!isValidFileId(fileId)) return;
    const pending = pendingAcksRef.current.get(fileId);
    if (!pending) return; // late or duplicate acknowledgment
    clearTimeout(pending.timer);
    pendingAcksRef.current.delete(fileId);
    const verdict = evaluateAck(msg, pending.size);
    if (verdict.ok) {
      updateFile(fileId, { status: 'complete', bytesTransferred: pending.size });
    } else {
      updateFile(fileId, { status: 'error', error: verdict.reason });
    }
    settleStatus();
  }

  /** The peer cancelled or failed a transfer, in either direction. */
  function handlePeerCancel(msg: Record<string, any>) {
    const fileId = msg.fileId;
    if (!isValidFileId(fileId)) return;
    const reason = cleanReason(msg.reason);
    const isError = msg.error === true;

    // We are sending it.
    const active = activeSendRef.current;
    if (active && active.fileId === fileId) {
      active.cancelled = true;
      active.peerError = isError;
      active.peerReason = reason;
      active.wake?.();
      return;
    }
    const pending = pendingAcksRef.current.get(fileId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingAcksRef.current.delete(fileId);
      updateFile(fileId, isError
        ? { status: 'error', error: reason || 'The receiver could not save the file' }
        : { status: 'cancelled' });
      settleStatus();
      return;
    }
    const idx = sendQueueRef.current.findIndex(f => f.fileId === fileId);
    if (idx !== -1) {
      sendQueueRef.current.splice(idx, 1);
      updateFile(fileId, { status: 'cancelled' });
      if (idx === 0) processSendQueue();
      return;
    }

    // We are receiving it.
    if (receiveBufferRef.current[fileId]) {
      discardIncoming(fileId);
      updateFile(fileId, isError
        ? { status: 'error', error: reason || 'The sender aborted the transfer' }
        : { status: 'cancelled' });
      settleStatus();
    }
  }

  /** Cancel a transfer from this side (sending or receiving). */
  const cancelTransfer = useCallback((fileId: string) => {
    const status = fileStatusRef.current[fileId];
    if (!status || isTerminal(status) || status === 'verifying') return;

    // Sending side
    const active = activeSendRef.current;
    if (active && active.fileId === fileId) {
      active.cancelled = true;
      active.wake?.();
      safeSend(active.dc, JSON.stringify({ type: 'file-cancel', fileId }));
      return; // streamFile records the final state
    }
    const idx = sendQueueRef.current.findIndex(f => f.fileId === fileId);
    if (idx !== -1) {
      sendQueueRef.current.splice(idx, 1);
      if (status === 'waiting_for_accept') safeSend(dcRef.current, JSON.stringify({ type: 'file-cancel', fileId }));
      updateFile(fileId, { status: 'cancelled' });
      if (idx === 0) processSendQueue();
      settleStatus();
      return;
    }

    // Receiving side
    const buf = receiveBufferRef.current[fileId];
    if (buf) {
      if (status === 'waiting_for_accept') {
        declineFileOffer(fileId);
        return;
      }
      safeSend(buf.dc ?? dcRef.current, JSON.stringify({ type: 'file-cancel', fileId }));
      discardIncoming(fileId);
      updateFile(fileId, { status: 'cancelled' });
      settleStatus();
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Receiving
  // ---------------------------------------------------------------------------

  function handleFileMetadata(raw: unknown) {
    const meta = validateFileMeta(raw);
    if (!meta) {
      console.warn('Ignoring invalid file offer');
      return;
    }
    // A repeated offer (e.g. re-sent after a reconnect) or a reused id is not a new file.
    if (receiveBufferRef.current[meta.fileId] || fileStatusRef.current[meta.fileId]) return;

    receiveBufferRef.current[meta.fileId] = {
      meta,
      receivedBytes: 0,
      chunks: [],
      pending: [],
      pendingBytes: 0,
      writeChain: Promise.resolve(),
      lastProgressAt: 0,
    };
    setStatus('transferring');
    addFile({ fileId: meta.fileId, name: meta.name, size: meta.size, bytesTransferred: 0, status: 'waiting_for_accept' });
    setMessages(prev => [...prev, {
      id: uuidv4(),
      senderRole: roleRef.current === 'sender' ? 'receiver' : 'sender',
      fileId: meta.fileId,
      timestamp: Date.now()
    }]);
  }

  /** Release everything held for an incoming file without changing its status. */
  function discardIncoming(fileId: string) {
    const buf = receiveBufferRef.current[fileId];
    if (!buf) return;
    buf.failed = buf.failed || 'discarded';
    delete receiveBufferRef.current[fileId];
    if (activeReceiveIdRef.current === fileId) activeReceiveIdRef.current = null;
    buf.chunks = [];
    buf.pending = [];
    if (buf.writable) {
      // Abort discards the partial file instead of leaving it on disk.
      const w = buf.writable;
      buf.writable = undefined;
      buf.writeChain.finally(() => w.abort?.()).catch(() => {});
    }
  }

  /** Mark an incoming file failed, free its resources and optionally tell the sender. */
  function failReceive(fileId: string, reason: string, notifyPeer: boolean) {
    const buf = receiveBufferRef.current[fileId];
    if (!buf) return;
    const dc = buf.dc ?? dcRef.current;
    const afterEof = !!buf.eofReceived;
    discardIncoming(fileId);
    buf.failed = reason;
    updateFile(fileId, { status: 'error', error: reason });
    if (notifyPeer) {
      safeSend(dc, JSON.stringify(afterEof
        ? { type: 'file-ack', fileId, ok: false, bytes: buf.receivedBytes, reason }
        : { type: 'file-cancel', fileId, reason, error: true }));
    }
    settleStatus();
  }

  function flushWrites(fileId: string, buf: IncomingFile) {
    if (!buf.writable || buf.pending.length === 0) return;
    const merged = new Uint8Array(buf.pendingBytes);
    let pos = 0;
    for (const part of buf.pending) {
      merged.set(new Uint8Array(part), pos);
      pos += part.byteLength;
    }
    buf.pending = [];
    buf.pendingBytes = 0;
    const writable = buf.writable;
    buf.writeChain = buf.writeChain
      .then(() => (buf.failed ? undefined : writable.write(merged)))
      .catch((err: any) => {
        console.error('Disk write failed', err);
        if (!buf.failed) failReceive(fileId, `Could not write the file to disk${err?.name ? ` (${err.name})` : ''}`, true);
      });
  }

  function handleFileChunk(data: ArrayBuffer, dc: RTCDataChannel) {
    // Chunks carry no file id; they belong to the one file this peer accepted.
    // Anything else (stray data after a cancel, or a chunk on an old channel)
    // is dropped rather than guessed into some other file.
    const fileId = activeReceiveIdRef.current;
    if (!fileId) return;
    const buf = receiveBufferRef.current[fileId];
    if (!buf || buf.failed || buf.eofReceived || buf.dc !== dc) return;

    const next = buf.receivedBytes + data.byteLength;
    if (next > buf.meta.size) {
      failReceive(fileId, 'Received more data than the sender announced', true);
      return;
    }
    buf.receivedBytes = next;

    if (buf.writable) {
      buf.pending.push(data);
      buf.pendingBytes += data.byteLength;
      if (buf.pendingBytes >= WRITE_BATCH_BYTES) flushWrites(fileId, buf);
    } else {
      buf.chunks.push(data);
    }

    const now = Date.now();
    if (now - buf.lastProgressAt >= PROGRESS_INTERVAL_MS || next === buf.meta.size) {
      buf.lastProgressAt = now;
      updateFile(fileId, { bytesTransferred: next });
    }
  }

  async function handleFileEof(fileId: unknown, dc: RTCDataChannel) {
    if (!isValidFileId(fileId)) return;
    const buf = receiveBufferRef.current[fileId];
    // Unknown, duplicate, or for a file we never accepted on this channel.
    if (!buf || buf.eofReceived || buf.failed || buf.dc !== dc) return;
    buf.eofReceived = true;
    if (activeReceiveIdRef.current === fileId) activeReceiveIdRef.current = null;

    const verdict = verifyReceived(buf.receivedBytes, buf.meta.size);
    if (!verdict.ok) {
      failReceive(fileId, verdict.reason, true);
      return;
    }

    let url = '';
    try {
      if (buf.writable) {
        flushWrites(fileId, buf);
        await buf.writeChain;
        if (buf.failed) return; // already reported by the write path
        await buf.writable.close();
      } else {
        const blob = new Blob(buf.chunks, { type: buf.meta.mimeType });
        url = URL.createObjectURL(blob);
        blobUrlsRef.current.add(url);
      }
    } catch (e: any) {
      console.error('Finalising received file failed', e);
      if (!buf.failed) failReceive(fileId, `Could not save the file${e?.name ? ` (${e.name})` : ''}`, true);
      return;
    }
    if (buf.failed) return;

    delete receiveBufferRef.current[fileId];
    buf.chunks = [];
    updateFile(fileId, { status: 'complete', bytesTransferred: buf.receivedBytes, blobUrl: url || undefined });
    // Tell the sender it really arrived intact; only this lets it show "sent".
    safeSend(dc, JSON.stringify({ type: 'file-ack', fileId, ok: true, bytes: buf.receivedBytes }));

    // Auto download if it was memory buffered
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.download = buf.meta.name; // already sanitised in validateFileMeta
      a.click();
    }
    settleStatus();
  }

  const acceptFileOffer = async (fileId: string) => {
    const buf = receiveBufferRef.current[fileId];
    if (!buf || buf.accepting || fileStatusRef.current[fileId] !== 'waiting_for_accept') return;
    // One incoming file at a time: chunks are routed to the accepted file.
    if (activeReceiveIdRef.current && activeReceiveIdRef.current !== fileId) return;
    buf.accepting = true;

    let writable: any;
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: buf.meta.name,
        });
        writable = await handle.createWritable();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          buf.accepting = false;
          declineFileOffer(fileId);
          return;
        }
        // Fall back to buffering in memory (and say so in the console).
        console.error('Save picker failed; falling back to in-memory download', e);
      }
    }

    // The picker can stay open for a long time; re-check everything after it.
    const dc = dcRef.current;
    const stillOffered = receiveBufferRef.current[fileId] === buf && fileStatusRef.current[fileId] === 'waiting_for_accept';
    if (!stillOffered || !dc || dc.readyState !== 'open' || (activeReceiveIdRef.current && activeReceiveIdRef.current !== fileId)) {
      buf.accepting = false;
      try { await writable?.abort?.(); } catch { /* nothing written */ }
      return;
    }

    buf.writable = writable;
    buf.dc = dc;
    buf.accepting = false;
    activeReceiveIdRef.current = fileId;
    updateFile(fileId, { status: 'transferring' });
    if (!safeSend(dc, JSON.stringify({ type: 'file-accept', fileId }))) {
      failReceive(fileId, 'Connection lost before the transfer started', false);
    }
  };

  const declineFileOffer = (fileId: string) => {
    if (fileStatusRef.current[fileId] !== 'waiting_for_accept') return;
    discardIncoming(fileId);
    updateFile(fileId, { status: 'declined' });
    safeSend(dcRef.current, JSON.stringify({ type: 'file-decline', fileId }));
    settleStatus();
  };

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  function receiveChat(raw: unknown, viaRelay: boolean) {
    const chat = validateChatPayload(raw);
    if (!chat) return;
    setMessages(prev => {
      if (prev.some(m => m.id === chat.id)) return prev;
      return [...prev, {
        id: chat.id,
        // Decided locally, never taken from the peer: a peer must not be able
        // to post "system" notices or messages that look like ours.
        senderRole: roleRef.current === 'sender' ? 'receiver' : 'sender',
        text: chat.text,
        timestamp: chat.timestamp,
        ...(viaRelay ? { viaRelay: true } : {}),
      }];
    });
  }

  const sendChatMessage = useCallback((text: string) => {
    const msg: ChatMessage = { id: uuidv4(), senderRole: roleRef.current || 'system', text, timestamp: Date.now() };
    // Prefer the peer-to-peer data channel: it is DTLS-encrypted between the two
    // devices and never reaches the signalling server. Only fall back to the
    // signalling socket when the peer connection is not usable, so messages are
    // not simply lost. That fallback is NOT end-to-end encrypted: the server
    // relays it and can read it, so such messages are flagged in the UI.
    let delivered = safeSend(dcRef.current, JSON.stringify({ type: 'chat', ...msg }));
    if (!delivered && wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'chat', roomId: roomIdRef.current, payload: msg }));
        msg.viaRelay = true;
        delivered = true;
      } catch (e) {
        console.error('Signalling send failed', e);
      }
    }
    setMessages(prev => [...prev, msg]);
    if (!delivered) {
      setMessages(prev => [...prev, {
        id: uuidv4(),
        senderRole: 'system',
        text: 'Message not delivered — not connected to the other device.',
        isSystemMessage: true,
        timestamp: Date.now(),
      }]);
    }
  }, []);

  const sendTyping = useCallback(() => {
    if (safeSend(dcRef.current, JSON.stringify({ type: 'typing' }))) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ type: 'typing', roomId: roomIdRef.current })); } catch { /* best effort */ }
    }
  }, []);

  // Page lifecycle. Backgrounding a tab reliably kills the signalling socket
  // and often wobbles the peer connection; on return, recover straight away
  // instead of sitting on a backoff or waiting for a timeout to expire.
  useEffect(() => {
    const recover = () => {
      if (!shouldReconnectRef.current || !roomIdRef.current) return;

      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectAttemptsRef.current = 0; // resume immediately, not on a backoff
        clearReconnectTimer();
        connectSocket();
      }

      const pc = pcRef.current;
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
        void attemptIceRestart();
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') recover();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', recover);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', recover);
    };
  }, []);

  // Drop every timer on unmount so a torn-down hook cannot resurrect itself.
  useEffect(() => () => {
    clearReconnectTimer();
    clearPeerGraceTimer();
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
  }, []);

  const disconnect = useCallback(() => {
    // An explicit teardown: stop trying to come back.
    shouldReconnectRef.current = false;
    reconnectAttemptsRef.current = 0;
    clearReconnectTimer();
    clearPeerGraceTimer();
    try { sessionStorage.removeItem('td:session'); } catch { /* private mode */ }

    // Tear the call down first, otherwise the camera and microphone stay live
    // after the user backs out of a room.
    callManagerRef.current?.cleanupCall();

    // Stop any outgoing stream, drop pending confirmations and discard
    // partially written incoming files, so nothing keeps running or holding
    // memory / file handles after the user leaves.
    if (activeSendRef.current) {
      activeSendRef.current.cancelled = true;
      activeSendRef.current.wake?.();
      activeSendRef.current = null;
    }
    sendQueueRef.current = [];
    for (const pending of pendingAcksRef.current.values()) clearTimeout(pending.timer);
    pendingAcksRef.current.clear();
    for (const fileId of Object.keys(receiveBufferRef.current)) discardIncoming(fileId);
    receiveBufferRef.current = {};
    activeReceiveIdRef.current = null;
    fileStatusRef.current = {};
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current.clear();
    seatTokenRef.current = null;

    if (wsRef.current) wsRef.current.close();
    if (dcRef.current) dcRef.current.close();
    if (pcRef.current) pcRef.current.close();
    setStatus('idle');
    setSignalingState('idle');
    setRole(null);
    setRoomId('');
    setFilesProgress({});
    setMessages([]);
    setErrorMsg(null);
  }, []);

  return {
    role,
    roomId,
    status,
    signalingState,
    connectionType,
    filesProgress,
    messages,
    errorMsg,
    peerName,
    isPeerTyping,
    initSignaling,
    sendFiles,
    acceptFileOffer,
    declineFileOffer,
    cancelTransfer,
    sendChatMessage,
    sendTyping,
    disconnect,
    ...callManager,
    callState,
    callMode,
    localStream,
    remoteStream,
    callQuality,
    isScreenSharing,
    isRecording
  };
}
