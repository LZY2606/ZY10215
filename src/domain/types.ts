// 领域类型：轮对二维轮廓、标准廓形、对齐候选、磨耗与限界结果

/** 二维点。x：车轴方向（轮缘由内向外为正）；y：径向（背离轮心为正）。 */
export interface Point {
  x: number;
  y: number;
}

/** 标准廓形的区段标签（沿弧长由轮缘内侧到踏面外侧）。 */
export type SegmentTag =
  | 'rim_inner' // 轮缘内侧面（近轮缘顶部）
  | 'flange_face' // 轮缘外侧斜面（喉面）
  | 'flange_root' // 轮缘根部过渡弧（根弧，含锦标锚点）
  | 'tread' // 踏面（1:20 锥度基准段）
  | 'outer_chamfer'; // 踏面外端倒角

/** 轮廓采集方向：与标准弧长同向为 forward，相反为 reverse。 */
export type ScanOrientation = 'forward' | 'reverse';

/** 标准廓形定义：按实际弧长参数化的稠密折线 + 区段映射。 */
export interface StandardProfile {
  /** 限界/廓形版本号，进入结果指纹。 */
  version: string;
  /** 弧长参数（等距重采样后），单位 mm。 */
  s: number[];
  points: Point[];
  /** 每点所属区段标签。 */
  tags: SegmentTag[];
  /** 单位切向 t=(dx/ds,dy/ds)。 */
  tangent: Point[];
  /** 指向廓形外侧（材料表面法向）的单位法向。 */
  normal: Point[];
  /** 轮缘根部锦标锚点（根弧曲率峰值处）。 */
  rootChampionship: { s: number; point: Point; curvature: number };
  /** 各区段在弧长上的起止。 */
  segmentRanges: { tag: SegmentTag; s0: number; s1: number }[];
  /** 标准限界（按版本绑定）。 */
  limit: LimitSpec;
}

/** 标准限界：各段允许的法向磨耗厚度（mm），超过即超限。 */
export interface LimitSpec {
  limitVersion: string;
  /** 按区段给出法向磨耗报警阈值（材料损失方向为正）。 */
  thresholds: Record<SegmentTag, number>;
}

/** 单期采集的原始/规整轮廓。 */
export interface ProfileInput {
  id: string;
  wheelPosition: string; // 同一轮位（如 1L-轮位）的多期共享
  epoch: string; // 采集期次标识，如 T0/T1/T2
  /** 原始导入点序（采集顺序，可能反向）。 */
  rawPoints: Point[];
  /** 采集声明的方向（导入时未知则 unknown）。 */
  declaredOrientation?: ScanOrientation | 'unknown';
  /** 采集时的随机刚体错位（仅 fixture/重放用，分析不读取真值）。 */
  fixtureTruth?: RigidTransform;
  /** 该批共享的测头偏差真值（仅 fixture 用）。 */
  sharedProbeBiasTruth?: number;
}

/** 刚体变换：q = R(theta) p + t。 */
export interface RigidTransform {
  theta: number; // 弧度
  tx: number;
  ty: number;
}

/** 点序语义翻转判定结果。 */
export interface OrientationDecision {
  orientation: ScanOrientation;
  /** 判定依据描述。 */
  method: string;
  /** 曲率特征证据（起点侧/终点侧的曲率能量）。 */
  evidence: { startEnergy: number; endEnergy: number; startMaxCurv: number; endMaxCurv: number };
  confidence: number;
  /** 是否显式翻转了点序。 */
  reversed: boolean;
}

/** 弧长重建结果。 */
export interface ArcLengthRebuild {
  s: number[];
  points: Point[];
  totalLength: number;
  /** 原始点是否等序（按弧长单调）。 */
  monotonic: boolean;
  resampleSpacing: number;
}

/** 对齐候选：多个局部近似同分时全部保留，不依赖导入顺序。 */
export interface AlignmentCandidate {
  /** 候选稳定标识（由变换内容派生，非导入序号）。 */
  candidateId: string;
  transform: RigidTransform;
  /** 加权法向残差 RMS（越小越好）。 */
  score: number;
  /** 与最优分的相对差距。 */
  relativeGap: number;
  /** 是否达到近似同分保留阈值。 */
  nearBest: boolean;
  /** 初值来源（锁根/全局网格/局部模式）。 */
  seed: string;
  /** 是否锁定轮缘根部锦标。 */
  rootLocked: boolean;
  /** 辅助粗配准基线：参与展示但不作为锁根策略主候选。 */
  auxiliary?: boolean;
  /** 对齐用到的基准段标签集合。 */
  referenceSegments: SegmentTag[];
  /** 有效配准点数与覆盖比例。 */
  pairedPoints: number;
  coverage: number;
  /** 测量根部锚点经变换后的位置（若可检出）。 */
  measuredRoot?: Point;
}

/** 法向磨耗采样：仅在标准廓形弧长被覆盖处给出，绝不端点外推。 */
export interface WearSample {
  s: number;
  /** 标准廓形上的点。 */
  standardPoint: Point;
  normal: Point;
  tag: SegmentTag;
  /** 有符号法向距离（材料损失为正）。未定义投影时为 null。 */
  signedDistance: number | null;
  /** 扣除选定测头偏差候选后的磨耗厚度。 */
  wear: number | null;
  /** 该采样是否参与（污点/投影失败不参与）。 */
  valid: boolean;
  /** 是否被标准限界判定为超限。 */
  exceedsLimit: boolean;
  threshold: number;
}

/** 连续超限区域（限界交集）。 */
export interface ExceedanceRegion {
  tag: SegmentTag;
  s0: number;
  s1: number;
  arcLength: number;
  maxWear: number;
  meanWear: number;
  limitVersion: string;
  explanation: string;
}

/** 共享测头偏差候选（整批估计，可对整批应用；每条轮廓独立选择）。 */
export interface ProbeBiasCandidate {
  candidateId: string;
  /** 法向偏差 mm（测量系统性偏置）。 */
  bias: number;
  /** 整批中位/稳健估计依据。 */
  source: string;
  /** 参与估计的轮廓。 */
  basedOn: string[];
  note: string;
}

/** 单条轮廓的分析结果。 */
export interface ProfileResult {
  profileId: string;
  wheelPosition: string;
  epoch: string;
  orientation: OrientationDecision;
  rebuild: { totalLength: number; spacing: number; pointCount: number };
  candidates: AlignmentCandidate[];
  /** 当前选用的候选 id（独立选择，不随整批应用而强制）。 */
  selectedCandidateId: string;
  selectedTransform: RigidTransform;
  alignmentResidual: { rms: number; max: number; mean: number };
  /** 该轮廓是否独立排除污点。 */
  excludeOutliers: boolean;
  excludedPointCount: number;
  /** 该轮廓独立选用的测头偏差值（可为共享候选或 0/自定义）。 */
  appliedBias: number;
  appliedBiasSource: string;
  wear: WearSample[];
  exceedances: ExceedanceRegion[];
  /** 限界版本，进入指纹。 */
  limitVersion: string;
  /** 标准/限界版本，进入指纹。 */
  standardVersion: string;
  /** 结果指纹（含限界版本、基准段、候选内容、测头选择）。 */
  fingerprint: string;
}

/** 重放记录：一次导入/分析批次的可复现记录。 */
export interface RunRecord {
  runId: string;
  createdAt: string;
  fixtureId: string;
  standardVersion: string;
  limitVersion: string;
  referenceSegments: SegmentTag[];
  lockRoot: boolean;
  excludeOutliers: boolean;
  nearTieRelThreshold: number;
  sharedBiasCandidate: ProbeBiasCandidate | null;
  profileResults: ProfileResult[];
  /** 输入点云指纹（顺序无关）。 */
  inputFingerprint: string;
}
