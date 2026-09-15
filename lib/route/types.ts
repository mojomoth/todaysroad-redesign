/**
 * 지도 이미지 세그멘테이션 기반 코스 생성 — 공용 타입·상수.
 *
 * 이 디렉터리(lib/route/*)는 `@/` 별칭 없이 상대 import만 사용한다
 * (워커·개발용 페이지·향후 Node 테스트에서 그대로 재사용하기 위해).
 * `const enum`은 isolatedModules에서 인라인되지 않으므로 `as const` 객체를 쓴다.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export type Minutes = 15 | 30 | 60 | 120;

/** 픽셀 클래스 (Uint8 라벨 값) */
export const Cls = {
  UNKNOWN: 0,
  LAND: 1,
  URBAN: 2,
  BUILT: 3,
  WATER: 4,
  GREEN: 5,
  OPEN: 6,
  GRAY: 7,
  TRUNK: 8,
  MAJOR: 9,
  SEC_CASE: 10,
  MINOR: 11,
  MINOR_CASE: 12,
  PATH: 13,
} as const;
export type ClsId = (typeof Cls)[keyof typeof Cls];
export const NUM_CLS = 14;

/** 통행 격자 셀 종류 (graph.ts) */
export const WalkKind = {
  NONE: 0,
  MINOR: 1,
  SECONDARY: 2,
  MAJOR: 3,
  PATH: 4,
  /** 고속화도로: 통행 제외 */
  TRUNK: 5,
  /** 이전 디버그 결과 호환용. 녹지는 더 이상 통행면으로 사용하지 않는다. */
  PARK: 6,
} as const;
export type WalkKindId = (typeof WalkKind)[keyof typeof WalkKind];

/* ---------- 상수 ---------- */

export const WALK_KMH = 4;
export const TILE_PX = 512;
export const MAX_TILES_PER_SIDE = 4;
export const WINDOW_HALF_FACTOR = 2.2;
export const ZOOM_BY_MINUTES: Record<Minutes, number> = { 15: 17, 30: 16, 60: 15, 120: 14 };
export const K_BY_MINUTES: Record<Minutes, number> = { 15: 3, 30: 3, 60: 4, 120: 5 };

export function targetMetres(minutes: Minutes): number {
  return (minutes / 60) * WALK_KMH * 1000;
}
export function loopRadiusM(minutes: Minutes): number {
  return targetMetres(minutes) / (2 * Math.PI);
}
export function downsampleFor(z: number): number {
  return z >= 17 ? 4 : 3;
}
/** 셀을 도로 셀로 보는 도로 분율 임계 (z14는 fill만 계산하므로 더 높게) */
export function roadCellThreshold(z: number): number {
  return z >= 15 ? 0.2 : 0.34;
}

/** 통행 비용 (m당). 비통행 셀은 Infinity */
export const COST = {
  minor: 1.0,
  secondary: 1.1,
  major: 1.3,
  path: 1.6,
  trunk: 15,
  park: 2.0,
  themeMin: 0.6,
  themeMax: 3,
  reuse: 2,
  reuseCap: 8,
} as const;

/** 도로거리 밴드 (L* 배수) 와 섹터(도) */
export const BANDS = {
  turn: [0.25, 0.34] as const,
  side: [0.11, 0.22] as const,
  mid: [0.17, 0.26] as const,
  sideSector: [50, 110] as const,
  midSector: [10, 40] as const,
  widen: [0.12, 0.48] as const,
  turnFallbackFrac: 0.3,
} as const;

export const LOOP = {
  tol: 0.1,
  accept: 0.3,
  maxIter: 3,
  scaleMin: 0.5,
  scaleMax: 1.3,
  scaleExp: 0.8,
  softmaxTau: 0.5,
  topN: 5,
  dpEpsCells: 1.2,
} as const;

export const GUARD = {
  minClassified: 0.4,
  snapMaxM: 150,
  snapMaxRiverM: 250,
  minReachableFrac: 0.05,
  tileTimeoutMs: 3000,
  totalTimeoutMs: 60000,
  minPillMs: 600,
  phaseDwellMs: 300,
  maxMissingTiles: 2,
  maxCandidates: 400,
  darkMax: 140,
} as const;

export const REGION = {
  greenMinM2: 800,
  waterMinM2: 2000,
  parkMinM2: 20000,
  featureRadiusM: 60,
  waterNearM: 120,
  minorDensityRadiusM: 120,
  macroStrideM: 150,
  shoreStrideM: 120,
} as const;

/* ---------- 격자 · 모자이크 ---------- */

/** 타일 격자 계획 (캔버스 px = 타일 좌상단 기준 전역 px 오프셋) */
export interface GridPlan {
  z: number;
  tilePx: number;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** 캔버스 크기(px) */
  width: number;
  height: number;
  /** m / px (원점 위도 기준) */
  mpp: number;
  origin: LatLng;
  /** 원점의 캔버스 px 좌표 */
  originPx: { x: number; y: number };
  /** 분석 창 반폭(m) = WINDOW_HALF_FACTOR · R */
  windowHalfM: number;
}

export interface Mosaic {
  plan: GridPlan;
  rgba: Uint8ClampedArray;
  /** cols*rows, 1 = 타일 결손 */
  missing: Uint8Array;
}

/** terrarium 고도 격자 (256px 타일, 자체 줌의 전역 px 공간) */
export interface ElevationField {
  z: number;
  tilePx: number;
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** 미터 단위 고도, 결손 = NaN */
  data: Float32Array;
}

/* ---------- 셀 격자 ---------- */

export interface CellGrid {
  gw: number;
  gh: number;
  down: number;
  /** m / cell */
  cellM: number;
  /** gw*gh*NUM_CLS, 셀별 클래스 분율 0..255 (layout: cell*NUM_CLS + cls) */
  frac: Uint8Array;
  /** gw*gh, 도로 분율 0..255 (줌 규칙: z15+는 fill+casing, z14는 fill만) */
  road: Uint8Array;
  /** gw*gh, 도로 셀 여부 0/1 */
  roadCell: Uint8Array;
  /** gw*gh, 도로 폭 추정(m) — 셀 반폭 max-pool ×2 */
  widthM: Float32Array;
}

export interface Region {
  id: number;
  cls: ClsId;
  cells: number;
  areaM2: number;
  /** 무게중심(셀 좌표) */
  cx: number;
  cy: number;
  /** pole of inaccessibility(셀 좌표) */
  poleX: number;
  poleY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  touchesWater: boolean;
}

/** 통행 격자 (graph.ts) */
export interface WalkGrid {
  gw: number;
  gh: number;
  cellM: number;
  /** gw*gh, WalkKind */
  kind: Uint8Array;
  /** gw*gh, 후보 스냅·거리장용 통행(TRUNK 제외) 0/1 */
  walkable: Uint8Array;
  /** gw*gh, A* 통행(TRUNK 제외) 0/1 */
  passable: Uint8Array;
  widthM: Float32Array;
}

/** 셀별 테마 특징 (0..1) */
export interface CellFeatures {
  nearGreen: Float32Array;
  nearWater: Float32Array;
  /** 정규화 경사 0..1 (없으면 모두 0) */
  slope: Float32Array;
  /** 골목(얇은 도로) 0/1 */
  thin: Uint8Array;
}

/** 시드 난수 (loop.ts createRng) — 모든 확률적 선택은 이 스트림 하나만 쓴다 */
export interface Rng {
  /** [0,1) */
  next(): number;
  /** [0,n) 정수 */
  int(n: number): number;
  bool(p?: number): boolean;
  /** [a,b) 실수 */
  range(a: number, b: number): number;
}

/** A* 셀 비용의 테마 가중 (양수 = 회피, 음수 = 선호) */
export interface ThemeCostWeights {
  nearGreen: number;
  nearWater: number;
  major: number;
  secondary: number;
  thin: number;
  slope: number;
}

/* ---------- 후보 정점 ---------- */

export const FEAT = {
  green: 0,
  open: 1,
  water: 2,
  waterNear: 3,
  built: 4,
  major: 5,
  secondary: 6,
  minor: 7,
  thin: 8,
  path: 9,
  minorDensity: 10,
  elevGain: 11,
  slope: 12,
} as const;
export type FeatKey = keyof typeof FEAT;
export const NUM_FEAT = 13;

export type CandidateKind = "green" | "shore" | "built" | "road" | "icon";

export const ELEMENT_CATEGORIES = ["green", "water", "mountain", "building", "cafe", "culture", "shop", "transit", "other"] as const;
export type ElementCategory = (typeof ELEMENT_CATEGORIES)[number];

/** 이미지 좌표만 사용한다. 외부 POI 좌표나 장소 검색 결과는 받지 않는다. */
export interface MapElement {
  id: string;
  kind: "nature" | "building" | "icon";
  category: ElementCategory;
  label: string;
  /** 스냅샷의 원본 픽셀 좌표. 범위는 이미지 경계 안이어야 한다. */
  x: number;
  y: number;
  bounds: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface RouteStrategy {
  requestedTags: string[];
  candidateCount: number;
  filteredCount: number;
  matchedTags: string[];
  missingTags: string[];
}

export interface Candidate {
  /** 스냅된 통행 셀 인덱스 */
  cell: number;
  cx: number;
  cy: number;
  kind: CandidateKind;
  /** 원점으로부터의 도로거리(m) */
  d: number;
  /** 원점 기준 방위(rad, 캔버스 좌표계 atan2(dy,dx)) */
  bearing: number;
  f: Float32Array;
  /** 결정적 테마 점수 */
  score: number;
  regionId?: number;
  element?: MapElement;
  matchedTags?: string[];
}

/* ---------- 결과 ---------- */

export type WaypointKind = "side" | "mid" | "turn";

export interface Waypoint {
  lat: number;
  lng: number;
  pathIndex: number;
  kind: WaypointKind;
  label?: string;
  category?: ElementCategory;
  matchedTags?: string[];
}

export interface RouteFacts {
  /** 경로 30 m 이내 녹지 성분 수 */
  greenRegions: number;
  /** 물 60 m 이내 경로 길이(m) */
  waterEdgeM: number;
  /** 경로 셀의 종류별 비율 */
  roadShare: Record<"minor" | "secondary" | "major" | "path" | "park" | "trunk", number>;
}

export interface RouteResult {
  path: LatLng[];
  waypoints: Waypoint[];
  turnIndex: number;
  lengthM: number;
  targetM: number;
  ascentM: number | null;
  facts: RouteFacts;
  seed: number;
  zoom: number;
  timings: Record<string, number>;
  classifiedFraction: number;
  unreachableRoadShare: number;
  iterations: number;
  converged: boolean;
  strategy: RouteStrategy;
  elements: MapElement[];
  startOffsetM: number;
  semanticStatus: "analyzed" | "unavailable";
}

export type RouteFailReason =
  | "tiles"
  | "taint"
  | "blank"
  | "no-road"
  | "diverged"
  | "timeout"
  | "unsupported"
  | "error"
  | "aborted"
  | "location"
  | "no-match"
  | "vision-unavailable";

export class RouteError extends Error {
  reason: RouteFailReason;
  constructor(reason: RouteFailReason, message?: string) {
    super(message ?? reason);
    this.name = "RouteError";
    this.reason = reason;
  }
}

export interface PipelineInput {
  origin: LatLng;
  minutes: Minutes;
  tags: string[];
  seed: number;
  plan: GridPlan;
  debug?: boolean;
  elements?: MapElement[];
  semanticStatus?: "analyzed" | "unavailable";
}

export type Phase = "locating" | "snapshot" | "reading" | "strategy" | "filtering" | "vertices" | "linking";

/* ---------- 워커 프로토콜 ---------- */

export type WorkerIn = {
  type: "run";
  token: number;
  input: PipelineInput;
  rgba: Uint8ClampedArray;
  missing: Uint8Array;
  elev: ElevationField | null;
};

export type WorkerOut =
  | { type: "phase"; token: number; phase: Phase }
  | { type: "result"; token: number; result: RouteResult }
  | { type: "error"; token: number; reason: RouteFailReason; message: string };
