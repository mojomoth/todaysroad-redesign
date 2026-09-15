/**
 * Web Mercator 타일/픽셀 수학과 타일 격자 계획.
 * 검증 앵커: 원점 (37.5485, 126.9335) → z16 타일 55875/25383, 0.947 m/px(@2x).
 */
import {
  MAX_TILES_PER_SIDE,
  TILE_PX,
  WINDOW_HALF_FACTOR,
  ZOOM_BY_MINUTES,
  loopRadiusM,
  type GridPlan,
  type LatLng,
  type Minutes,
} from "./types";

const DEG = Math.PI / 180;

export function lngToWorldX(lng: number, z: number, tilePx: number): number {
  return ((lng + 180) / 360) * 2 ** z * tilePx;
}

export function latToWorldY(lat: number, z: number, tilePx: number): number {
  const s = Math.sin(lat * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z * tilePx;
}

export function worldXToLng(x: number, z: number, tilePx: number): number {
  return (x / (2 ** z * tilePx)) * 360 - 180;
}

export function worldYToLat(y: number, z: number, tilePx: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (2 ** z * tilePx);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** m / px (256px 타일 기준 156543.03…·cos(lat)/2^z, 타일 크기로 보정) */
export function metresPerPixel(lat: number, z: number, tilePx: number): number {
  return ((156543.03392804097 * Math.cos(lat * DEG)) / 2 ** z) * (256 / tilePx);
}

export function tileFor(lat: number, lng: number, z: number): { x: number; y: number } {
  return {
    x: Math.floor(lngToWorldX(lng, z, 1)),
    y: Math.floor(latToWorldY(lat, z, 1)),
  };
}

/**
 * origin ± WINDOW_HALF_FACTOR·R 을 덮는 정확한 타일 범위.
 * 한 변이 MAX_TILES_PER_SIDE를 넘으면 원점에서 먼 쪽 열/행을 버린다.
 */
export function planGrid(origin: LatLng, minutes: Minutes, tilePx: number = TILE_PX): GridPlan {
  const z = ZOOM_BY_MINUTES[minutes];
  const mpp = metresPerPixel(origin.lat, z, tilePx);
  const windowHalfM = WINDOW_HALF_FACTOR * loopRadiusM(minutes);
  const halfPx = windowHalfM / mpp;
  const wx = lngToWorldX(origin.lng, z, tilePx);
  const wy = latToWorldY(origin.lat, z, tilePx);
  const maxIndex = 2 ** z - 1;

  let x0 = Math.max(0, Math.floor((wx - halfPx) / tilePx));
  let x1 = Math.min(maxIndex, Math.floor((wx + halfPx) / tilePx));
  let y0 = Math.max(0, Math.floor((wy - halfPx) / tilePx));
  let y1 = Math.min(maxIndex, Math.floor((wy + halfPx) / tilePx));

  while (x1 - x0 + 1 > MAX_TILES_PER_SIDE) {
    const left = wx - x0 * tilePx;
    const right = (x1 + 1) * tilePx - wx;
    if (left > right) x0++;
    else x1--;
  }
  while (y1 - y0 + 1 > MAX_TILES_PER_SIDE) {
    const top = wy - y0 * tilePx;
    const bottom = (y1 + 1) * tilePx - wy;
    if (top > bottom) y0++;
    else y1--;
  }

  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  return {
    z,
    tilePx,
    x0,
    y0,
    cols,
    rows,
    width: cols * tilePx,
    height: rows * tilePx,
    mpp,
    origin,
    originPx: { x: wx - x0 * tilePx, y: wy - y0 * tilePx },
    windowHalfM,
  };
}

export function canvasToLatLng(plan: GridPlan, px: number, py: number): LatLng {
  return {
    lat: worldYToLat(plan.y0 * plan.tilePx + py, plan.z, plan.tilePx),
    lng: worldXToLng(plan.x0 * plan.tilePx + px, plan.z, plan.tilePx),
  };
}

export function latLngToCanvas(plan: GridPlan, p: LatLng): { x: number; y: number } {
  return {
    x: lngToWorldX(p.lng, plan.z, plan.tilePx) - plan.x0 * plan.tilePx,
    y: latToWorldY(p.lat, plan.z, plan.tilePx) - plan.y0 * plan.tilePx,
  };
}

const EARTH_R = 6371008.8;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function pathLengthM(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineM(path[i - 1], path[i]);
  return total;
}
