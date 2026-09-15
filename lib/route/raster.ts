/**
 * 셀 격자(클래스 분율·도로·폭), 형태학, 거리변환, 연결성분 — 순수 typed-array.
 *
 * 격자는 row-major(index = y*gw + x). 셀 좌표 (cx, cy)는 셀 단위 실수이며
 * 캔버스 px = cx*down + down/2 (셀 중심). 마스크는 0/1 Uint8Array.
 * DOM/window 접근 없음(워커·Node 공용).
 */
import {
  Cls,
  NUM_CLS,
  downsampleFor,
  roadCellThreshold,
  type CellGrid,
  type ClsId,
  type Region,
} from "./types";

/* ---------- 도로 클래스 규칙 ---------- */

/** z15+: fill+casing 전부, z14: fill만 (casing이 격자를 덩어리로 만듦). TRUNK는 항상 제외 */
function roadClassTable(z: number): Uint8Array {
  const t = new Uint8Array(NUM_CLS);
  t[Cls.MAJOR] = 1;
  t[Cls.MINOR] = 1;
  t[Cls.PATH] = 1;
  if (z >= 15) {
    t[Cls.SEC_CASE] = 1;
    t[Cls.MINOR_CASE] = 1;
  }
  return t;
}

/* ---------- 셀 격자 ---------- */

/**
 * 픽셀 클래스 → 셀 격자. 단일 픽셀 패스로 분율 카운트와 전해상도 도로 마스크를 동시에 만든다.
 * widthM: 도로 마스크 1px close(dilate→erode 3×3) → chamfer 3-4 DT → 셀별 max → 2·(dt/3)·mpp.
 */
export function buildCellGrid(cls: Uint8Array, w: number, h: number, z: number, mpp: number): CellGrid {
  const down = downsampleFor(z);
  const gw = Math.ceil(w / down);
  const gh = Math.ceil(h / down);
  const cellM = down * mpp;
  const n = gw * gh;
  const np = w * h;
  const roadTab = roadClassTable(z);

  // frac는 먼저 카운트 버퍼로 쓴다 (셀당 최대 down² ≤ 16 → Uint8로 충분)
  const frac = new Uint8Array(n * NUM_CLS);
  const mask = new Uint8Array(np);
  let i = 0;
  for (let y = 0; y < h; y++) {
    let base = ((y / down) | 0) * gw * NUM_CLS;
    let k = down;
    for (let x = 0; x < w; x++, i++) {
      const c = cls[i];
      frac[base + c]++;
      mask[i] = roadTab[c];
      if (--k === 0) {
        k = down;
        base += NUM_CLS;
      }
    }
  }

  // 카운트 → 분율(0..255), 도로 분율, 도로 셀
  const road = new Uint8Array(n);
  const roadCell = new Uint8Array(n);
  const thr = roadCellThreshold(z);
  for (let cy = 0; cy < gh; cy++) {
    const ch = Math.min(down, h - cy * down);
    for (let cx = 0; cx < gw; cx++) {
      const cw = Math.min(down, w - cx * down);
      const inv = 255 / (cw * ch);
      const cell = cy * gw + cx;
      const o = cell * NUM_CLS;
      let roadCnt = 0;
      for (let c = 0; c < NUM_CLS; c++) {
        const cnt = frac[o + c];
        if (roadTab[c] !== 0) roadCnt += cnt;
        frac[o + c] = (cnt * inv + 0.5) | 0;
      }
      const rv = (roadCnt * inv + 0.5) | 0;
      road[cell] = rv;
      roadCell[cell] = rv / 255 >= thr ? 1 : 0;
    }
  }

  // 도로 폭: 전해상도 마스크 close(1px) → DT → 셀 max
  const tmp = new Uint8Array(np);
  const closed = new Uint8Array(np);
  morph3(mask, w, h, true, tmp, closed); // dilate
  morph3(closed, w, h, false, tmp, mask); // erode → mask = closed mask
  const dt = chamferDT(mask, w, h);
  const maxDt = new Uint16Array(n);
  i = 0;
  for (let y = 0; y < h; y++) {
    let cell = ((y / down) | 0) * gw;
    let k = down;
    for (let x = 0; x < w; x++, i++) {
      const d = dt[i];
      if (d > maxDt[cell]) maxDt[cell] = d;
      if (--k === 0) {
        k = down;
        cell++;
      }
    }
  }
  const widthM = new Float32Array(n);
  const wScale = (2 / 3) * mpp;
  for (let c = 0; c < n; c++) widthM[c] = roadCell[c] !== 0 ? maxDt[c] * wScale : 0;

  return { gw, gh, down, cellM, frac, road, roadCell, widthM };
}

/** 주어진 클래스들의 분율 합 ≥ minFrac(기본 0.5)인 셀 = 1 */
export function fracMask(grid: CellGrid, clsIds: readonly number[], minFrac = 0.5): Uint8Array {
  const { gw, gh, frac } = grid;
  const n = gw * gh;
  const out = new Uint8Array(n);
  const m = clsIds.length;
  for (let cell = 0, o = 0; cell < n; cell++, o += NUM_CLS) {
    let sum = 0;
    for (let k = 0; k < m; k++) sum += frac[o + clsIds[k]];
    if (sum / 255 >= minFrac) out[cell] = 1;
  }
  return out;
}

/* ---------- 형태학 (3×3, 분리형, 경계는 범위 내 이웃만) ---------- */

/** 0/1 마스크의 3×3 max(dilate) / min(erode). tmp·dst는 src와 같은 길이 */
function morph3(
  src: Uint8Array,
  gw: number,
  gh: number,
  dilate: boolean,
  tmp: Uint8Array,
  dst: Uint8Array,
): void {
  // 가로
  for (let y = 0; y < gh; y++) {
    const o = y * gw;
    if (gw === 1) {
      tmp[o] = src[o];
      continue;
    }
    const last = o + gw - 1;
    if (dilate) {
      tmp[o] = src[o] | src[o + 1];
      for (let i = o + 1; i < last; i++) tmp[i] = src[i - 1] | src[i] | src[i + 1];
      tmp[last] = src[last - 1] | src[last];
    } else {
      tmp[o] = src[o] & src[o + 1];
      for (let i = o + 1; i < last; i++) tmp[i] = src[i - 1] & src[i] & src[i + 1];
      tmp[last] = src[last - 1] & src[last];
    }
  }
  // 세로
  if (gh === 1) {
    dst.set(tmp.subarray(0, gw));
    return;
  }
  const lastRow = (gh - 1) * gw;
  if (dilate) {
    for (let x = 0; x < gw; x++) dst[x] = tmp[x] | tmp[x + gw];
    for (let y = 1; y < gh - 1; y++) {
      const o = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = o + x;
        dst[i] = tmp[i - gw] | tmp[i] | tmp[i + gw];
      }
    }
    for (let x = 0; x < gw; x++) dst[lastRow + x] = tmp[lastRow - gw + x] | tmp[lastRow + x];
  } else {
    for (let x = 0; x < gw; x++) dst[x] = tmp[x] & tmp[x + gw];
    for (let y = 1; y < gh - 1; y++) {
      const o = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = o + x;
        dst[i] = tmp[i - gw] & tmp[i] & tmp[i + gw];
      }
    }
    for (let x = 0; x < gw; x++) dst[lastRow + x] = tmp[lastRow - gw + x] & tmp[lastRow + x];
  }
}

export function erode3(mask: Uint8Array, gw: number, gh: number): Uint8Array {
  const n = gw * gh;
  const out = new Uint8Array(n);
  if (n === 0) return out;
  morph3(mask, gw, gh, false, new Uint8Array(n), out);
  return out;
}

export function dilate3(mask: Uint8Array, gw: number, gh: number): Uint8Array {
  const n = gw * gh;
  const out = new Uint8Array(n);
  if (n === 0) return out;
  morph3(mask, gw, gh, true, new Uint8Array(n), out);
  return out;
}

/** 열림 = dilate3(erode3) — 작은 점 제거 */
export function open3(mask: Uint8Array, gw: number, gh: number): Uint8Array {
  return dilate3(erode3(mask, gw, gh), gw, gh);
}

/** 닫힘 = erode3(dilate3) — 작은 구멍 메움 */
export function close3(mask: Uint8Array, gw: number, gh: number): Uint8Array {
  return erode3(dilate3(mask, gw, gh), gw, gh);
}

/* ---------- 거리변환 ---------- */

/**
 * 마스크 내부 셀의 chamfer 3-4 거리(가장 가까운 외부 셀까지; 격자 경계도 외부로 간주).
 * 외부 셀은 0. 두 패스, 정수(Uint16; 최대 3·max(gw,gh) ≪ 65535).
 */
export function chamferDT(mask: Uint8Array, gw: number, gh: number): Uint16Array {
  const dt = new Uint16Array(gw * gh);
  if (gw === 0 || gh === 0) return dt;
  const xl = gw - 1;

  // 정방향: 왼쪽·위·좌상·우상. y=0 행은 위가 외부이므로 3
  for (let x = 0; x < gw; x++) if (mask[x] !== 0) dt[x] = 3;
  for (let y = 1; y < gh; y++) {
    const o = y * gw;
    for (let x = 0; x < gw; x++) {
      const i = o + x;
      if (mask[i] === 0) continue;
      let d = x > 0 ? dt[i - 1] + 3 : 3;
      let c = dt[i - gw] + 3;
      if (c < d) d = c;
      c = x > 0 ? dt[i - gw - 1] + 4 : 4;
      if (c < d) d = c;
      c = x < xl ? dt[i - gw + 1] + 4 : 4;
      if (c < d) d = c;
      dt[i] = d;
    }
  }

  // 역방향: 오른쪽·아래·우하·좌하. y=gh-1 행은 아래가 외부이므로 ≤3
  const lastRow = (gh - 1) * gw;
  for (let x = 0; x < gw; x++) {
    const i = lastRow + x;
    if (mask[i] !== 0 && dt[i] > 3) dt[i] = 3;
  }
  for (let y = gh - 2; y >= 0; y--) {
    const o = y * gw;
    for (let x = xl; x >= 0; x--) {
      const i = o + x;
      if (mask[i] === 0) continue;
      let d = dt[i];
      let c = x < xl ? dt[i + 1] + 3 : 3;
      if (c < d) d = c;
      c = dt[i + gw] + 3;
      if (c < d) d = c;
      c = x < xl ? dt[i + gw + 1] + 4 : 4;
      if (c < d) d = c;
      c = x > 0 ? dt[i + gw - 1] + 4 : 4;
      if (c < d) d = c;
      dt[i] = d;
    }
  }
  return dt;
}

/**
 * 모든 셀에 대해 가장 가까운 마스크 셀까지의 거리(m). 마스크 내부 0, 마스크가 비면 전부 Infinity.
 * chamfer 3-4를 미터 가중(cellM, cellM·4/3)으로 직접 수행한다(격자 경계는 전파 없음).
 */
export function distanceToMaskM(mask: Uint8Array, gw: number, gh: number, cellM: number): Float32Array {
  const n = gw * gh;
  const out = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 0) {
      any = true;
      out[i] = 0;
    } else out[i] = Infinity;
  }
  if (!any || n === 0) return out;
  const A = cellM;
  const B = cellM * (4 / 3);
  const xl = gw - 1;

  // 정방향
  for (let y = 0; y < gh; y++) {
    const o = y * gw;
    const up = y > 0;
    for (let x = 0; x < gw; x++) {
      const i = o + x;
      if (mask[i] !== 0) continue;
      let d = out[i];
      let c: number;
      if (x > 0) {
        c = out[i - 1] + A;
        if (c < d) d = c;
      }
      if (up) {
        c = out[i - gw] + A;
        if (c < d) d = c;
        if (x > 0) {
          c = out[i - gw - 1] + B;
          if (c < d) d = c;
        }
        if (x < xl) {
          c = out[i - gw + 1] + B;
          if (c < d) d = c;
        }
      }
      out[i] = d;
    }
  }
  // 역방향
  for (let y = gh - 1; y >= 0; y--) {
    const o = y * gw;
    const dn = y < gh - 1;
    for (let x = xl; x >= 0; x--) {
      const i = o + x;
      if (mask[i] !== 0) continue;
      let d = out[i];
      let c: number;
      if (x < xl) {
        c = out[i + 1] + A;
        if (c < d) d = c;
      }
      if (dn) {
        c = out[i + gw] + A;
        if (c < d) d = c;
        if (x < xl) {
          c = out[i + gw + 1] + B;
          if (c < d) d = c;
        }
        if (x > 0) {
          c = out[i + gw - 1] + B;
          if (c < d) d = c;
        }
      }
      out[i] = d;
    }
  }
  return out;
}

/* ---------- 연결성분 ---------- */

/**
 * 4-연결 성분(반복 BFS, Int32Array 큐). labels: 0 = 없음, 그 외 region.id(1부터).
 * cells < minCells 성분은 버림(라벨 0 유지). pole = 전체 마스크 chamferDT의 성분 내 argmax.
 * touchesWater = 성분의 어떤 셀이 waterMask 셀과 4-인접(waterMask null이면 false).
 */
export function connectedComponents(
  mask: Uint8Array,
  gw: number,
  gh: number,
  cls: ClsId,
  minCells: number,
  cellM: number,
  waterMask: Uint8Array | null,
): { labels: Int32Array; regions: Region[] } {
  const n = gw * gh;
  const labels = new Int32Array(n);
  const regions: Region[] = [];
  if (n === 0) return { labels, regions };

  const dt = chamferDT(mask, gw, gh);
  const queue = new Int32Array(n); // 셀은 정확히 한 번씩 들어가므로 n이면 충분
  const cellArea = cellM * cellM;
  const xl = gw - 1;
  const yl = gh - 1;
  let nextId = 1;

  for (let seed = 0; seed < n; seed++) {
    if (mask[seed] === 0 || labels[seed] !== 0) continue;
    const id = nextId;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    labels[seed] = id;

    let sumX = 0;
    let sumY = 0;
    let minX = gw;
    let minY = gh;
    let maxX = -1;
    let maxY = -1;
    let bestDt = -1;
    let pole = seed;
    let touches = false;

    while (head < tail) {
      const i = queue[head++];
      const y = (i / gw) | 0;
      const x = i - y * gw;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const d = dt[i];
      if (d > bestDt) {
        bestDt = d;
        pole = i;
      }
      // 4-이웃
      if (x > 0) {
        const j = i - 1;
        if (labels[j] === 0 && mask[j] !== 0) {
          labels[j] = id;
          queue[tail++] = j;
        }
        if (waterMask !== null && waterMask[j] !== 0) touches = true;
      }
      if (x < xl) {
        const j = i + 1;
        if (labels[j] === 0 && mask[j] !== 0) {
          labels[j] = id;
          queue[tail++] = j;
        }
        if (waterMask !== null && waterMask[j] !== 0) touches = true;
      }
      if (y > 0) {
        const j = i - gw;
        if (labels[j] === 0 && mask[j] !== 0) {
          labels[j] = id;
          queue[tail++] = j;
        }
        if (waterMask !== null && waterMask[j] !== 0) touches = true;
      }
      if (y < yl) {
        const j = i + gw;
        if (labels[j] === 0 && mask[j] !== 0) {
          labels[j] = id;
          queue[tail++] = j;
        }
        if (waterMask !== null && waterMask[j] !== 0) touches = true;
      }
    }

    const cells = tail;
    if (cells < minCells) {
      // 작은 성분: -1로 표시(재방문 방지), 마지막에 0으로
      for (let m = 0; m < tail; m++) labels[queue[m]] = -1;
      continue;
    }
    const py = (pole / gw) | 0;
    regions.push({
      id,
      cls,
      cells,
      areaM2: cells * cellArea,
      cx: sumX / cells,
      cy: sumY / cells,
      poleX: pole - py * gw,
      poleY: py,
      minX,
      minY,
      maxX,
      maxY,
      touchesWater: touches,
    });
    nextId++;
  }

  for (let i = 0; i < n; i++) if (labels[i] < 0) labels[i] = 0;
  return { labels, regions };
}

/** 물이 아닌 셀 중 물과 4-인접한 셀 인덱스(row-major 오름차순) */
export function shoreCells(waterMask: Uint8Array, gw: number, gh: number): Int32Array {
  const n = gw * gh;
  const xl = gw - 1;
  const yl = gh - 1;
  let count = 0;
  // 1패스: 개수
  for (let y = 0; y < gh; y++) {
    const o = y * gw;
    for (let x = 0; x < gw; x++) {
      const i = o + x;
      if (waterMask[i] !== 0) continue;
      if (
        (x > 0 && waterMask[i - 1] !== 0) ||
        (x < xl && waterMask[i + 1] !== 0) ||
        (y > 0 && waterMask[i - gw] !== 0) ||
        (y < yl && waterMask[i + gw] !== 0)
      )
        count++;
    }
  }
  const out = new Int32Array(count);
  if (count === 0 || n === 0) return out;
  // 2패스: 기록
  let k = 0;
  for (let y = 0; y < gh; y++) {
    const o = y * gw;
    for (let x = 0; x < gw; x++) {
      const i = o + x;
      if (waterMask[i] !== 0) continue;
      if (
        (x > 0 && waterMask[i - 1] !== 0) ||
        (x < xl && waterMask[i + 1] !== 0) ||
        (y > 0 && waterMask[i - gw] !== 0) ||
        (y < yl && waterMask[i + gw] !== 0)
      )
        out[k++] = i;
    }
  }
  return out;
}

/* ---------- 창 통계 ---------- */

/** 클래스별 분율 SAT((gw+1)×(gh+1), Uint32) — 격자당 지연 생성·캐시. grid.frac는 불변으로 가정 */
const satCache = new WeakMap<CellGrid, Map<number, Uint32Array>>();

function classSat(grid: CellGrid, cls: ClsId): Uint32Array {
  let byCls = satCache.get(grid);
  if (!byCls) {
    byCls = new Map();
    satCache.set(grid, byCls);
  }
  const hit = byCls.get(cls);
  if (hit) return hit;
  const { gw, gh, frac } = grid;
  const W = gw + 1;
  const sat = new Uint32Array(W * (gh + 1));
  for (let y = 0; y < gh; y++) {
    const so = (y + 1) * W;
    const po = y * W;
    let rowSum = 0;
    let fo = y * gw * NUM_CLS + cls;
    for (let x = 0; x < gw; x++, fo += NUM_CLS) {
      rowSum += frac[fo];
      sat[so + x + 1] = sat[po + x + 1] + rowSum;
    }
  }
  byCls.set(cls, sat);
  return sat;
}

/** 클램프된 정사각 창 [cx−r, cx+r]×[cy−r, cy+r]의 평균 클래스 분율 0..1 (SAT, O(1)) */
export function boxClassFrac(grid: CellGrid, cls: ClsId, cx: number, cy: number, radiusCells: number): number {
  const { gw, gh } = grid;
  const x0 = Math.max(0, Math.round(cx - radiusCells));
  const x1 = Math.min(gw - 1, Math.round(cx + radiusCells));
  const y0 = Math.max(0, Math.round(cy - radiusCells));
  const y1 = Math.min(gh - 1, Math.round(cy + radiusCells));
  if (x1 < x0 || y1 < y0) return 0;
  const sat = classSat(grid, cls);
  const W = gw + 1;
  const sum = sat[(y1 + 1) * W + x1 + 1] - sat[y0 * W + x1 + 1] - sat[(y1 + 1) * W + x0] + sat[y0 * W + x0];
  return sum / ((x1 - x0 + 1) * (y1 - y0 + 1) * 255);
}

/** 클램프된 정사각 창의 원시값 평균 (창이 비면 0) */
export function boxMean(
  values: Uint8Array | Float32Array,
  gw: number,
  gh: number,
  cx: number,
  cy: number,
  radiusCells: number,
): number {
  const x0 = Math.max(0, Math.round(cx - radiusCells));
  const x1 = Math.min(gw - 1, Math.round(cx + radiusCells));
  const y0 = Math.max(0, Math.round(cy - radiusCells));
  const y1 = Math.min(gh - 1, Math.round(cy + radiusCells));
  if (x1 < x0 || y1 < y0) return 0;
  let sum = 0;
  for (let y = y0; y <= y1; y++) {
    const o = y * gw;
    for (let x = x0; x <= x1; x++) sum += values[o + x];
  }
  return sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
}

/** 셀의 클래스 분율 0..1 */
export function classFracAt(grid: CellGrid, cell: number, cls: ClsId): number {
  return grid.frac[cell * NUM_CLS + cls] / 255;
}
