/**
 * 고도: AWS Terrain Tiles(terrarium, z12 256px) 계획·디코딩·샘플링·오르막 합산.
 * elev = R·256 + G + B/256 − 32768. DOM 접근 없음(RGBA 버퍼만 받는다).
 */
import { haversineM, latToWorldY, lngToWorldX, metresPerPixel } from "./mercator";
import type { CellGrid, ElevationField, GridPlan, LatLng } from "./types";

export const TERRAIN_Z = 12;
export const TERRAIN_TILE_PX = 256;
/** 경사 정규화 상한(m/m): 8% → 1 */
const SLOPE_NORM = 0.08;
/** ascentAlong 리샘플 간격(m)·히스테리시스(m) */
const ASCENT_STEP_M = 30;
const ASCENT_HYST_M = 8;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** z12 2×2 타일: 원점이 공유 모서리에 가장 가깝도록 x0 = round(worldX/256) − 1 (≥0) */
export function planTerrain(origin: LatLng): { z: number; x0: number; y0: number; cols: number; rows: number; tilePx: number } {
  const z = TERRAIN_Z;
  const tilePx = TERRAIN_TILE_PX;
  const maxX0 = 2 ** z - 2; // x0+1 ≤ 2^z − 1
  const tx = lngToWorldX(origin.lng, z, 1); // 타일 단위 실수 = worldX/tilePx
  const ty = latToWorldY(origin.lat, z, 1);
  return {
    z,
    x0: clamp(Math.round(tx) - 1, 0, maxX0),
    y0: clamp(Math.round(ty) - 1, 0, maxX0),
    cols: 2,
    rows: 2,
    tilePx,
  };
}

/** terrarium RGBA → field.data (m). alpha<128(결손) → NaN */
export function decodeTerrarium(rgba: Uint8ClampedArray, field: ElevationField): void {
  const n = field.width * field.height;
  if (field.data.length !== n) field.data = new Float32Array(n);
  const data = field.data;
  const m = Math.min(n, rgba.length >> 2);
  for (let i = 0, p = 0; i < m; i++, p += 4) {
    data[i] = rgba[p + 3] < 128 ? NaN : rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
  }
  for (let i = m; i < n; i++) data[i] = NaN;
}

/**
 * 격자 bilinear. 픽셀 중심 = (i+0.5). 격자 밖 → NaN.
 * NaN 이웃은 가중치에서 제외(전부 NaN이면 NaN).
 */
function bilinear(values: Float32Array, w: number, h: number, px: number, py: number): number {
  if (!(px >= 0 && px < w && py >= 0 && py < h)) return NaN;
  const u = px - 0.5;
  const v = py - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const xa = clamp(x0, 0, w - 1);
  const xb = clamp(x0 + 1, 0, w - 1);
  const ya = clamp(y0, 0, h - 1);
  const yb = clamp(y0 + 1, 0, h - 1);
  let sum = 0;
  let wsum = 0;
  let e = values[ya * w + xa];
  let k = (1 - fx) * (1 - fy);
  if (e === e) { sum += e * k; wsum += k; }
  e = values[ya * w + xb];
  k = fx * (1 - fy);
  if (e === e) { sum += e * k; wsum += k; }
  e = values[yb * w + xa];
  k = (1 - fx) * fy;
  if (e === e) { sum += e * k; wsum += k; }
  e = values[yb * w + xb];
  k = fx * fy;
  if (e === e) { sum += e * k; wsum += k; }
  return wsum > 0 ? sum / wsum : NaN;
}

/** lat/lng → 고도 격자 px (격자 좌상단 기준) */
function fieldPx(field: ElevationField, lat: number, lng: number): { x: number; y: number } {
  return {
    x: lngToWorldX(lng, field.z, field.tilePx) - field.x0 * field.tilePx,
    y: latToWorldY(lat, field.z, field.tilePx) - field.y0 * field.tilePx,
  };
}

/** bilinear 고도(m). 격자 밖·결손 → NaN */
export function elevAt(field: ElevationField, lat: number, lng: number): number {
  const p = fieldPx(field, lat, lng);
  return bilinear(field.data, field.width, field.height, p.x, p.y);
}

/** 도심 SRTM(30 m)은 지붕 높이가 섞여 ±5~9 m 잡음이 있다 → 3×3 NaN-aware 박스 평활 (필드당 1회, 캐시) */
const smoothCache = new WeakMap<ElevationField, ElevationField>();
function smoothed(field: ElevationField): ElevationField {
  const hit = smoothCache.get(field);
  if (hit) return hit;
  const { width: w, height: h, data } = field;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = data[yy * w + xx];
          if (v === v) {
            sum += v;
            cnt++;
          }
        }
      }
      out[y * w + x] = cnt ? sum / cnt : NaN;
    }
  }
  const sf: ElevationField = { ...field, data: out };
  smoothCache.set(field, sf);
  return sf;
}

/** Horn 3×3 경사(m/m). 가장자리는 복제, 이웃에 NaN이 있으면 NaN */
function slopeHorn(field: ElevationField, pxM: number): Float32Array {
  const { width: w, height: h, data } = field;
  const out = new Float32Array(w * h);
  const inv = 1 / (8 * pxM);
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : x;
      const a = data[ym + xm], b = data[ym + x], c = data[ym + xp];
      const d = data[y0 + xm], f = data[y0 + xp];
      const g = data[yp + xm], hh = data[yp + x], i = data[yp + xp];
      const dzdx = (c + 2 * f + i - (a + 2 * d + g)) * inv;
      const dzdy = (g + 2 * hh + i - (a + 2 * b + c)) * inv;
      out[y0 + x] = Math.sqrt(dzdx * dzdx + dzdy * dzdy); // NaN 전파
    }
  }
  return out;
}

/**
 * 셀 중심마다 고도(bilinear)와 정규화 경사 clamp(slope/0.08, 0, 1).
 * 캔버스 px → 고도 격자 px는 두 Web Mercator 전역 px 공간 사이의 선형 배율이라
 * canvasToLatLng 왕복과 동치이면서 삼각함수가 필요 없다. NaN → 0.
 */
export function sampleElevationToCells(rawField: ElevationField, plan: GridPlan, grid: CellGrid): { elevAtCell: Float32Array; slope: Float32Array } {
  const field = smoothed(rawField);
  const { gw, gh, down } = grid;
  const n = gw * gh;
  const elevAtCell = new Float32Array(n);
  const slope = new Float32Array(n);
  const pxM = metresPerPixel(plan.origin.lat, field.z, field.tilePx);
  const sf = slopeHorn(field, pxM);
  const w = field.width;
  const h = field.height;
  const k = (2 ** field.z * field.tilePx) / (2 ** plan.z * plan.tilePx);
  const offX = plan.x0 * plan.tilePx * k - field.x0 * field.tilePx;
  const offY = plan.y0 * plan.tilePx * k - field.y0 * field.tilePx;
  const half = down / 2;
  for (let y = 0; y < gh; y++) {
    const fy = (y * down + half) * k + offY;
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const fx = (x * down + half) * k + offX;
      const e = bilinear(field.data, w, h, fx, fy);
      elevAtCell[row + x] = e;
      const s = bilinear(sf, w, h, fx, fy);
      slope[row + x] = s === s ? clamp(s / SLOPE_NORM, 0, 1) : NaN;
    }
  }
  return { elevAtCell, slope };
}

/**
 * 폴리라인을 30 m 간격으로 리샘플해 고도를 읽고, 3 m 히스테리시스로 상승분만 합산.
 * 마지막 골 이후 누적 상승이 3 m를 넘는 순간 그 상승 전체를 더하고, 이후 계속 오르면 추가;
 * 3 m 넘게 내려가면 새 골. NaN 샘플은 건너뛴다.
 */
export function ascentAlong(path: LatLng[], rawField: ElevationField): number {
  if (path.length === 0) return 0;
  const field = smoothed(rawField);
  let ascent = 0;
  let trough = NaN;
  let peak = NaN;
  let climbing = false;

  const feed = (e: number): void => {
    if (e !== e) return; // NaN
    if (trough !== trough) { trough = e; return; } // 첫 유효 샘플
    if (!climbing) {
      if (e < trough) trough = e;
      else if (e - trough > ASCENT_HYST_M) {
        ascent += e - trough;
        peak = e;
        climbing = true;
      }
    } else if (e > peak) {
      ascent += e - peak;
      peak = e;
    } else if (peak - e > ASCENT_HYST_M) {
      trough = e;
      climbing = false;
    }
  };

  feed(elevAt(field, path[0].lat, path[0].lng));
  let acc = 0; // 현재 세그먼트 시작까지의 누적 거리
  let next = ASCENT_STEP_M; // 다음 샘플의 경로상 거리
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = haversineM(a, b);
    if (!(len > 0)) continue;
    while (next <= acc + len) {
      const t = (next - acc) / len;
      feed(elevAt(field, a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t));
      next += ASCENT_STEP_M;
    }
    acc += len;
  }
  if (path.length > 1) {
    const last = path[path.length - 1];
    feed(elevAt(field, last.lat, last.lng));
  }
  return ascent;
}
