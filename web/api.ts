export interface Pt {
  x: number;
  y: number;
}

export interface Candidate {
  candidateId: string;
  transform: { theta: number; tx: number; ty: number };
  score: number;
  relativeGap: number;
  nearBest: boolean;
  seed: string;
  rootLocked: boolean;
  auxiliary?: boolean;
  referenceSegments: string[];
  pairedPoints: number;
  coverage: number;
}

export interface WearSample {
  s: number;
  standardPoint: Pt;
  normal: Pt;
  tag: string;
  signedDistance: number | null;
  wear: number | null;
  valid: boolean;
  exceedsLimit: boolean;
  threshold: number;
}

export interface Exceedance {
  tag: string;
  s0: number;
  s1: number;
  arcLength: number;
  maxWear: number;
  meanWear: number;
  limitVersion: string;
  explanation: string;
}

export interface ProfileResult {
  profileId: string;
  wheelPosition: string;
  epoch: string;
  orientation: {
    orientation: 'forward' | 'reverse';
    method: string;
    evidence: Record<string, number>;
    confidence: number;
    reversed: boolean;
  };
  rebuild: { totalLength: number; spacing: number; pointCount: number };
  candidates: Candidate[];
  selectedCandidateId: string;
  selectedTransform: { theta: number; tx: number; ty: number };
  alignmentResidual: { rms: number; max: number; mean: number };
  excludeOutliers: boolean;
  excludedPointCount: number;
  appliedBias: number;
  appliedBiasSource: string;
  wear: WearSample[];
  exceedances: Exceedance[];
  limitVersion: string;
  standardVersion: string;
  fingerprint: string;
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  fixtureId: string;
  standardVersion: string;
  limitVersion: string;
  referenceSegments: string[];
  lockRoot: boolean;
  excludeOutliers: boolean;
  nearTieRelThreshold: number;
  sharedBiasCandidate: {
    candidateId: string;
    bias: number;
    source: string;
    basedOn: string[];
    note: string;
  } | null;
  profileResults: ProfileResult[];
  inputFingerprint: string;
}

export interface RawProfile {
  id: string;
  wheelPosition: string;
  epoch: string;
  rawPoints: Pt[];
}

export interface StandardPayload {
  version: string;
  limitVersion: string;
  s: number[];
  points: Pt[];
  tags: string[];
  normal: Pt[];
  rootChampionship: { s: number; point: Pt; curvature: number };
  segmentRanges: { tag: string; s0: number; s1: number }[];
  thresholds: Record<string, number>;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  standard: () => req<StandardPayload>('/api/standard'),
  analyze: (body: unknown) =>
    req<RunRecord>('/api/analyze', { method: 'POST', body: JSON.stringify(body) }),
  runs: () => req<unknown[]>('/api/runs'),
  run: (id: string) =>
    req<{ run: RunRecord; inputs: RawProfile[] }>(`/api/runs/${encodeURIComponent(id)}`),
  replay: (id: string) =>
    req<{ ok: boolean; reason?: string; storedFingerprint?: string; replayFingerprint?: string }>(
      `/api/runs/${encodeURIComponent(id)}/replay`,
      { method: 'POST' },
    ),
  exportRun: (id: string) =>
    req<{ file: string }>(`/api/runs/${encodeURIComponent(id)}/export`, { method: 'POST' }),
  clear: () => req<{ ok: boolean }>('/api/runs', { method: 'DELETE' }),
};
