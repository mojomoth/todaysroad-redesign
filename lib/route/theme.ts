/**
 * 테마: 후보 정점 수집 · 결정적 테마 점수 · 도로거리 밴드/방위 섹터 기반 경유지 선택.
 *
 * 모든 확률적 선택은 전달된 Rng 한 스트림만 쓴다(Math.random 금지).
 * pickWaypoints의 난수 소비 순서(재현성): 밴드 지터 3회(turn/side/mid) →
 * T 룰렛 → 진행 방향 → (k==4) 중간점 측 → A → B → M1 → M2.
 */
import {
  BANDS,
  Cls,
  FEAT,
  GUARD,
  LOOP,
  NUM_FEAT,
  REGION,
  WalkKind,
  type Candidate,
  type CandidateKind,
  type CellFeatures,
  type CellGrid,
  type FeatKey,
  type GridPlan,
  type Region,
  type Rng,
  type ThemeCostWeights,
  type WalkGrid,
  type WaypointKind,
  type MapElement,
} from "./types";
import { nearestWalkable } from "./graph";
import { boxClassFrac, shoreCells } from "./raster";

/* ---------- 테마 가중 ---------- */

/** 후보 점수 가중(플랜 §3). 결정적 — 지터 없음 */
export const THEME_WEIGHTS: Record<string, Partial<Record<FeatKey, number>>> = {
  nature: { green: 3, open: 1, built: -1, major: -1 },
  urban: { built: 2, major: 0.8, minor: 0.6, green: -0.8 },
  quiet: { green: 1.5, open: 1, major: -2.5, built: -0.5 },
  lively: { major: 1.5, secondary: 0.8, built: 1.5, green: -0.5 },
  river: { waterNear: 3, water: 1 },
  alley: { minor: 1.5, thin: 2, major: -2, built: 0.8 },
  night: { major: 1.2, secondary: 0.6, waterNear: 1.2, built: 0.6 },
  cafe: { minor: 1.5, minorDensity: 1.5, built: 1.5, major: -0.5 },
  hill: { elevGain: 2.5, slope: 1 },
  flat: { slope: -2.5 },
};

/** A* 셀 비용 테마 가중(플랜 §5). 양수 = 회피, 음수 = 선호 */
const COST_TERMS: Record<string, Partial<ThemeCostWeights>> = {
  nature: { nearGreen: -1.2 },
  quiet: { major: 1.0, secondary: 0.5 },
  river: { nearWater: -1.5 },
  alley: { thin: -1.0, major: 1.2 },
  night: { major: -0.8, nearWater: -0.4 },
  lively: { major: -0.7 },
  flat: { slope: 1.5 },
};

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function themeCostWeights(tags: string[]): ThemeCostWeights {
  const w: ThemeCostWeights = { nearGreen: 0, nearWater: 0, major: 0, secondary: 0, thin: 0, slope: 0 };
  for (const tag of tags) {
    if (!hasOwn(COST_TERMS, tag)) continue; // 미지 태그 무시
    const t = COST_TERMS[tag];
    w.nearGreen += t.nearGreen ?? 0;
    w.nearWater += t.nearWater ?? 0;
    w.major += t.major ?? 0;
    w.secondary += t.secondary ?? 0;
    w.thin += t.thin ?? 0;
    w.slope += t.slope ?? 0;
  }
  return w;
}

/* ---------- 후보 수집 ---------- */

export interface ElevInput {
  elevAtCell: Float32Array | null;
  slope: Float32Array | null;
}

export interface CandidateArgs {
  grid: CellGrid;
  walk: WalkGrid;
  plan: GridPlan;
  /** GREEN + BUILT 성분 */
  regions: Region[];
  greenLabels: Int32Array;
  waterMask: Uint8Array;
  /** 원점 기준 dijkstraMetres */
  dist: Float32Array;
  originCell: number;
  tags: string[];
  elev: ElevInput;
  feats: CellFeatures;
  elements?: MapElement[];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 후보 특징 벡터(반경 창 평균). 창 반경은 셀 단위 정수 */
function candidateFeatures(a: CandidateArgs, cell: number, x: number, y: number, rFeat: number, rDens: number, builtCls: number, elevOrigin: number): Float32Array {
  const { grid, feats, elev } = a;
  const f = new Float32Array(NUM_FEAT);
  f[FEAT.slope] = -1; // 고도 이미지가 없으면 평지로 오인하지 않는다.
  f[FEAT.green] = boxClassFrac(grid, Cls.GREEN, x, y, rFeat);
  f[FEAT.open] = boxClassFrac(grid, Cls.OPEN, x, y, rFeat);
  f[FEAT.water] = boxClassFrac(grid, Cls.WATER, x, y, rFeat);
  f[FEAT.waterNear] = feats.nearWater[cell] > 0 ? 1 : 0; // nearWater>0 ⇔ 물까지 < REGION.waterNearM
  f[FEAT.built] = boxClassFrac(grid, builtCls as typeof Cls.BUILT, x, y, rFeat);
  f[FEAT.major] = boxClassFrac(grid, Cls.MAJOR, x, y, rFeat);
  f[FEAT.secondary] = boxClassFrac(grid, Cls.SEC_CASE, x, y, rFeat);
  f[FEAT.minor] = boxClassFrac(grid, Cls.MINOR, x, y, rFeat);
  f[FEAT.thin] = feats.thin[cell];
  f[FEAT.path] = boxClassFrac(grid, Cls.PATH, x, y, rFeat);
  f[FEAT.minorDensity] = boxClassFrac(grid, Cls.MINOR, x, y, rDens);
  if (elev.elevAtCell) {
    const g = (elev.elevAtCell[cell] - elevOrigin) / 40;
    f[FEAT.elevGain] = Number.isFinite(g) ? clamp01(g) : 0;
  }
  if (elev.slope) {
    const s = elev.slope[cell];
    f[FEAT.slope] = Number.isFinite(s) ? clamp01(s) : -1;
  }
  return f;
}

/**
 * 후보 정점: 녹지 pole · 물가 샘플 · 건물 성분 중심 · 매크로셀 최고 도로 셀.
 * 통행 셀(TRUNK 제외)로 스냅, d=∞ 제거, 같은 셀 중복 제거(먼저 온 종류 우선).
 * GUARD.maxCandidates 초과 시 결정적 점수 하위부터 제거하되 'green'은 보존.
 */
export function collectCandidates(a: CandidateArgs): Candidate[] {
  const { grid, walk, plan, dist, tags } = a;
  const { gw, gh, cellM } = grid;
  const n = gw * gh;
  const ox = a.originCell % gw;
  const oy = (a.originCell - ox) / gw;
  const windowWidthM = 2 * plan.windowHalfM;
  const rFeat = Math.max(1, Math.round(REGION.featureRadiusM / cellM));
  const rDens = Math.max(1, Math.round(REGION.minorDensityRadiusM / cellM));
  const builtCls = plan.z >= 15 ? Cls.BUILT : Cls.URBAN;
  const snapCells = Math.max(1, Math.ceil(GUARD.snapMaxM / cellM));
  const snapShoreCells = Math.max(1, Math.ceil((tags.includes("river") ? GUARD.snapMaxRiverM : GUARD.snapMaxM) / cellM));
  const elevOrigin = a.elev.elevAtCell ? a.elev.elevAtCell[a.originCell] : 0;

  const seen = new Uint8Array(n);
  const out: Candidate[] = [];

  const push = (cell: number, kind: CandidateKind, regionId?: number, element?: MapElement): void => {
    if (cell < 0 || cell >= n || seen[cell]) return;
    if (walk.walkable[cell] !== 1 || walk.kind[cell] === WalkKind.TRUNK) return;
    const d = dist[cell];
    if (!(d < Infinity)) return; // ∞·NaN 모두 제거
    seen[cell] = 1;
    const x = cell % gw;
    const y = (cell - x) / gw;
    const c: Candidate = {
      cell,
      cx: x,
      cy: y,
      kind,
      d,
      bearing: Math.atan2(y - oy, x - ox),
      f: candidateFeatures(a, cell, x, y, rFeat, rDens, builtCls, elevOrigin),
      score: 0,
      element,
    };
    if (regionId !== undefined) c.regionId = regionId;
    out.push(c);
  };

  // 의미가 확인된 아이콘/장소를 먼저 넣어 같은 셀의 일반 후보가 덮어쓰지 않게 한다.
  for (const element of a.elements ?? []) {
    if (element.confidence < 0.8) continue;
    const cx = element.x / grid.down - 0.5;
    const cy = element.y / grid.down - 0.5;
    const cell = nearestWalkable(walk, cx, cy, Math.ceil(60 / cellM));
    if (cell < 0 || Math.hypot(cell % gw - cx, Math.floor(cell / gw) - cy) * cellM > 60) continue;
    push(cell, element.kind === "icon" ? "icon" : element.kind === "building" ? "built" : element.category === "water" ? "shore" : "green", undefined, element);
  }

  // 1) 녹지 pole
  for (const r of a.regions) {
    if (r.cls !== Cls.GREEN) continue;
    push(nearestWalkable(walk, r.poleX, r.poleY, snapCells), "green", r.id);
  }

  // 2) 물가 샘플: shore 목록을 stride(m→셀 수)마다 취해 스냅
  const shore = shoreCells(a.waterMask, gw, gh);
  if (shore.length > 0) {
    const strideM = Math.max(REGION.shoreStrideM, windowWidthM / 40);
    const stride = Math.max(1, Math.round(strideM / cellM));
    for (let i = 0; i < shore.length; i += stride) {
      const s = shore[i];
      const sx = s % gw;
      const sy = (s - sx) / gw;
      push(nearestWalkable(walk, sx, sy, snapShoreCells), "shore");
    }
  }

  // 3) 건물 성분: pole 스냅 실패 시 무게중심으로 재시도
  for (const r of a.regions) {
    if (r.cls !== builtCls) continue;
    let cell = nearestWalkable(walk, r.poleX, r.poleY, snapCells);
    if (cell < 0) cell = nearestWalkable(walk, r.cx, r.cy, snapCells);
    push(cell, "built", r.id);
  }

  // 4) 매크로셀당 도로 분율 최고 통행 셀 (한 번의 래스터 스캔)
  {
    const macroM = Math.max(REGION.macroStrideM, windowWidthM / 18);
    const ms = Math.max(1, Math.round(macroM / cellM));
    const mcols = Math.ceil(gw / ms);
    const mrows = Math.ceil(gh / ms);
    const bestIdx = new Int32Array(mcols * mrows).fill(-1);
    const bestVal = new Int16Array(mcols * mrows).fill(-1);
    const road = grid.road;
    const walkable = walk.walkable;
    const kind = walk.kind;
    for (let y = 0; y < gh; y++) {
      const mrow = ((y / ms) | 0) * mcols;
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        if (walkable[i] !== 1 || kind[i] === WalkKind.TRUNK) continue;
        const m = mrow + ((x / ms) | 0);
        const v = road[i];
        if (v > bestVal[m]) {
          bestVal[m] = v;
          bestIdx[m] = i;
        }
      }
    }
    for (let m = 0; m < bestIdx.length; m++) if (bestIdx[m] >= 0) push(bestIdx[m], "road");
  }

  scoreCandidates(out, tags);

  // 5) 상한: 점수 하위부터 제거, 'green'은 항상 보존
  if (out.length > GUARD.maxCandidates) {
    const greens = out.filter((c) => c.kind === "green" || c.element);
    const others = out.filter((c) => c.kind !== "green" && !c.element).sort(byScoreDesc);
    const keepOthers = Math.max(0, GUARD.maxCandidates - greens.length);
    const keep = new Uint8Array(n);
    for (const c of greens) keep[c.cell] = 1;
    for (let i = 0; i < keepOthers && i < others.length; i++) keep[others[i].cell] = 1;
    return out.filter((c) => keep[c.cell] === 1); // 원래 순서 유지
  }
  return out;
}

/* ---------- 점수 ---------- */

/** c.score = Σ_tag Σ_feat THEME_WEIGHTS[tag][feat]·f[feat] (결정적) */
export function scoreCandidates(cands: Candidate[], tags: string[]): void {
  const wv = new Float32Array(NUM_FEAT);
  for (const tag of tags) {
    if (!hasOwn(THEME_WEIGHTS, tag)) continue;
    const w = THEME_WEIGHTS[tag];
    for (const key in w) {
      if (!hasOwn(w, key) || !hasOwn(FEAT, key)) continue;
      wv[FEAT[key as FeatKey]] += w[key as FeatKey] ?? 0;
    }
  }
  for (const c of cands) {
    let s = 0;
    const f = c.f;
    for (let i = 0; i < NUM_FEAT; i++) s += wv[i] * f[i];
    c.score = s;
  }
}

/** 점수 내림차순, 동점은 d 오름차순 → 셀 인덱스(완전 결정적) */
function byScoreDesc(a: Candidate, b: Candidate): number {
  return b.score - a.score || a.d - b.d || a.cell - b.cell;
}

/* ---------- 확률적 선택 ---------- */

/** softmax(score/τ) 룰렛. 수치 안정(최댓값 빼기). 항상 난수 1개 소비 */
export function softmaxPick<T>(items: T[], score: (t: T) => number, tau: number, rng: Rng): T {
  const n = items.length;
  if (n === 0) throw new Error("softmaxPick: empty items");
  let m = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = score(items[i]);
    if (s > m) m = s;
  }
  if (!Number.isFinite(m)) return items[rng.int(n)]; // 점수 전부 무한/NaN → 균등
  const t = tau > 0 ? tau : 1e-9; // τ≤0 → argmax
  const w = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = score(items[i]);
    const v = Number.isFinite(s) ? Math.exp((s - m) / t) : 0;
    w[i] = v;
    sum += v;
  }
  let r = rng.next() * sum;
  for (let i = 0; i < n; i++) {
    r -= w[i];
    if (r < 0) return items[i];
  }
  return items[n - 1];
}

/* ---------- 경유지 선택 ---------- */

export interface WaypointPick {
  ordered: Candidate[];
  kinds: WaypointKind[];
  turn: Candidate;
}

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** 밴드 [a,b]·L*: 중심만 scale 배(폭 유지) → [lo, hi] (m) */
function bandM(b: readonly [number, number], scale: number, targetM: number): [number, number] {
  const c = ((b[0] + b[1]) / 2) * scale;
  const h = (b[1] - b[0]) / 2;
  return [(c - h) * targetM, (c + h) * targetM];
}

/** 방위 차를 (-π, π]로 정규화 */
function wrapAngle(a: number): number {
  let o = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI); // [-π, π)
  if (o <= -Math.PI) o += TWO_PI;
  return o;
}

/** 점수 상위 topN 중 softmax 룰렛. pool이 비면 null(난수 미소비) */
function pickTop(pool: Candidate[], rng: Rng): Candidate | null {
  if (pool.length === 0) return null;
  const top = pool.slice().sort(byScoreDesc).slice(0, LOOP.topN);
  return softmaxPick(top, (c) => c.score, LOOP.softmaxTau, rng);
}

function inBand(cands: Candidate[], b: [number, number]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of cands) if (c.d >= b[0] && c.d <= b[1]) out.push(c);
  return out;
}

/** 밴드 안 + T 방위에서 sign·[sector] 안(도 단위) */
function inBandSector(cands: Candidate[], b: [number, number], tBearing: number, sign: number, sector: readonly [number, number]): Candidate[] {
  const lo = sector[0] * DEG;
  const hi = sector[1] * DEG;
  const out: Candidate[] = [];
  for (const c of cands) {
    if (c.d < b[0] || c.d > b[1]) continue;
    const o = wrapAngle(c.bearing - tBearing) * sign;
    if (o >= lo && o <= hi) out.push(c);
  }
  return out;
}

/**
 * 반환점 T → 측면 A/B(±[50°,110°]) → 중간 M1/M2(±[10°,40°], k≥4) 선택.
 * ordered = [A, M1, T, M2, B] (없는 것은 생략), kinds 병렬. cands가 비면 null.
 */
export function pickWaypoints(cands: Candidate[], targetM: number, k: number, scale: number, rng: Rng): WaypointPick | null {
  if (cands.length === 0) return null;

  // 밴드 중심 지터(밴드별 1회, 고정 순서)
  const jTurn = rng.range(0.92, 1.08);
  const jSide = rng.range(0.92, 1.08);
  const jMid = rng.range(0.92, 1.08);
  const turnB = bandM(BANDS.turn, scale * jTurn, targetM);
  const sideB = bandM(BANDS.side, scale * jSide, targetM);
  const midB = bandM(BANDS.mid, scale * jMid, targetM);

  // T: 밴드 → 확대 밴드 → argmin|d − 0.3·scale·L*|
  let T = pickTop(inBand(cands, turnB), rng);
  if (!T) T = pickTop(inBand(cands, bandM(BANDS.widen, scale, targetM)), rng);
  if (!T) {
    const goal = BANDS.turnFallbackFrac * scale * targetM;
    let best = cands[0];
    let bestErr = Math.abs(best.d - goal);
    for (let i = 1; i < cands.length; i++) {
      const e = Math.abs(cands[i].d - goal);
      if (e < bestErr || (e === bestErr && cands[i].cell < best.cell)) {
        best = cands[i];
        bestErr = e;
      }
    }
    T = best;
  }

  const s = rng.bool() ? 1 : -1;
  const midPlusFirst = k === 4 ? rng.bool() : true;

  const A = pickTop(inBandSector(cands, sideB, T.bearing, s, BANDS.sideSector), rng);
  const B = pickTop(inBandSector(cands, sideB, T.bearing, -s, BANDS.sideSector), rng);

  let M1: Candidate | null = null;
  let M2: Candidate | null = null;
  if (k >= 5) {
    M1 = pickTop(inBandSector(cands, midB, T.bearing, s, BANDS.midSector), rng);
    M2 = pickTop(inBandSector(cands, midB, T.bearing, -s, BANDS.midSector), rng);
  } else if (k === 4) {
    // 한쪽만: 무작위로 고른 측이 비면 반대 측 시도
    const first = midPlusFirst ? s : -s;
    let m = pickTop(inBandSector(cands, midB, T.bearing, first, BANDS.midSector), rng);
    let onPlus = midPlusFirst;
    if (!m) {
      m = pickTop(inBandSector(cands, midB, T.bearing, -first, BANDS.midSector), rng);
      onPlus = !midPlusFirst;
    }
    if (onPlus) M1 = m;
    else M2 = m;
  }

  const ordered: Candidate[] = [];
  const kinds: WaypointKind[] = [];
  const add = (c: Candidate | null, kind: WaypointKind): void => {
    if (!c || ordered.some((p) => p.cell === c.cell)) return;
    ordered.push(c);
    kinds.push(kind);
  };
  add(A, "side");
  add(M1, "mid");
  add(T, "turn");
  add(M2, "mid");
  add(B, "side");
  // 모든 선택 카테고리가 실제 방문 정점에 포함되어야 한다.
  const required = new Set(cands.flatMap((c) => c.matchedTags ?? []));
  for (const tag of required) {
    if (ordered.some((c) => c.matchedTags?.includes(tag))) continue;
    const pool = cands.filter((c) => c.matchedTags?.includes(tag) && c.d <= targetM * 0.48);
    add(pickTop(pool, rng), "mid");
  }
  return { ordered, kinds, turn: T };
}
