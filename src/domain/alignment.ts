import type {
  AlignmentCandidate,
  Point,
  RigidTransform,
  SegmentTag,
  StandardProfile,
} from './types.js';
import {
  add,
  applyTransform,
  clamp,
  composeTransform,
  dist,
  median,
  normalize,
  scale,
  stableHash,
  sub,
} from './geometry.js';
import { projectToStandard, type ProjectionHit } from './projection.js';
import { detectRootsInStdFrame } from './rootDetect.js';

export interface AlignmentOptions {
  referenceSegments: SegmentTag[];
  lockRoot: boolean;
  nearTieRelThreshold: number; // 例如 0.15
  maxPairDistance: number;
  outlierNormSigma: number;
}

export interface IcpResult {
  transform: RigidTransform;
  rms: number;
  paired: number;
  eligible: number;
  residualMax: number;
  residualMean: number;
  weights: number[];
  measuredRoot?: Point;
}

/** 在测量廓形的轮缘侧邻域检测“根部锦标”候选（局部低点 + 显著性）。 */
export interface RootHypothesis {
  index: number;
  s: number;
  point: Point;
  prominence: number;
}

export function detectRootHypotheses(
  s: number[],
  points: Point[],
  flangeFraction = 0.62,
): RootHypothesis[] {
  const n = points.length;
  const cut = Math.floor(n * flangeFraction);
  // 旋转不变的弦高（sagitta）：点到 ±h 弦的垂距，在真根凹/赝根凹处都显著。
  const half = Math.max(4, Math.round(n * 0.04));
  const sag: number[] = new Array(n).fill(0);
  for (let i = half; i < cut - half; i++) {
    const a = points[i - half];
    const b = points[i + half];
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const len = Math.hypot(ab.x, ab.y) || 1;
    const ap = { x: points[i].x - a.x, y: points[i].y - a.y };
    const cross = ap.x * ab.y - ap.y * ab.x;
    sag[i] = Math.abs(cross) / len;
  }
  const hyps: RootHypothesis[] = [];
  const minProm = 0.45;
  const minSep = Math.max(3, Math.round(n * 0.02));
  for (let i = half; i < cut - half - 1; i++) {
    if (!(sag[i] >= sag[i - 1] && sag[i] > sag[i + 1])) continue;
    if (sag[i] < minProm) continue;
    const last = hyps[hyps.length - 1];
    if (last && i - last.index < minSep) {
      if (sag[i] > last.prominence)
        hyps[hyps.length - 1] = { index: i, s: s[i], point: points[i], prominence: sag[i] };
      continue;
    }
    hyps.push({ index: i, s: s[i], point: points[i], prominence: sag[i] });
  }
  hyps.sort((u, v) => v.prominence - u.prominence);
  return hyps.slice(0, 4);
}

/**
 * 用踏面段（测量弧长后 ~40%，廓形最长近直线部分）PCA 主方向估计采集旋转。
 * 返回把测量踏面方向转到标准踏面方向所需的初始角 theta0。
 */
function estimateThetaFromTread(points: Point[], std: StandardProfile): number {
  const n = points.length;
  const i0 = Math.floor(n * 0.58);
  let cx = 0;
  let cy = 0;
  for (let i = i0; i < n; i++) {
    cx += points[i].x;
    cy += points[i].y;
  }
  const m = n - i0;
  cx /= m;
  cy /= m;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = i0; i < n; i++) {
    const x = points[i].x - cx;
    const y = points[i].y - cy;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  let phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // 主方向符号：与该窗口首->尾位移一致
  const dx = points[n - 1].x - points[i0].x;
  const dy = points[n - 1].y - points[i0].y;
  if (Math.cos(phi) * dx + Math.sin(phi) * dy < 0) phi += Math.PI;
  const treadIdx = std.tags.indexOf('tread');
  const stdAng = Math.atan2(std.tangent[treadIdx].y, std.tangent[treadIdx].x);
  return phi - stdAng;
}

interface Pair {
  src: Point;
  dst: Point;
  signed: number;
  hit: ProjectionHit;
  idx: number;
}

function collectPairs(
  transformed: Point[],
  std: StandardProfile,
  allowed: Set<SegmentTag>,
  maxDist: number,
): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < transformed.length; i++) {
    const hit = projectToStandard(transformed[i], std, allowed, maxDist);
    if (!hit) continue;
    // 关键：标准廓形弧长之外的“钳制到端点”投影不参与配准，杜绝端点平移填充。
    if (hit.beyondExtent) continue;
    // 法向方向门：测量顶点弦切向旋转后须与标准切向同向（dot>0），拒绝反射式错配。
    const g0 = Math.max(0, i - 2);
    const g1 = Math.min(transformed.length - 1, i + 2);
    if (g1 - g0 >= 2) {
      const tm = normalize(sub(transformed[g1], transformed[g0]));
      const ts = std.tangent[hit.segIndex];
      if (tm.x * ts.x + tm.y * ts.y < 0) continue;
    }
    pairs.push({ src: transformed[i], dst: hit.point, signed: hit.signedNormal, hit, idx: i });
  }
  return pairs;
}

/** 段平衡权重：让短段（根弧/喉面）不被长踏面淹没。 */
function segmentBalancedWeights(pairs: Pair[]): number[] {
  const counts = new Map<string, number>();
  for (const p of pairs) counts.set(p.hit.tag, (counts.get(p.hit.tag) ?? 0) + 1);
  const total = pairs.length || 1;
  return pairs.map((p) => total / ((counts.get(p.hit.tag) ?? 1) * counts.size));
}

export function runIcp(
  measured: Point[],
  std: StandardProfile,
  opts: AlignmentOptions,
  initial: RigidTransform,
  rootWorld?: Point,
  iterations = 26,
): IcpResult {
  const allowed = new Set(opts.referenceSegments);
  let transform: RigidTransform = initial;
  let last: { rms: number; pairs: Pair[] } = { rms: Infinity, pairs: [] };
  let prevRms = Infinity;
  for (let it = 0; it < iterations; it++) {
    const transformed = measured.map((p) => applyTransform(p, transform));
    const pairs = collectPairs(transformed, std, allowed, opts.maxPairDistance);
    if (pairs.length < 6) break;
    const w = segmentBalancedWeights(pairs);
    // 稳健：用有符号法向残差的 MAD 剔除粗差，权重二值化（Huber 式）
    const signed = pairs.map((p) => p.signed);
    const med = median(signed);
    const mad = median(signed.map((v) => Math.abs(v - med))) || 1e-6;
    const sigma = 1.4826 * mad;
    let acc = 0;
    const used: { pair: Pair; weight: number }[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const z = Math.abs(pairs[i].signed - med) / sigma;
      const robust = z > opts.outlierNormSigma ? 0 : w[i];
      if (robust > 0) used.push({ pair: pairs[i], weight: robust });
      acc += robust * pairs[i].signed * pairs[i].signed;
    }
    const wsum = used.reduce((a, u) => a + u.weight, 0) || 1;
    const rms = Math.sqrt(acc / wsum);
    last = { rms, pairs };
    if (used.length < 6) break;
    if (Math.abs(prevRms - rms) < 1e-7) break;
    prevRms = rms;

    // 点到切平面（point-to-plane）增量：每对只约束法向残差，切向自由滑动。
    // 源/目标都在世界坐标；定义增量 q' = C + R(w)(q - C) + (a,b)，
    // C 取当前已用点的质心（旋转中心），J = (-(q.y-C.y), (q.x-C.x))。
    let Cx = 0;
    let Cy = 0;
    for (const { pair, weight } of used) {
      Cx += weight * pair.src.x;
      Cy += weight * pair.src.y;
    }
    Cx /= wsum;
    Cy /= wsum;
    let A00 = 0, A01 = 0, A02 = 0, A11 = 0, A12 = 0, A22 = 0;
    let b0 = 0, b1 = 0, b2 = 0;
    for (const { pair, weight } of used) {
      const rx = pair.src.x - Cx;
      const ry = pair.src.y - Cy;
      const nx = pair.hit.normal.x;
      const ny = pair.hit.normal.y;
      const jw = -ry * nx + rx * ny;
      // n·(q'-p)=0 => jw*w + nx*a + ny*b = n·(p-q)
      const rhs = (pair.dst.x - pair.src.x) * nx + (pair.dst.y - pair.src.y) * ny;
      A00 += weight * jw * jw;
      A01 += weight * jw * nx;
      A02 += weight * jw * ny;
      A11 += weight * nx * nx;
      A12 += weight * nx * ny;
      A22 += weight * ny * ny;
      b0 += weight * jw * rhs;
      b1 += weight * nx * rhs;
      b2 += weight * ny * rhs;
    }
    // 软锁根锦标：把测量根点拉向标准根点（x/y 双向，权重适中）。
    // 相比硬钉扎，它允许其余廓形主导配准；锁到“真根/孪生根”仅造成根区局部差异，
    // 因而能产生两个高质量、分数接近的候选。
    if (opts.lockRoot && rootWorld) {
      const qr = applyTransform(rootWorld, transform);
      const target = std.rootChampionship.point;
      const anchorWeight = Math.max(wsum * 0.035, 4);
      for (const nrm of [
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]) {
        const rx = qr.x - Cx;
        const ry = qr.y - Cy;
        const jw = -ry * nrm.x + rx * nrm.y;
        const rhs = (target.x - qr.x) * nrm.x + (target.y - qr.y) * nrm.y;
        A00 += anchorWeight * jw * jw;
        A01 += anchorWeight * jw * nrm.x;
        A02 += anchorWeight * jw * nrm.y;
        A11 += anchorWeight * nrm.x * nrm.x;
        A12 += anchorWeight * nrm.x * nrm.y;
        A22 += anchorWeight * nrm.y * nrm.y;
        b0 += anchorWeight * jw * rhs;
        b1 += anchorWeight * nrm.x * rhs;
        b2 += anchorWeight * nrm.y * rhs;
      }
    }
    const reg = 1e-9;
    const M = [
      [A00 + reg, A01, A02, b0],
      [A01, A11 + reg, A12, b1],
      [A02, A12, A22 + reg, b2],
    ];
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      const tmp = M[col];
      M[col] = M[piv];
      M[piv] = tmp;
      const pivVal = M[col][col] || 1e-12;
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = M[r][col] / pivVal;
        for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
      }
    }
    const dtheta = clamp(M[0][3] / (M[0][0] || 1e-12), -0.2, 0.2);
    const da = M[1][3] / (M[1][1] || 1e-12);
    const db = M[2][3] / (M[2][2] || 1e-12);
    // q' = R(w) q + t'，其中 t' = C - R(w)C + (a,b)
    const cw = Math.cos(dtheta);
    const sw = Math.sin(dtheta);
    // 世界坐标增量：T_new = R_w·T + t_w，t_w = C - R_w·C + (a,b)。
    const twx = Cx - (cw * Cx - sw * Cy) + da;
    const twy = Cy - (sw * Cx + cw * Cy) + db;
    const composed: RigidTransform = {
      theta: transform.theta + dtheta,
      tx: cw * transform.tx - sw * transform.ty + twx,
      ty: sw * transform.tx + cw * transform.ty + twy,
    };

    transform = composed;
    if (Math.abs(dtheta) < 1e-7 && Math.abs(da) < 1e-6 && Math.abs(db) < 1e-6) break;
  }

  const transformed = measured.map((p) => applyTransform(p, transform));
  const finalPairs = collectPairs(transformed, std, allowed, opts.maxPairDistance);
  const signed = finalPairs.map((p) => p.signed);
  const med = median(signed);
  const mad = median(signed.map((v) => Math.abs(v - med))) || 1e-6;
  const sigma = 1.4826 * mad;
  const weights = finalPairs.map((p) =>
    Math.abs(p.signed - med) / sigma > opts.outlierNormSigma ? 0 : 1,
  );
  let acc = 0;
  let max = 0;
  let usedCount = 0;
  for (let i = 0; i < finalPairs.length; i++) {
    if (weights[i] === 0) continue;
    acc += finalPairs[i].signed * finalPairs[i].signed;
    max = Math.max(max, Math.abs(finalPairs[i].signed));
    usedCount++;
  }
  const rms = usedCount ? Math.sqrt(acc / usedCount) : last.rms;
  const measuredRoot = rootWorld ? applyTransform(rootWorld, transform) : undefined;
  return {
    transform,
    rms: isFinite(rms) ? rms : 1e6,
    paired: usedCount,
    eligible: transformed.length,
    residualMax: max,
    residualMean: usedCount && signed.length ? Math.abs(med) : 0,
    weights,
    measuredRoot,
  };
}

/* ===================== 两阶段多候选对齐 ===================== */

interface SeedSpec {
  name: string;
  initial: RigidTransform;
  lock: boolean;
  rootWorld?: Point;
  auxiliary?: boolean;
}

function makeInitial(
  measured: Point[],
  std: StandardProfile,
  theta: number,
  anchorMeasured: Point,
  anchorStd: Point,
): RigidTransform {
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  return {
    theta,
    tx: anchorStd.x - (c * anchorMeasured.x - sn * anchorMeasured.y),
    ty: anchorStd.y - (sn * anchorMeasured.x + c * anchorMeasured.y),
  };
}

function centroid(points: Point[]): Point {
  let c = { x: 0, y: 0 };
  for (const p of points) c = add(c, p);
  return scale(c, 1 / points.length);
}

/** 第一阶段：多个角度网格初值的全局（不锁根）point-to-plane ICP，取最优粗配准。 */
function coarseAlign(
  measured: Point[],
  std: StandardProfile,
  opts: AlignmentOptions,
): { transform: RigidTransform; rms: number } {
  const thetaBase = estimateThetaFromTread(measured, std);
  const cm = centroid(measured);
  const cs = centroid(std.points);
  let best: { transform: RigidTransform; rms: number } | null = null;
  for (let k = -8; k <= 8; k++) {
    const theta = thetaBase + k * 0.04;
    const init = makeInitial(measured, std, theta, cm, cs);
    const r = runIcp(measured, std, opts, init, undefined, 30);
    if (!best || r.rms < best.rms) best = { transform: r.transform, rms: r.rms };
  }
  return best!;
}

/**
 * 构建第二阶段种子：
 *  - 锁根：在粗配准后的标准坐标检测多个根候选，每个都钉到标准根锦标做精配准；
 *  - 不锁根：围绕粗配准做小角度扰动，覆盖其邻域局部解。
 * 另始终保留粗配准本身（grid 基线），保证存在全局对照。
 */
function buildRefinedSeeds(
  measured: Point[],
  std: StandardProfile,
  opts: AlignmentOptions,
  coarse: RigidTransform,
): SeedSpec[] {
  const seeds: SeedSpec[] = [{ name: 'coarse-grid', initial: coarse, lock: false }];

  if (opts.lockRoot) {
    const roots = detectRootsInStdFrame(measured, std, coarse, {
      minProminence: 0.35,
      minIndexSep: 3,
      maxPairDistance: opts.maxPairDistance,
    });
    roots.forEach((rh, ri) => {
      // 用粗配准解作为初值，但把测量根点钉到标准根锦标（只平移对齐根点，旋转沿用粗配准）。
      const moved = applyTransform(rh.measuredPoint, coarse);
      const shifted: RigidTransform = {
        theta: coarse.theta,
        tx: coarse.tx + (std.rootChampionship.point.x - moved.x),
        ty: coarse.ty + (std.rootChampionship.point.y - moved.y),
      };
      for (const off of [-0.03, 0, 0.03]) {
        seeds.push({
          name: `root-cand${ri}(prom=${rh.prominence.toFixed(2)},stdS=${rh.stdS.toFixed(1)})${
            off ? `+${off.toFixed(2)}` : ''
          }`,
          initial: { ...shifted, theta: shifted.theta + off },
          lock: true,
          rootWorld: rh.measuredPoint,
        });
      }
    });
  } else {
    for (const off of [-0.04, -0.02, 0.02, 0.04]) {
      seeds.push({ name: `coarse-perturb(${off.toFixed(2)})`, initial: { ...coarse, theta: coarse.theta + off }, lock: false });
    }
  }
  return seeds;
}

function dedupeCandidates(cands: AlignmentCandidate[]): AlignmentCandidate[] {
  const kept: AlignmentCandidate[] = [];
  const sorted = cands.slice().sort((a, b) => a.score - b.score);
  for (const c of sorted) {
    const dup = kept.find(
      (k) =>
        Math.abs(k.transform.theta - c.transform.theta) < 0.008 &&
        Math.hypot(k.transform.tx - c.transform.tx, k.transform.ty - c.transform.ty) < 0.6,
    );
    if (!dup) kept.push(c);
  }
  return kept;
}

export interface AlignmentOutput {
  candidates: AlignmentCandidate[];
  selected: AlignmentCandidate;
}

/**
 * 多候选刚体对齐。
 * - 多条局部近似同分时全部保留；选择由“内容指纹”确定性决定，绝不依赖导入顺序。
 * - 基准段、锁根锦标、近似同分阈值都进入评分与候选元数据。
 */
export function alignProfile(
  arcS: number[],
  measured: Point[],
  std: StandardProfile,
  opts: AlignmentOptions,
): AlignmentOutput {
  void arcS;
  const coarse = coarseAlign(measured, std, opts);
  const seeds = buildRefinedSeeds(measured, std, opts, coarse.transform);
  const raws: AlignmentCandidate[] = [];

  for (const seed of seeds) {
    const icp = runIcp(measured, std, opts, seed.initial, seed.lock ? seed.rootWorld : undefined, 30);
    const coverage = icp.paired / Math.max(1, measured.length);
    const coveragePenalty = (1 - coverage) * 2.0;
    const score = icp.rms + coveragePenalty;
    const candidateId = stableHash({
      theta: round(icp.transform.theta, 5),
      tx: round(icp.transform.tx, 4),
      ty: round(icp.transform.ty, 4),
    });
    raws.push({
      candidateId,
      transform: icp.transform,
      score,
      relativeGap: 0,
      nearBest: false,
      seed: seed.name,
      rootLocked: seed.lock,
      auxiliary: seed.auxiliary ?? false,
      referenceSegments: opts.referenceSegments.slice(),
      pairedPoints: icp.paired,
      coverage,
      measuredRoot: icp.measuredRoot,
    });
  }

  const cands = dedupeCandidates(raws);
  // 近同分与代表选择都在“全部候选”上进行：物理更优的解（无论是否锁根）自然胜出。
  // 粗配准基线也参与，但通过 seed 名称可追溯；多锁根假设全部保留。
  const best = Math.min(...cands.map((c) => c.score));
  for (const c of cands) {
    c.relativeGap = best > 0 ? (c.score - best) / best : c.score - best;
    c.nearBest = c.relativeGap <= opts.nearTieRelThreshold;
  }
  // 排序：分数优先，同分时按内容指纹（与导入顺序无关、可复现）。
  cands.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return a.score - b.score;
    return a.candidateId < b.candidateId ? -1 : 1;
  });
  // 代表性候选：近似同分集合中内容指纹最小者（确定性），而非数组首项。
  const near = cands.filter((c) => c.nearBest);
  const pool = near.length >= 1 ? near : cands;
  const selected = pool.slice().sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return a.score - b.score;
    return a.candidateId < b.candidateId ? -1 : 1;
  })[0];
  return { candidates: cands, selected };
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
