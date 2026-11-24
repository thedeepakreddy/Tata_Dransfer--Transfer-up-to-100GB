// Classify the network path WebRTC actually selected, from getStats().
//
// Only a 'relay' candidate means traffic goes through a TURN relay. 'srflx' and
// 'prflx' candidates are still direct peer-to-peer paths (through NAT), and
// 'host' on both ends means the devices reached each other's local addresses.

export type ConnectionType = 'local' | 'direct' | 'relayed' | 'unknown';

export function classifyCandidateTypes(local?: string | null, remote?: string | null): ConnectionType {
  if (local === 'relay' || remote === 'relay') return 'relayed';
  if (!local || !remote) return 'unknown';
  if (local === 'host' && remote === 'host') return 'local';
  return 'direct';
}

/** Candidate types of the pair the transport is actually using (not just any successful pair). */
export function selectedPairCandidateTypes(stats: Map<string, any> | { forEach: Function; get: Function }) {
  let pair: any = null;
  stats.forEach((r: any) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  if (!pair) {
    // Browsers without transport stats: fall back to the nominated, succeeded pair.
    stats.forEach((r: any) => {
      if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
    });
  }
  if (!pair) return { local: null, remote: null };
  return {
    local: stats.get(pair.localCandidateId)?.candidateType ?? null,
    remote: stats.get(pair.remoteCandidateId)?.candidateType ?? null,
  };
}

export function classifySelectedPath(stats: Map<string, any> | { forEach: Function; get: Function }): ConnectionType {
  const { local, remote } = selectedPairCandidateTypes(stats);
  return classifyCandidateTypes(local, remote);
}

/** Short UI label; null when the path is not known (show just "Connected"). */
export function connectionLabel(type: ConnectionType): string | null {
  switch (type) {
    case 'local': return 'Local network';
    case 'direct': return 'Direct';
    case 'relayed': return 'Relayed';
    default: return null;
  }
}
