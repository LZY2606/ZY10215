import type {
  AlignmentResult,
  NormalizedProfile,
  Pt,
  StandardProfile,
} from '../src/core/types';
import type { BatchRun } from '../src/core/pipeline';

export interface SerializableRun {
  runId: string;
  createdAt: string;
  stdVersion: string;
  wheelPosition: string;
  fingerprint: string;
  config: BatchRun['config'];
  profiles: Array<{
    id: string;
    epoch: string;
    seq: number;
    flipped: boolean;
    orientationScore: number;
    missingStartS: number;
    missingEndS: number;
    totalLength: number;
    declaredDirection: string;
    note?: string;
    segments: NormalizedProfile['segments'];
    rawPoints: Pt[];
    normPoints: Pt[];
    cumS: number[];
  }>;
  results: AlignmentResult[];
  standard: {
    version: string;
    points: Pt[];
    cumS: number[];
    totalLength: number;
    segments: StandardProfile['segments'];
    limits: StandardProfile['limits'];
  };
}

export function serializeRun(run: BatchRun, std: StandardProfile): SerializableRun {
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    stdVersion: run.stdVersion,
    wheelPosition: run.config.wheelPosition,
    fingerprint: run.fingerprint,
    config: run.config,
    profiles: run.normalized.map((np) => ({
      id: np.raw.id,
      epoch: np.raw.epoch,
      seq: np.raw.seq,
      flipped: np.flipped,
      orientationScore: np.orientationScore,
      missingStartS: np.missingStartS,
      missingEndS: np.missingEndS,
      totalLength: np.poly.totalLength,
      declaredDirection: np.raw.declaredDirection,
      note: np.raw.note,
      segments: np.segments,
      rawPoints: np.raw.points,
      normPoints: np.poly.pts,
      cumS: np.poly.cumS,
    })),
    results: run.results,
    standard: {
      version: std.version,
      points: std.poly.pts,
      cumS: std.poly.cumS,
      totalLength: std.poly.totalLength,
      segments: std.segments,
      limits: std.limits,
    },
  };
}
