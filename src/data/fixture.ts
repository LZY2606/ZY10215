import type { Point, ProfileInput, RigidTransform, StandardProfile } from '../domain/types.js';
import { buildStandardProfile } from '../domain/standard.js';
import { applyTransform, normalize, stableHash, sub } from '../domain/geometry.js';
import { gaussian, mulberry32 } from './rng.js';

export const FIXTURE_ID = 'FIXTURE-WHL-1L-T012';
export const WHEEL_POSITION = '1L';
export const SHARED_PROBE_BIAS = 0.9; // 整批共享测头法向偏差 mm

type EpochKind = 'forward' | 'reverse' | 'truncated';

interface EpochSpec {
  epoch: string;
  kind: EpochKind;
  seed: number;
  transform: RigidTransform;
  wearDepth: number;
  /** 截短：相对标准弧长的保留区间 [f0,f1]。 */
  keep?: [number, number];
}

/**
 * 三期采集：
 *  T0 正向全段（早期，磨耗轻）
 *  T1 反向全段（转向相反，点序语义相反）
 *  T2 正向但被截短（缺轮缘内侧顶 + 缺踏面外侧），磨耗最重
 * 三期各自随机原点/旋转/截取，且共享同一测头偏差。
 */
const EPOCHS: EpochSpec[] = [
  {
    epoch: 'T0',
    kind: 'forward',
    seed: 10101,
    transform: { theta: 0.18, tx: 6.5, ty: -4.2 },
    wearDepth: 0.8,
  },
  {
    epoch: 'T1',
    kind: 'reverse',
    seed: 20202,
    transform: { theta: -0.11, tx: -8.0, ty: 5.0 },
    wearDepth: 1.4,
  },
  {
    epoch: 'T2',
    kind: 'truncated',
    seed: 30303,
    transform: { theta: 0.07, tx: 3.0, ty: 2.2 },
    wearDepth: 5.2,
    keep: [0.12, 0.86],
  },
];

/** 法向磨耗盆：以根弧/踏面交界为中心，制造超限区域。 */
function wearOffset(s: number, total: number, depth: number): number {
  // 中心在相对弧长 ~0.46（根弧->踏面过渡），宽度 ~0.34
  const c = 0.72 * total;
  const w = 0.075 * total;
  const bowl = depth * Math.exp(-(((s - c) / w) ** 2));
  return bowl;
}

/**
 * 第二根凹（赝根弧）：在标准根凹靠踏面一侧制造一处显著的局部内凹，
 * 使根部锦标检测在“真根凹”与“赝根凹”上产生两个近似同分对齐候选。
 */
function spuriousRootDentMag(s: number, total: number): number {
  // “孪生根凹”：紧邻真根底（约 +2mm 弧长）的第二个深度相近的凹，构成真实的根锦标歧义。
  // 钉到真根或孪生根都能让大部分廓形配准（仅根区局部错位），产生两个可追溯的近似同分候选。
  const center = 0.364 * total; // 真根底 0.35L(46.5mm)，孪生根凹在其后约 1.9mm
  const width = 0.006 * total;
  const depth = 1.6;
  const d = (s - center) / width;
  return depth * Math.exp(-0.5 * d * d);
}

function buildWornStandard(std: StandardProfile, wearDepth: number): Point[] {
  const total = std.s[std.s.length - 1];
  const out: Point[] = [];
  for (let i = 0; i < std.points.length; i++) {
    let offset = wearOffset(std.s[i], total, wearDepth);
    const nrm = std.normal[i];
    // 材料磨耗沿 inward 法向，即 -normal 方向
    let p: Point = {
      x: std.points[i].x - nrm.x * offset,
      y: std.points[i].y - nrm.y * offset,
    };
    // 赝根凹（额外内凹）
    const dentMag = spuriousRootDentMag(std.s[i], total);
    if (dentMag > 0) {
      p = { x: p.x - nrm.x * dentMag, y: p.y - nrm.y * dentMag };
    }
    out.push(p);
  }
  return out;
}

function resamplePolyline(points: Point[], spacing: number): Point[] {
  // 沿弦长均匀取点（独立于标准的重采样，模拟测头采样网格）
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const total = cum[cum.length - 1];
  const steps = Math.max(2, Math.round(total / spacing));
  const out: Point[] = [];
  let j = 0;
  for (let k = 0; k <= steps; k++) {
    const target = (total * k) / steps;
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const f = (target - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push({
      x: points[j].x + (points[j + 1].x - points[j].x) * f,
      y: points[j].y + (points[j + 1].y - points[j].y) * f,
    });
  }
  return out;
}

function addOutlier(p: Point, rand: () => number): Point {
  const ang = rand() * Math.PI * 2;
  const mag = 4 + rand() * 3;
  return { x: p.x + Math.cos(ang) * mag, y: p.y + Math.sin(ang) * mag };
}

/** 生成三期固定 fixture。返回顺序故意“乱序”，用于证明结论不依赖导入顺序。 */
export function generateFixture(): ProfileInput[] {
  const std = buildStandardProfile();
  const total = std.s[std.s.length - 1];
  const rand = mulberry32(987654321);
  void normalize;
  void sub;

  const inputs: ProfileInput[] = EPOCHS.map((spec) => {
    const r = mulberry32(spec.seed);
    let worn = buildWornStandard(std, spec.wearDepth);

    // 截短：按弧长比例保留中段（两端都缺，验证不端点填充）。
    if (spec.keep) {
      const [f0, f1] = spec.keep;
      const s0 = f0 * total;
      const s1 = f1 * total;
      worn = worn.filter((_, i) => std.s[i] >= s0 && std.s[i] <= s1);
    }

    // 独立采样网格 + 测量噪声
    let sampled = resamplePolyline(worn, 0.9);
    sampled = sampled.map((p) => ({
      x: p.x + gaussian(r) * 0.06,
      y: p.y + gaussian(r) * 0.06,
    }));

    // 共享测头偏差：沿廓形法向系统性偏移（需要先知道法向，这里近似用标准法向）
    sampled = sampled.map((p, idx) => {
      // 通过最近标准点取法向
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < std.points.length; i++) {
        const d = Math.hypot(std.points[i].x - p.x, std.points[i].y - p.y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      const nrm = std.normal[best];
      void idx;
      // 测头沿 +normal 方向系统性偏置
      return { x: p.x + nrm.x * SHARED_PROBE_BIAS, y: p.y + nrm.y * SHARED_PROBE_BIAS };
    });

    // 污点（每期 3 个）
    const outlierIdx = new Set<number>();
    while (outlierIdx.size < 3) {
      outlierIdx.add(Math.floor(r() * sampled.length));
    }
    sampled = sampled.map((p, i) => (outlierIdx.has(i) ? addOutlier(p, r) : p));

    // 随机刚体（独立原点/旋转）
    const moved = sampled.map((p) => applyTransform(p, spec.transform));

    // 转向相反：显式反向点序（语义翻转的逆过程），用于验证分析侧必须翻转回来。
    if (spec.kind === 'reverse') moved.reverse();

    const profileId = `${FIXTURE_ID}-${spec.epoch}`;
    return {
      id: profileId,
      wheelPosition: WHEEL_POSITION,
      epoch: spec.epoch,
      rawPoints: moved,
      declaredOrientation: spec.kind === 'reverse' ? 'reverse' : 'forward',
      fixtureTruth: spec.transform,
      sharedProbeBiasTruth: SHARED_PROBE_BIAS,
    };
  });

  // 故意打乱导入顺序（T2, T0, T1），证明候选/结论不依赖导入顺序。
  const order: Record<string, number> = { T2: 0, T0: 1, T1: 2 };
  inputs.sort((a, b) => order[a.epoch] - order[b.epoch]);
  void rand;
  return inputs;
}

/** 输入点云指纹（顺序无关：排序后哈希）。 */
export function fingerprintInputs(inputs: ProfileInput[]): string {
  const canonical = inputs
    .map((inp) => ({
      id: inp.id,
      pts: inp.rawPoints
        .map((p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`)
        .sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return stableHash(canonical);
}
