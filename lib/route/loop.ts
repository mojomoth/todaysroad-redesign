/**
 * 루프 컨트롤러: 밴드 선택(theme.pickWaypoints) → A* 다리(graph.astar) → 기하 정리 → 길이 제어.
 * 길이는 DP 후 폴리라인의 haversine 한 가지만 쓴다(컨트롤러·카드 공용, 셀 옥타일 길이는 legsM 참고용).
 * 워커·Node 공용 — DOM 없음.
 */
import {
  LOOP,
  downsampleFor,
  type Candidate,
  type GridPlan,
  type LatLng,
  type Rng,
  type WalkGrid,
  type WaypointKind,
} from "./types";
import { canvasToLatLng, pathLengthM } from "./mercator";
import { astar, cellPathLengthM, createScratch } from "./graph";
import { pickWaypoints } from "./theme";

export interface LoopResult {
  /** origin → … → origin 셀 열(이음 중복 제거) */
  cells: Int32Array;
  /** 정리된 폴리라인, path[0] = path[last] = origin */
  path: LatLng[];
  /** 실제로 연결된 정점(다리 실패로 버려진 것은 제외) */
  waypoints: { cell: number; kind: WaypointKind }[];
  turnCell: number;
  lengthM: number;
  /** lengthM / targetM */
  ratio: number;
  iterations: number;
  converged: boolean;
  /** 다리별 셀 기하 길이(m) — 디버그용 */
  legsM: number[];
}

export interface BuildLoopArgs {
  cost: Float32Array;
  minCost: number;
  walk: WalkGrid;
  plan: GridPlan;
  cands: Candidate[];
  targetM: number;
  k: number;
  originCell: number;
  rng: Rng;
  timings: Record<string, number>;
}

const DEG = Math.PI / 180;
/** 공선 판정 외적 허용치(px²) — 셀 중심은 격자점이라 직선 구간의 외적은 정확히 0 */
const COLLINEAR_EPS = 1e-6;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

function markUsed(used: Uint8Array, cells: Int32Array): void {
  for (let i = 0; i < cells.length; i++) used[cells[i]] = 1;
}

/** 다리들을 이어 붙이되 이음(앞 다리 끝 = 뒤 다리 시작) 중복은 버린다 */
function concatSegments(segs: Int32Array[], total: number): Int32Array {
  const out = new Int32Array(total);
  let m = 0;
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (m > 0 && out[m - 1] === c) continue;
      out[m++] = c;
    }
  }
  return m === total ? out : out.slice(0, m);
}

/**
 * 길이 제어 컨트롤러(plan §6): scale=1에서 시작, |r−1| ≤ tol 이면 수락,
 * 아니면 밴드 중심만 r^−scaleExp 배(누적 clamp) 로 옮겨 같은 후보·같은 시드 스트림으로 재선택·재연결.
 * 최대 maxIter회, 항상 최적(|r−1| 최소) 보관. 수락 여부 판단은 호출자(LOOP.accept)에서.
 */
export function buildLoop(a: BuildLoopArgs): LoopResult | null {
  const { cost, minCost, walk, plan, cands, targetM, k, originCell, rng, timings } = a;
  const { gw, gh, cellM } = walk;
  const n = gw * gh;
  if (originCell < 0 || originCell >= n || !walk.passable[originCell]) return null;
  if (!(targetM > 0)) return null;

  const down = downsampleFor(plan.z);
  const scratch = createScratch(n);
  const used = new Uint8Array(n);

  let best: LoopResult | null = null;
  let scale = 1;
  let iterations = 0;

  for (let iter = 1; iter <= LOOP.maxIter; iter++) {
    iterations = iter;
    const pick = pickWaypoints(cands, targetM, k, scale, rng);
    if (!pick) break; // 후보 없음

    used.fill(0);
    const segs: Int32Array[] = [];
    const kept: { cell: number; kind: WaypointKind }[] = [];
    const legsM: number[] = [];
    let cur = originCell;
    let totalCells = 0;
    let turnCell = -1;
    let closedLoop = false;

    const t0 = now();
    for (let i = 0; i < pick.ordered.length; i++) {
      const c = pick.ordered[i];
      if (c.cell === cur) continue; // 현재 위치와 같은 셀 → 무의미
      const leg = astar(cost, walk, cur, c.cell, used, minCost, scratch);
      if (!leg) break;
      markUsed(used, leg);
      segs.push(leg);
      legsM.push(cellPathLengthM(leg, gw, cellM));
      totalCells += leg.length;
      kept.push({ cell: c.cell, kind: pick.kinds[i] });
      if (pick.kinds[i] === "turn") turnCell = c.cell;
      cur = c.cell;
    }
    if (kept.length === pick.ordered.length) {
      const back = astar(cost, walk, cur, originCell, used, minCost, scratch);
      if (back) {
        segs.push(back);
        legsM.push(cellPathLengthM(back, gw, cellM));
        totalCells += back.length;
        closedLoop = true;
      }
    }
    timings.astar = (timings.astar ?? 0) + (now() - t0);

    if (!closedLoop) continue; // 정점이 전부 버려졌거나 귀환 실패 → 같은 scale로 재추첨

    const cells = concatSegments(segs, totalCells);
    if (turnCell < 0) turnCell = kept[(kept.length - 1) >> 1].cell; // T가 버려지면 가운데 정점

    // 셀 중심을 그대로 보존한다. DP 지름길과 원점 강제 치환은 장애물을 가로지를 수 있다.
    const xy = cellsToCanvasPoints(cells, gw, down);
    const path = toLatLngPath(xy, plan, plan.origin);
    const lengthM = pathLengthM(path);
    const ratio = lengthM / targetM;
    const err = Math.abs(ratio - 1);

    const res: LoopResult = {
      cells,
      path,
      waypoints: kept,
      turnCell,
      lengthM,
      ratio,
      iterations: iter,
      converged: err <= LOOP.tol,
      legsM,
    };
    if (!best || err < Math.abs(best.ratio - 1)) best = res;
    if (err <= LOOP.tol) break;

    // 밴드 중심 스케일 조정 (r=0 방어)
    const s = scale * Math.pow(ratio > 1e-6 ? ratio : 1e-6, -LOOP.scaleExp);
    scale = s < LOOP.scaleMin ? LOOP.scaleMin : s > LOOP.scaleMax ? LOOP.scaleMax : s;
  }

  if (!best) return null;
  best.iterations = iterations;
  best.converged = Math.abs(best.ratio - 1) <= LOOP.tol;
  return best;
}

/* ---------- 기하 정리 ---------- */

/** 셀 열 → 캔버스 px 좌표쌍(셀 중심), 연속 중복 제거 */
export function cellsToCanvasPoints(cells: Int32Array, gw: number, down: number): Float64Array {
  const half = down / 2;
  const out = new Float64Array(cells.length * 2);
  let m = 0;
  let prev = -1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === prev) continue;
    prev = c;
    const x = c % gw;
    const y = (c - x) / gw;
    out[m++] = x * down + half;
    out[m++] = y * down + half;
  }
  return m === out.length ? out : out.slice(0, m);
}

/** 같은 방향으로 이어지는 공선 중간점 제거(되돌아가는 꼭짓점은 유지). 첫·끝점 보존 */
export function dropCollinear(xy: Float64Array): Float64Array {
  const n = xy.length >> 1;
  if (n <= 2) return xy.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let count = 2;
  let ax = xy[0];
  let ay = xy[1];
  for (let i = 1; i < n - 1; i++) {
    const bx = xy[2 * i];
    const by = xy[2 * i + 1];
    const cx = xy[2 * i + 2];
    const cy = xy[2 * i + 3];
    const ux = bx - ax;
    const uy = by - ay;
    const vx = cx - bx;
    const vy = cy - by;
    const cross = ux * vy - uy * vx;
    const dot = ux * vx + uy * vy;
    if (cross <= COLLINEAR_EPS && cross >= -COLLINEAR_EPS && dot > 0) continue;
    keep[i] = 1;
    count++;
    ax = bx;
    ay = by;
  }
  const out = new Float64Array(count * 2);
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[m++] = xy[2 * i];
    out[m++] = xy[2 * i + 1];
  }
  return out;
}

/** Douglas-Peucker(반복 스택, 선분 거리 기준 — 첫점=끝점인 닫힌 루프도 안전). 첫·끝점 보존 */
export function douglasPeucker(xy: Float64Array, epsPx: number): Float64Array {
  const n = xy.length >> 1;
  if (n <= 2 || !(epsPx > 0)) return xy.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let count = 2;
  const eps2 = epsPx * epsPx;
  const stack: number[] = [0, n - 1];

  while (stack.length > 0) {
    const e = stack.pop() as number;
    const s = stack.pop() as number;
    if (e - s < 2) continue;
    const sx = xy[2 * s];
    const sy = xy[2 * s + 1];
    const ex = xy[2 * e];
    const ey = xy[2 * e + 1];
    const vx = ex - sx;
    const vy = ey - sy;
    const l2 = vx * vx + vy * vy;
    let maxD2 = -1;
    let maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const px = xy[2 * i] - sx;
      const py = xy[2 * i + 1] - sy;
      let d2: number;
      if (l2 === 0) {
        d2 = px * px + py * py;
      } else {
        const t = (px * vx + py * vy) / l2;
        if (t <= 0) {
          d2 = px * px + py * py;
        } else if (t >= 1) {
          const qx = xy[2 * i] - ex;
          const qy = xy[2 * i + 1] - ey;
          d2 = qx * qx + qy * qy;
        } else {
          const c = px * vy - py * vx;
          d2 = (c * c) / l2;
        }
      }
      if (d2 > maxD2) {
        maxD2 = d2;
        maxI = i;
      }
    }
    if (maxD2 > eps2) {
      keep[maxI] = 1;
      count++;
      stack.push(s, maxI, maxI, e);
    }
  }

  const out = new Float64Array(count * 2);
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[m++] = xy[2 * i];
    out[m++] = xy[2 * i + 1];
  }
  return out;
}

/** 캔버스 px → lat/lng. 출발점은 검증된 도로 셀이며 GPS 지점과의 차이는 별도 안내한다. */
export function toLatLngPath(xy: Float64Array, plan: GridPlan, origin: LatLng): LatLng[] {
  const n = xy.length >> 1;
  if (n === 0) return [{ lat: origin.lat, lng: origin.lng }];
  const path: LatLng[] = new Array(n);
  for (let i = 0; i < n; i++) path[i] = canvasToLatLng(plan, xy[2 * i], xy[2 * i + 1]);
  return path;
}

/** p에 가장 가까운 path 점의 인덱스(등장방형 근사), 빈 path → -1 */
export function nearestPathIndex(path: LatLng[], p: LatLng): number {
  const n = path.length;
  if (n === 0) return -1;
  const cosLat = Math.cos(p.lat * DEG);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = (path[i].lng - p.lng) * cosLat;
    const dy = path[i].lat - p.lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
