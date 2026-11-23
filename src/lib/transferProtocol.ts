// Pure, side-effect-free rules for the file transfer protocol that runs over
// the WebRTC data channel. Kept separate from the React hook so they can be
// unit tested without a browser.
//
// Wire protocol (JSON control messages + raw binary chunks, ordered channel):
//
//   sender -> receiver  { type: 'meta', fileId, name, size, mimeType }   offer
//   receiver -> sender  { type: 'file-accept', fileId }                    start
//   receiver -> sender  { type: 'file-decline', fileId }                   refuse
//   sender -> receiver  <binary chunks...>                                 data
//   sender -> receiver  { type: 'eof', fileId }                            all bytes sent
//   receiver -> sender  { type: 'file-ack', fileId, ok, bytes, reason? }   v2: receiver's verdict
//   either direction    { type: 'file-cancel', fileId, reason?, error? }   v2: abort
//
// Binary chunks carry no file id. They are routed to the single file the
// receiver has accepted and is currently receiving; the sender streams at most
// one file at a time and the channel is ordered and reliable, so this is
// unambiguous. A framed format (fileId + offset per chunk) is a V2 item.
//
// Version negotiation: each side advertises `proto` in its name_exchange
// message. Peers that do not advertise it (v1) never send file-ack, so a
// v2 sender reports those transfers as 'unconfirmed' rather than 'complete'.

export const PROTOCOL_VERSION = 2;

export type FileStatus =
  | 'pending'             // queued locally, not yet offered
  | 'waiting_for_accept'  // offered, waiting for the receiver
  | 'declined'
  | 'transferring'
  | 'verifying'           // sender: every byte sent, waiting for the receiver's ack
  | 'complete'            // receiver wrote and verified it / sender got a positive ack
  | 'unconfirmed'         // sender: all bytes sent to a v1 peer that cannot acknowledge
  | 'cancelled'
  | 'error';

const TERMINAL: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'declined',
  'complete',
  'unconfirmed',
  'cancelled',
  'error',
]);

const TRANSITIONS: Record<FileStatus, readonly FileStatus[]> = {
  pending: ['waiting_for_accept', 'cancelled', 'error'],
  waiting_for_accept: ['transferring', 'declined', 'cancelled', 'error'],
  transferring: ['verifying', 'complete', 'unconfirmed', 'cancelled', 'error'],
  verifying: ['complete', 'cancelled', 'error'],
  declined: [],
  complete: [],
  unconfirmed: [],
  cancelled: [],
  error: [],
};

export function isTerminal(status: FileStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Whether a file may move from one status to another. Terminal states are
 * final: a late progress event or duplicate message can never turn a failed
 * transfer back into a running or successful one.
 */
export function canTransition(from: FileStatus, to: FileStatus): boolean {
  if (from === to) return !isTerminal(from);
  return TRANSITIONS[from].includes(to);
}

export interface FileMetadata {
  type: 'meta';
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
}

const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const MAX_NAME_LENGTH = 200;

export function isValidFileId(id: unknown): id is string {
  return typeof id === 'string' && FILE_ID_RE.test(id);
}

/**
 * Make a peer-supplied file name safe to use as a download / save-picker name.
 * Strips path components, control and bidi-override characters (used to spoof
 * extensions, e.g. "invoice‮gpj.exe"), characters invalid on common file
 * systems, leading dots (hidden files) and Windows reserved device names.
 */
export function sanitizeFileName(input: unknown): string {
  // Data-channel messages are already size-bounded, so the full string is fine.
  let name = typeof input === 'string' ? input : '';
  // Keep only the last path segment.
  name = name.split(/[\\/]/).pop() ?? '';
  name = name
    // C0/C1 control chars and DEL
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // bidi embedding / override / isolate, zero-width and BOM characters
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    // characters reserved on Windows / macOS
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) name = `_${name}`;

  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return name || 'download';
}

/** Validate an incoming 'meta' offer. Returns a cleaned copy or null if unusable. */
export function validateFileMeta(raw: unknown): FileMetadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'meta') return null;
  if (!isValidFileId(m.fileId)) return null;
  if (typeof m.name !== 'string') return null;
  if (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 0) return null;
  const mimeType = typeof m.mimeType === 'string' && MIME_RE.test(m.mimeType)
    ? m.mimeType
    : 'application/octet-stream';
  return { type: 'meta', fileId: m.fileId, name: sanitizeFileName(m.name), size: m.size, mimeType };
}

/** Account for one incoming chunk. Overflow means the peer sent more than it announced. */
export function applyChunk(received: number, expected: number, chunkBytes: number) {
  const next = received + chunkBytes;
  return { received: next, overflow: next > expected };
}

/** `reason` is set whenever `ok` is false. */
export interface Verdict {
  ok: boolean;
  reason?: string;
}

/** Decide, at end-of-file, whether the receiver really has the whole file. */
export function verifyReceived(received: number, expected: number): Verdict {
  if (received === expected) return { ok: true };
  if (received < expected) {
    return { ok: false, reason: `Incomplete file: received ${received} of ${expected} bytes` };
  }
  return { ok: false, reason: `Received ${received - expected} more bytes than announced` };
}

/**
 * Sender side: interpret a file-ack for a file awaiting confirmation.
 * Only an explicit positive ack carrying the exact expected byte count counts
 * as success; anything else is a failure.
 */
export function evaluateAck(ack: unknown, expectedSize: number): Verdict {
  if (!ack || typeof ack !== 'object') return { ok: false, reason: 'Invalid acknowledgment' };
  const a = ack as Record<string, unknown>;
  if (a.ok === true && a.bytes === expectedSize) return { ok: true };
  if (a.ok === true) return { ok: false, reason: 'Receiver confirmed a different size than was sent' };
  return { ok: false, reason: cleanReason(a.reason) || 'Receiver reported a failure' };
}

/** Bound and strip a peer-supplied failure reason before showing it. */
export function cleanReason(reason: unknown): string {
  if (typeof reason !== 'string') return '';
  return reason.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim().slice(0, 200);
}

/** Parse a JSON control message from the data channel. Never throws. */
export function parseControlMessage(data: string): Record<string, any> | null {
  try {
    const msg = JSON.parse(data);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}

export const MAX_CHAT_LENGTH = 10000;

/** Validate a peer chat message. The peer decides only id/text/timestamp; never role or system flags. */
export function validateChatPayload(raw: unknown): { id: string; text: string; timestamp: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 64) return null;
  if (typeof m.text !== 'string' || m.text.length === 0) return null;
  const timestamp = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : Date.now();
  return { id: m.id, text: m.text.slice(0, MAX_CHAT_LENGTH), timestamp };
}

/** Bound a peer-supplied display name. */
export function sanitizePeerName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim().slice(0, 64);
}

export function isValidCallMode(mode: unknown): mode is 'audio' | 'video' {
  return mode === 'audio' || mode === 'video';
}
