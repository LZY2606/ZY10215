export interface UiPt { x: number; y: number }
export interface UiSegment { tag: string; s0: number; s1: number }
export interface UiLimit { tag: string; warning: number; critical: number }
export interface UiStandard {
  version: string;
  points: UiPt[];
  cumS: number[];
  totalLength: number;
  segments: UiSegment[];
  limits: UiLimit[];
}
export interface UiCandidate {
  rank: number;
  score: number;
  scoreGap: number;
  provenance: string;
  retained: boolean;
  xform: { theta: number; tx: number; ty: number };
  basisRanges: { s0: number; s1: number }[];
}
export interface UiWear {
  s: number;
  p: UiPt;
  q: UiPt;
  n: UiPt;
  wear: number;
  segment: string;
  excluded: boolean;
  beyondStandard: boolean;
}
export interface UiViolation {
  segment: string;
  s0: number;
  s1: number;
  maxWear: number;
  level: 'warning' | 'critical';
  limitVersion: string;
}
export interface UiResult {
  profileId: string;
  chosenCandidateRank: number;
  candidates: UiCandidate[];
  wear: UiWear[];
  violations: UiViolation[];
  residuals: { s: number; d: number }[];
  rms: number;
  probeBiasApplied: number;
  probeBiasSource: string;
}
export interface UiProfile {
  id: string;
  epoch: string;
  seq: number;
  flipped: boolean;
  missingStartS: number;
  missingEndS: number;
  totalLength: number;
  declaredDirection: string;
  note?: string;
  normPoints: UiPt[];
  cumS: number[];
}
export interface UiProfileCfg {
  profileId: string;
  useSharedBias: boolean;
  chosenCandidateRank: number | null;
  excludedIntervals: { s0: number; s1: number }[];
  basisOverride?: string;
  lockRootOverride?: boolean;
}
export interface UiRun {
  runId: string;
  createdAt: string;
  stdVersion: string;
  wheelPosition: string;
  fingerprint: string;
  config: {
    wheelPosition: string;
    options: { basis: string; lockRoot: boolean; tieTolRatio: number };
    sharedProbeBias: number | null;
    profiles: UiProfileCfg[];
  };
  profiles: UiProfile[];
  results: UiResult[];
  standard: UiStandard;
}
