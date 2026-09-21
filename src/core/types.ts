/**
 * 轮对二维轮廓领域类型。
 *
 * 坐标约定（轮对局部坐标系，单位 mm）：
 *  - x：车轮横向（踏面延伸方向为 +x）
 *  - y：车轮径向（远离轮轴方向为 +y）
 *  - 点序（canonical 方向）：沿实际弧长 s 递增，
 *    从轮缘内侧工作面出发，经轮缘顶点、轮缘根部（root）圆角，
 *    到踏面向外的平直段。
 */

export interface Pt {
  x: number;
  y: number;
}

/** 采集方向：采集设备沿廓形行走的方向 */
export type CaptureDirection = 'forward' | 'reverse';

/** 单条测量轮廓（导入后的原始批次记录，尚未规范化） */
export interface RawProfile {
  id: string;
  wheelPosition: string;
  epoch: string;
  /** 采集序号（同一轮位多期轮廓的时间序） */
  seq: number;
  /** 导入时点的原始方向标记，未知时 unknown，由几何判据复核 */
  declaredDirection: CaptureDirection | 'unknown';
  points: Pt[];
  note?: string;
}

/** 弧长参数化后的折线 */
export interface Polyline {
  pts: Pt[];
  /** 累积弧长，长度 = pts.length */
  cumS: number[];
  totalLength: number;
}

/** 廓形语义段标签 */
export type SegmentTag =
  | 'flange-face'
  | 'flange-tip'
  | 'flange-root'
  | 'tread'
  | 'outside-cut';

export interface SegmentRange {
  tag: SegmentTag;
  /** 弧长区间 [s0, s1] */
  s0: number;
  s1: number;
}

/** 规范化后的测量轮廓 */
export interface NormalizedProfile {
  raw: RawProfile;
  poly: Polyline;
  /** 规范化结果是否对输入做过显式语义翻转 */
  flipped: boolean;
  /** 规范化时采用的方向判据置信度 0..1 */
  orientationScore: number;
  segments: SegmentRange[];
  /** 采集截断：相对标准廓形，起始/结束弧长缺口（mm）。0 表示完整 */
  missingStartS: number;
  missingEndS: number;
}

/** 标准廓形版本（进入结果指纹） */
export interface StandardProfile {
  version: string;
  poly: Polyline;
  segments: SegmentRange[];
  /** 限界：按语义段给出的允许磨耗厚度（法向，mm） */
  limits: WearLimit[];
}

export interface WearLimit {
  tag: SegmentTag;
  /** 报警限（mm） */
  warning: number;
  /** 超限限（mm） */
  critical: number;
}

export type BasisSegment = 'full' | 'tread' | 'flange-root-lock' | 'flange-tip';

/** 配准评分所用的几何段（区别于用户选择的分析基准 basis）。
 *  root-lock 时默认只在无磨耗的 root/tip/face 上评分，避免磨耗拖动刚体。 */
export type RegisterScope = 'basis' | 'unworn-flange';

export interface AlignOptions {
  basis: BasisSegment;
  /** 锁定轮缘根部锦标（root 圆心半径锦标）：true 时旋转锚定 root 圆弧 */
  lockRoot: boolean;
  /** 配准评分范围；默认 root-lock 用无磨耗轮缘侧 */
  registerScope?: RegisterScope;
  /** 预补偿测头偏差（mm，沿标准法向，正值=测头读数偏内）；
   *  配准前从测量点扣除，消除法向偏置在弯曲段上的切向耦合 */
  biasGuess?: number;
  /** 污点弧长区间（测量廓形自身坐标），对齐与磨耗计算时排除 */
  excludedIntervals: Array<{ s0: number; s1: number }>;
  /** 候选保留阈值：次优分数与最优分数差小于该比例时同时保留 */
  tieTolRatio: number;
}

/** 刚体变换：p -> R(theta) p + t */
export interface RigidXform {
  theta: number;
  tx: number;
  ty: number;
}

export interface AlignCandidate {
  rank: number;
  xform: RigidXform;
  /** 对齐残差（基准段法向 RMS，mm） */
  score: number;
  /** 与最优分的相对差 */
  scoreGap: number;
  /** 候选来源说明，保证可追溯 */
  provenance: string;
  /** 参与配准的基准段弧长范围（标准廓形坐标） */
  basisRanges: Array<{ s0: number; s1: number }>;
  retained: boolean;
}

export interface NormalWearSample {
  s: number;
  /** 测量点（变换后） */
  p: Pt;
  /** 标准廓形最近点 */
  q: Pt;
  /** 标准廓形在 q 处的单位法向（指向材料外侧） */
  n: Pt;
  /** 法向磨耗厚度：>0 材料被磨去，<0 测量点位于标准廓形内侧 */
  wear: number;
  segment: SegmentTag;
  excluded: boolean;
  /** true 表示该点落在标准廓形弧长范围之外（截断侧外推区，禁止填充） */
  beyondStandard: boolean;
}

export interface LimitViolation {
  segment: SegmentTag;
  s0: number;
  s1: number;
  maxWear: number;
  level: 'warning' | 'critical';
  limitVersion: string;
}

export interface AlignmentResult {
  profileId: string;
  chosenCandidateRank: number;
  candidates: AlignCandidate[];
  wear: NormalWearSample[];
  violations: LimitViolation[];
  /** 对齐残差序列（基准段上的测量点残差） */
  residuals: Array<{ s: number; d: number }>;
  rms: number;
  probeBiasApplied: number;
  probeBiasSource: 'shared' | 'independent' | 'none';
}
