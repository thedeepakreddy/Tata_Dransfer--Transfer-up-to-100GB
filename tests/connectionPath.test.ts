// Unit tests for classifying the selected WebRTC path (Phase 1.5, defect D2).
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCandidateTypes,
  classifySelectedPath,
  connectionLabel,
  selectedPairCandidateTypes,
} from '../src/lib/connectionPath.ts';

test('only TURN relay candidates count as relayed', () => {
  assert.equal(classifyCandidateTypes('host', 'host'), 'local');
  assert.equal(classifyCandidateTypes('srflx', 'srflx'), 'direct');
  assert.equal(classifyCandidateTypes('host', 'srflx'), 'direct');
  assert.equal(classifyCandidateTypes('prflx', 'host'), 'direct');
  assert.equal(classifyCandidateTypes('relay', 'srflx'), 'relayed');
  assert.equal(classifyCandidateTypes('host', 'relay'), 'relayed');
  assert.equal(classifyCandidateTypes(null, 'host'), 'unknown');
  assert.equal(classifyCandidateTypes(undefined, undefined), 'unknown');
});

/** Build a stats map like RTCStatsReport. */
const stats = (entries: any[]) => new Map(entries.map((e) => [e.id, e]));

test('uses the transport-selected pair, not just any succeeded pair', () => {
  const report = stats([
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' },
    // An older succeeded pair through a relay that is no longer selected.
    { id: 'P1', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1' },
    { id: 'P2', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L2', remoteCandidateId: 'R2' },
    { id: 'L1', type: 'local-candidate', candidateType: 'relay' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'srflx' },
    { id: 'L2', type: 'local-candidate', candidateType: 'srflx' },
    { id: 'R2', type: 'remote-candidate', candidateType: 'srflx' },
  ]);
  assert.deepEqual(selectedPairCandidateTypes(report), { local: 'srflx', remote: 'srflx' });
  assert.equal(classifySelectedPath(report), 'direct');
});

test('falls back to the nominated succeeded pair without transport stats', () => {
  const report = stats([
    { id: 'P1', type: 'candidate-pair', state: 'succeeded', nominated: false, localCandidateId: 'L1', remoteCandidateId: 'R1' },
    { id: 'P2', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L2', remoteCandidateId: 'R2' },
    { id: 'L1', type: 'local-candidate', candidateType: 'host' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
    { id: 'L2', type: 'local-candidate', candidateType: 'relay' },
    { id: 'R2', type: 'remote-candidate', candidateType: 'host' },
  ]);
  assert.equal(classifySelectedPath(report), 'relayed');
});

test('no selected pair is unknown, and unknown shows no path claim', () => {
  assert.equal(classifySelectedPath(stats([])), 'unknown');
  assert.equal(connectionLabel('unknown'), null);
  assert.equal(connectionLabel('local'), 'Local network');
  assert.equal(connectionLabel('direct'), 'Direct');
  assert.equal(connectionLabel('relayed'), 'Relayed');
});
