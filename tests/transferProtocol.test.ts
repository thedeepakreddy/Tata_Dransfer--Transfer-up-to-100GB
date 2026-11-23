// Unit tests for the pure transfer-protocol rules.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChunk,
  canTransition,
  cleanReason,
  evaluateAck,
  isTerminal,
  isValidCallMode,
  parseControlMessage,
  sanitizeFileName,
  sanitizePeerName,
  validateChatPayload,
  validateFileMeta,
  verifyReceived,
  type FileStatus,
} from '../src/lib/transferProtocol.ts';

test('terminal states are final', () => {
  const terminal: FileStatus[] = ['complete', 'error', 'cancelled', 'declined', 'unconfirmed'];
  const all: FileStatus[] = [...terminal, 'pending', 'waiting_for_accept', 'transferring', 'verifying'];
  for (const from of terminal) {
    assert.equal(isTerminal(from), true);
    for (const to of all) assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
  }
});

test('a sender cannot jump to complete without verification', () => {
  assert.equal(canTransition('pending', 'complete'), false);
  assert.equal(canTransition('waiting_for_accept', 'complete'), false);
  assert.equal(canTransition('verifying', 'complete'), true);
  assert.equal(canTransition('verifying', 'unconfirmed'), false);
  assert.equal(canTransition('verifying', 'transferring'), false);
});

test('normal lifecycles are allowed', () => {
  const sender: FileStatus[] = ['pending', 'waiting_for_accept', 'transferring', 'verifying', 'complete'];
  const receiver: FileStatus[] = ['waiting_for_accept', 'transferring', 'complete'];
  for (const path of [sender, receiver]) {
    for (let i = 1; i < path.length; i++) assert.equal(canTransition(path[i - 1], path[i]), true);
  }
  assert.equal(canTransition('transferring', 'transferring'), true); // progress updates
});

test('sanitizeFileName strips paths and dangerous characters', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.equal(sanitizeFileName('.bashrc'), 'bashrc');
  assert.equal(sanitizeFileName('a\u0000b\u0007c.txt'), 'abc.txt');
  assert.equal(sanitizeFileName('invoice\u202Egpj.exe'), 'invoicegpj.exe');
  assert.equal(sanitizeFileName('what?<>|*:".txt'), 'what_______.txt');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('lpt1.txt'), '_lpt1.txt');
  assert.equal(sanitizeFileName('trailing. . '), 'trailing');
  assert.equal(sanitizeFileName(''), 'download');
  assert.equal(sanitizeFileName('/'), 'download');
  assert.equal(sanitizeFileName(42), 'download');
  assert.equal(sanitizeFileName('normal photo (1).jpg'), 'normal photo (1).jpg');
  const long = sanitizeFileName('x'.repeat(5000) + '.tar.gz');
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.gz'));
});

test('validateFileMeta rejects malformed offers', () => {
  const good = { type: 'meta', fileId: 'abc-123', name: 'a.txt', size: 10, mimeType: 'text/plain' };
  assert.deepEqual(validateFileMeta(good), good);
  assert.equal(validateFileMeta(null), null);
  assert.equal(validateFileMeta({ ...good, type: 'eof' }), null);
  assert.equal(validateFileMeta({ ...good, fileId: '../x' }), null);
  assert.equal(validateFileMeta({ ...good, fileId: 'x'.repeat(65) }), null);
  assert.equal(validateFileMeta({ ...good, size: -1 }), null);
  assert.equal(validateFileMeta({ ...good, size: 1.5 }), null);
  assert.equal(validateFileMeta({ ...good, size: Number.MAX_SAFE_INTEGER + 2 }), null);
  assert.equal(validateFileMeta({ ...good, size: '10' }), null);
  assert.equal(validateFileMeta({ ...good, size: NaN }), null);
  assert.equal(validateFileMeta({ ...good, name: { toString: () => 'x' } }), null);
  // Zero-byte files are legitimate.
  assert.equal(validateFileMeta({ ...good, size: 0 })?.size, 0);
  // Name is sanitised and a bogus mime type is replaced.
  const cleaned = validateFileMeta({ ...good, name: '../../x.sh', mimeType: 'text/html\r\nX: y' });
  assert.equal(cleaned?.name, 'x.sh');
  assert.equal(cleaned?.mimeType, 'application/octet-stream');
});

test('applyChunk detects overflow', () => {
  assert.deepEqual(applyChunk(0, 100, 50), { received: 50, overflow: false });
  assert.deepEqual(applyChunk(50, 100, 50), { received: 100, overflow: false });
  assert.deepEqual(applyChunk(100, 100, 1), { received: 101, overflow: true });
});

test('verifyReceived requires the exact byte count', () => {
  assert.deepEqual(verifyReceived(100, 100), { ok: true });
  assert.equal(verifyReceived(0, 0).ok, true);
  assert.equal(verifyReceived(99, 100).ok, false);
  assert.equal(verifyReceived(101, 100).ok, false);
});

test('evaluateAck only accepts an exact positive acknowledgment', () => {
  assert.equal(evaluateAck({ ok: true, bytes: 100 }, 100).ok, true);
  assert.equal(evaluateAck({ ok: true, bytes: 99 }, 100).ok, false);
  assert.equal(evaluateAck({ ok: true }, 100).ok, false);
  assert.equal(evaluateAck({ ok: 'yes', bytes: 100 }, 100).ok, false);
  assert.equal(evaluateAck(null, 100).ok, false);
  const failed = evaluateAck({ ok: false, reason: 'Disk full' }, 100);
  assert.deepEqual(failed, { ok: false, reason: 'Disk full' });
  assert.equal((evaluateAck({ ok: false }, 100) as any).reason, 'Receiver reported a failure');
});

test('peer-supplied text is bounded and cleaned', () => {
  assert.equal(cleanReason('x'.repeat(500)).length, 200);
  assert.equal(cleanReason({}), '');
  assert.equal(sanitizePeerName({ name: 'x' }), '');
  assert.equal(sanitizePeerName('  Ann\u202E  '), 'Ann');
  assert.equal(sanitizePeerName('y'.repeat(100)).length, 64);
});

test('parseControlMessage never throws', () => {
  assert.equal(parseControlMessage('{'), null);
  assert.equal(parseControlMessage('null'), null);
  assert.equal(parseControlMessage('[]'), null);
  assert.equal(parseControlMessage('{"type":5}'), null);
  assert.deepEqual(parseControlMessage('{"type":"eof","fileId":"a"}'), { type: 'eof', fileId: 'a' });
});

test('validateChatPayload drops anything that is not plain text', () => {
  assert.deepEqual(validateChatPayload({ id: 'm1', text: 'hi', timestamp: 5 }), { id: 'm1', text: 'hi', timestamp: 5 });
  assert.equal(validateChatPayload({ id: 'm1', text: { evil: true } }), null);
  assert.equal(validateChatPayload({ id: 'm1', text: '' }), null);
  assert.equal(validateChatPayload({ text: 'hi' }), null);
  assert.equal(validateChatPayload('hi'), null);
  // Role / system flags supplied by the peer are not carried through.
  const v = validateChatPayload({ id: 'm1', text: 'hi', senderRole: 'system', isSystemMessage: true }) as any;
  assert.equal(v.senderRole, undefined);
  assert.equal(v.isSystemMessage, undefined);
  assert.equal(validateChatPayload({ id: 'm1', text: 'x'.repeat(20000) })!.text.length, 10000);
});

test('call modes are validated', () => {
  assert.equal(isValidCallMode('audio'), true);
  assert.equal(isValidCallMode('video'), true);
  assert.equal(isValidCallMode('screen'), false);
  assert.equal(isValidCallMode(undefined), false);
});
