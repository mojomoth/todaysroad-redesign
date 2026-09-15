/**
 * 셀 8-연결 암시 그래프: 통행 격자 → 셀 특징 → 테마 비용 → Dijkstra(기하 거리) / A*(테마 비용).
 * 워커·Node 공용 — DOM 없음, 타입드 배열만. 셀 인덱스 = y*gw + x.
 */
import {
  Cls,
  COST,
  NUM_CLS,
  WalkKind,
  type CellFeatures,
  type CellGrid,
  type Region,
  type ThemeCostWeights,
  type WalkGrid,
} from "./types";
import { distanceToMaskM } from "./raster";

/** 8-이웃 오프셋과 길이(셀 단위) */
const DX = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1]);
const DY = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1]);
const DLEN = new Float64Array([Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2]);

/** TRUNK 분율이 이 이상이면 셀 전체를 TRUNK(통행 제외)로 본다 */
const TRUNK_FRAC_MIN = 0.15;
/** 특징 거리 스케일(m) */
const NEAR_GREEN_M = 60;
const NEAR_WATER_M = 120;
/** thin: z16+ 는 MINOR 폭 중앙값의 1.2배 이하, z15- 는 2셀 내 2차/주요 도로 없음 */
const THIN_WIDTH_FACTOR = 1.2;
const THIN_NEIGHBOUR_CELLS = 2;

/* ---------- 통행 격자 ---------- */

export function buildWalkGrid(
  grid: CellGrid,
  z: number,
  greenLabels: Int32Array,
  greenRegions: Region[],
): WalkGrid {
  void z; // 규칙은 줌에 의존하지 않음(시그니처 유지)
  const { gw, gh, frac, roadCell } = grid;
  const n = gw * gh;

  // 자연물은 목적지 후보일 뿐 통행면이 아니다. 이미지에 보이는 길만 연결한다.
  void greenLabels;
  void greenRegions;

  const kind = new Uint8Array(n);
  const walkable = new Uint8Array(n);
  const passable = new Uint8Array(n);
  const trunkMin = TRUNK_FRAC_MIN * 255;

  for (let i = 0; i < n; i++) {
    const o = i * NUM_CLS;
    let k: number = WalkKind.NONE;
    if (frac[o + Cls.TRUNK] >= trunkMin) {
      k = WalkKind.TRUNK;
    } else if (roadCell[i]) {
      if (frac[o + Cls.MAJOR] > 0) k = WalkKind.MAJOR;
      else if (frac[o + Cls.SEC_CASE] > 0) k = WalkKind.SECONDARY;
      else if (frac[o + Cls.PATH] > frac[o + Cls.MINOR]) k = WalkKind.PATH;
      else k = WalkKind.MINOR;
    }
    kind[i] = k;
    if (k !== WalkKind.NONE && k !== WalkKind.TRUNK) {
      passable[i] = 1;
      walkable[i] = 1;
    }
  }

  return { gw, gh, cellM: grid.cellM, kind, walkable, passable, widthM: grid.widthM };
}

/* ---------- 셀 특징 ---------- */

export function computeCellFeatures(
  grid: CellGrid,
  walk: WalkGrid,
  greenMask: Uint8Array,
  waterMask: Uint8Array,
  slope: Float32Array | null,
  z: number,
): CellFeatures {
  void grid; // 특징은 통행 격자(kind/widthM)만으로 계산
  const { gw, gh, cellM, kind, widthM } = walk;
  const n = gw * gh;

  const nearGreen = new Float32Array(n);
  const nearWater = new Float32Array(n);
  const dG = distanceToMaskM(greenMask, gw, gh, cellM);
  const dW = distanceToMaskM(waterMask, gw, gh, cellM);
  for (let i = 0; i < n; i++) {
    const g = 1 - dG[i] / NEAR_GREEN_M; // Infinity → -Infinity → 0
    nearGreen[i] = g >= 1 ? 1 : g > 0 ? g : 0;
    const w = 1 - dW[i] / NEAR_WATER_M;
    nearWater[i] = w >= 1 ? 1 : w > 0 ? w : 0;
  }

  const slopeOut = new Float32Array(n);
  if (slope?.length === n) for (let i = 0; i < n; i++) slopeOut[i] = Number.isFinite(slope[i]) ? slope[i] : 0;

  const thin = new Uint8Array(n);
  let widthRule = false;
  let median = 0;
  if (z >= 16) {
    let cnt = 0;
    for (let i = 0; i < n; i++) if (kind[i] === WalkKind.MINOR) cnt++;
    if (cnt > 0) {
      const ws = new Float32Array(cnt);
      let m = 0;
      for (let i = 0; i < n; i++) if (kind[i] === WalkKind.MINOR) ws[m++] = widthM[i];
      ws.sort();
      median = cnt & 1 ? ws[cnt >> 1] : (ws[(cnt >> 1) - 1] + ws[cnt >> 1]) / 2;
      widthRule = median > 0; // 폭 정보가 없으면(전부 0) 이웃 규칙으로 폴백
    }
  }

  if (widthRule) {
    const thr = THIN_WIDTH_FACTOR * median;
    for (let i = 0; i < n; i++) if (kind[i] === WalkKind.MINOR && widthM[i] <= thr) thin[i] = 1;
  } else {
    const r = THIN_NEIGHBOUR_CELLS;
    for (let y = 0; y < gh; y++) {
      const y0 = y - r < 0 ? 0 : y - r;
      const y1 = y + r >= gh ? gh - 1 : y + r;
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (kind[i] !== WalkKind.MINOR) continue;
        const x0 = x - r < 0 ? 0 : x - r;
        const x1 = x + r >= gw ? gw - 1 : x + r;
        let big = false;
        for (let yy = y0; yy <= y1 && !big; yy++) {
          const row = yy * gw;
          for (let xx = x0; xx <= x1; xx++) {
            const kk = kind[row + xx];
            if (kk === WalkKind.SECONDARY || kk === WalkKind.MAJOR) {
              big = true;
              break;
            }
          }
        }
        if (!big) thin[i] = 1;
      }
    }
  }

  return { nearGreen, nearWater, slope: slopeOut, thin };
}

/* ---------- 테마 비용 ---------- */

export function buildCostGrid(
  walk: WalkGrid,
  feats: CellFeatures,
  weights: ThemeCostWeights,
): { cost: Float32Array; minCost: number } {
  const { gw, gh, kind, passable } = walk;
  const n = gw * gh;
  const cost = new Float32Array(n).fill(Infinity);

  // kind → 기본 비용(m당)
  const base = new Float32Array(7);
  base[WalkKind.NONE] = Infinity;
  base[WalkKind.MINOR] = COST.minor;
  base[WalkKind.SECONDARY] = COST.secondary;
  base[WalkKind.MAJOR] = COST.major;
  base[WalkKind.PATH] = COST.path;
  base[WalkKind.TRUNK] = COST.trunk;
  base[WalkKind.PARK] = COST.park;

  const wg = weights.nearGreen;
  const ww = weights.nearWater;
  const wMaj = weights.major;
  const wSec = weights.secondary;
  const wThin = weights.thin;
  const wSl = weights.slope;
  const anyW = wg !== 0 || ww !== 0 || wMaj !== 0 || wSec !== 0 || wThin !== 0 || wSl !== 0;
  const { nearGreen, nearWater, thin, slope } = feats;
  const lo = COST.themeMin;
  const hi = COST.themeMax;

  let minCost = Infinity;
  for (let i = 0; i < n; i++) {
    if (!passable[i]) continue;
    const k = kind[i];
    let c: number;
    if (k === WalkKind.TRUNK) {
      c = COST.trunk; // 횡단 전용, 테마 배수 없음
    } else if (anyW) {
      let e = wg * nearGreen[i] + ww * nearWater[i] + wThin * thin[i] + wSl * slope[i];
      if (k === WalkKind.MAJOR) e += wMaj;
      else if (k === WalkKind.SECONDARY) e += wSec;
      let mult = Math.exp(e);
      if (mult < lo) mult = lo;
      else if (mult > hi) mult = hi;
      c = base[k] * mult;
    } else {
      c = base[k];
    }
    cost[i] = c;
    const s = cost[i]; // float32 반올림 후 값으로 최소 비용을 잡아 휴리스틱 admissible 보장
    if (s < minCost) minCost = s;
  }
  if (!Number.isFinite(minCost)) minCost = 0; // 통행 셀 없음 → 휴리스틱 0(순수 Dijkstra)

  return { cost, minCost };
}

/* ---------- 최소 힙 (Int32 idx + Float32 key, lazy delete) ---------- */

export class MinHeap {
  private idx: Int32Array;
  private key: Float32Array;
  private n = 0;

  constructor(capacity: number) {
    const c = Math.max(16, capacity | 0);
    this.idx = new Int32Array(c);
    this.key = new Float32Array(c);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  push(idx: number, key: number): void {
    if (this.n === this.idx.length) this.grow();
    const ids = this.idx;
    const ks = this.key;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= key) break;
      ids[i] = ids[p];
      ks[i] = ks[p];
      i = p;
    }
    ids[i] = idx;
    ks[i] = key;
  }

  /** 최소 key의 idx, 비어 있으면 -1 */
  pop(): number {
    const n = this.n;
    if (n === 0) return -1;
    const ids = this.idx;
    const ks = this.key;
    const top = ids[0];
    const last = n - 1;
    this.n = last;
    if (last > 0) {
      const li = ids[last];
      const lk = ks[last];
      let i = 0;
      const half = last >> 1;
      while (i < half) {
        let c = 2 * i + 1;
        let ck = ks[c];
        const r = c + 1;
        if (r < last && ks[r] < ck) {
          c = r;
          ck = ks[r];
        }
        if (lk <= ck) break;
        ids[i] = ids[c];
        ks[i] = ck;
        i = c;
      }
      ids[i] = li;
      ks[i] = lk;
    }
    return top;
  }

  private grow(): void {
    const cap = this.idx.length * 2;
    const ni = new Int32Array(cap);
    const nk = new Float32Array(cap);
    ni.set(this.idx);
    nk.set(this.key);
    this.idx = ni;
    this.key = nk;
  }
}

/* ---------- Dijkstra: 기하 거리(m), 통행(TRUNK 제외) 셀만 ---------- */

export function dijkstraMetres(walk: WalkGrid, src: number): Float32Array {
  const { gw, gh, cellM, walkable } = walk;
  const n = gw * gh;
  const dist = new Float32Array(n).fill(Infinity);
  if (src < 0 || src >= n || !walkable[src]) return dist;

  const closed = new Uint8Array(n);
  const heap = new MinHeap(Math.min(1 << 16, Math.max(1024, n >> 4)));
  dist[src] = 0;
  heap.push(src, 0);

  for (;;) {
    const u = heap.pop();
    if (u < 0) break;
    if (closed[u]) continue;
    closed[u] = 1;
    const ux = u % gw;
    const uy = (u - ux) / gw;
    const du = dist[u];
    for (let k = 0; k < 8; k++) {
      const vx = ux + DX[k];
      if (vx < 0 || vx >= gw) continue;
      const vy = uy + DY[k];
      if (vy < 0 || vy >= gh) continue;
      const v = vy * gw + vx;
      if (!walkable[v] || closed[v]) continue;
      if (DX[k] && DY[k] && (!walkable[uy * gw + vx] || !walkable[vy * gw + ux])) continue;
      const nd = du + DLEN[k] * cellM;
      if (nd < dist[v]) {
        dist[v] = nd;
        heap.push(v, nd);
      }
    }
  }
  return dist;
}

/* ---------- 가장 가까운 통행 셀 (정사각 링 확장) ---------- */

export function nearestWalkable(walk: WalkGrid, cx: number, cy: number, maxCells: number): number {
  const { gw, gh, walkable } = walk;
  if (gw <= 0 || gh <= 0) return -1;
  let x0 = Math.round(cx);
  let y0 = Math.round(cy);
  if (x0 < 0) x0 = 0;
  else if (x0 >= gw) x0 = gw - 1;
  if (y0 < 0) y0 = 0;
  else if (y0 >= gh) y0 = gh - 1;
  if (walkable[y0 * gw + x0]) return y0 * gw + x0;

  const rMax = Math.max(0, Math.floor(maxCells));
  for (let r = 1; r <= rMax; r++) {
    const xmin = x0 - r;
    const xmax = x0 + r;
    const ymin = y0 - r;
    const ymax = y0 + r;
    if (xmin < 0 && ymin < 0 && xmax >= gw && ymax >= gh) break; // 링이 격자 밖
    let best = -1;
    let bestD = Infinity;
    const xa = xmin < 0 ? 0 : xmin;
    const xb = xmax >= gw ? gw - 1 : xmax;
    // 위·아래 변
    for (let x = xa; x <= xb; x++) {
      const ddx = x - cx;
      if (ymin >= 0) {
        const i = ymin * gw + x;
        if (walkable[i]) {
          const ddy = ymin - cy;
          const d = ddx * ddx + ddy * ddy;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (ymax < gh) {
        const i = ymax * gw + x;
        if (walkable[i]) {
          const ddy = ymax - cy;
          const d = ddx * ddx + ddy * ddy;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    // 좌·우 변(모서리 제외)
    const ya = ymin + 1 < 0 ? 0 : ymin + 1;
    const yb = ymax - 1 >= gh ? gh - 1 : ymax - 1;
    for (let y = ya; y <= yb; y++) {
      const ddy = y - cy;
      if (xmin >= 0) {
        const i = y * gw + xmin;
        if (walkable[i]) {
          const ddx = xmin - cx;
          const d = ddx * ddx + ddy * ddy;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (xmax < gw) {
        const i = y * gw + xmax;
        if (walkable[i]) {
          const ddx = xmax - cx;
          const d = ddx * ddx + ddy * ddy;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/* ---------- A* (stamp 기반 스크래치 재사용) ---------- */

export interface AStarScratch {
  g: Float32Array;
  prev: Int32Array;
  stamp: Int32Array;
  closed: Int32Array;
  heap: MinHeap;
  run: number;
}

export function createScratch(n: number): AStarScratch {
  return {
    g: new Float32Array(n),
    prev: new Int32Array(n),
    stamp: new Int32Array(n),
    closed: new Int32Array(n),
    heap: new MinHeap(Math.min(1 << 16, Math.max(1024, n >> 4))),
    run: 0,
  };
}

/**
 * 통행(passable, TRUNK 제외) 셀 위 8-연결 A*.
 * edge = len·cellM·(cost[u]+cost[v])/2; used 셀(src/dst 1셀 이내 제외)은 m당 비용 ×reuse, 상한 reuseCap
 * (단 원래 비용보다 낮아지지는 않음 — TRUNK 15/m 보호). 휴리스틱 = euclid·cellM·minCost (admissible·consistent).
 * 반환: src..dst 포함 셀 인덱스, 실패 시 null.
 */
export function astar(
  cost: Float32Array,
  walk: WalkGrid,
  src: number,
  dst: number,
  used: Uint8Array | null,
  minCost: number,
  scratch: AStarScratch,
): Int32Array | null {
  const { gw, gh, cellM, passable } = walk;
  const n = gw * gh;
  if (src < 0 || src >= n || dst < 0 || dst >= n) return null;
  if (!passable[src] || !passable[dst]) return null;
  if (src === dst) {
    const one = new Int32Array(1);
    one[0] = src;
    return one;
  }

  if (scratch.run >= 0x7ffffff0) {
    scratch.stamp.fill(0);
    scratch.closed.fill(0);
    scratch.run = 0;
  }
  const run = ++scratch.run;
  const { g, prev, stamp, closed, heap } = scratch;
  heap.clear();

  const sx = src % gw;
  const sy = (src - sx) / gw;
  const dx = dst % gw;
  const dy = (dst - dx) / gw;
  const hScale = Number.isFinite(minCost) && minCost > 0 ? cellM * minCost : 0;
  const reuse = COST.reuse;
  const reuseCap = COST.reuseCap;

  g[src] = 0;
  stamp[src] = run;
  prev[src] = -1;
  {
    const ex = sx - dx;
    const ey = sy - dy;
    heap.push(src, Math.sqrt(ex * ex + ey * ey) * hScale);
  }

  let found = false;
  for (;;) {
    const u = heap.pop();
    if (u < 0) break;
    if (closed[u] === run) continue; // lazy delete
    closed[u] = run;
    if (u === dst) {
      found = true;
      break;
    }
    const ux = u % gw;
    const uy = (u - ux) / gw;
    const gu = g[u];
    const cu = cost[u];

    for (let k = 0; k < 8; k++) {
      const vx = ux + DX[k];
      if (vx < 0 || vx >= gw) continue;
      const vy = uy + DY[k];
      if (vy < 0 || vy >= gh) continue;
      const v = vy * gw + vx;
      if (!passable[v] || closed[v] === run) continue;
      if (DX[k] && DY[k] && (!passable[uy * gw + vx] || !passable[vy * gw + ux])) continue;

      let pm = (cu + cost[v]) * 0.5;
      if (used !== null && used[v] !== 0) {
        const ax = vx - sx;
        const ay = vy - sy;
        const bx = vx - dx;
        const by = vy - dy;
        const nearSrc = ax <= 1 && ax >= -1 && ay <= 1 && ay >= -1;
        const nearDst = bx <= 1 && bx >= -1 && by <= 1 && by >= -1;
        if (!nearSrc && !nearDst) {
          const p = pm * reuse;
          pm = p > reuseCap ? (reuseCap > pm ? reuseCap : pm) : p;
        }
      }
      const ng = gu + DLEN[k] * cellM * pm;
      if (stamp[v] !== run || ng < g[v]) {
        g[v] = ng;
        stamp[v] = run;
        prev[v] = u;
        const ex = vx - dx;
        const ey = vy - dy;
        heap.push(v, ng + Math.sqrt(ex * ex + ey * ey) * hScale);
      }
    }
  }
  if (!found) return null;

  let len = 0;
  for (let c = dst; c !== -1; c = prev[c]) len++;
  const out = new Int32Array(len);
  let i = len - 1;
  for (let c = dst; c !== -1; c = prev[c]) out[i--] = c;
  return out;
}

/** 연속 셀 열의 기하 길이(m): 인접은 1/√2, 비인접 이음은 유클리드 */
export function cellPathLengthM(cells: Int32Array, gw: number, cellM: number): number {
  const n = cells.length;
  if (n < 2) return 0;
  let total = 0;
  let px = cells[0] % gw;
  let py = (cells[0] - px) / gw;
  for (let i = 1; i < n; i++) {
    const c = cells[i];
    const x = c % gw;
    const y = (c - x) / gw;
    const ddx = x - px;
    const ddy = y - py;
    total += Math.sqrt(ddx * ddx + ddy * ddy);
    px = x;
    py = y;
  }
  return total * cellM;
}
