/**
 * 메인 스레드 전용: CARTO voyager_nolabels @2x 타일 fetch(네트워크만) 와 디코딩(캔버스) 분리.
 * - startTileFetch: 제출 즉시 호출 (패널 축소 애니메이션과 겹침, DOM 작업 없음)
 * - decodeMosaic: 패널이 닫힌 뒤 호출 (drawImage + getImageData 1회)
 * - fetchTerrain: hill/flat 태그일 때만 terrarium z12 2×2
 * 타일 URL은 tileUrl() 한 곳에 격리 (키/프록시 교체 대비).
 */
import { latToWorldY, lngToWorldX } from "./mercator";
import {
  GUARD,
  RouteError,
  type ElevationField,
  type GridPlan,
  type LatLng,
  type Mosaic,
} from "./types";

const SUBDOMAINS = ["a", "b", "c", "d"] as const;
const CARTO_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY;

export function tileUrl(z: number, x: number, y: number, sub = (x + y) & 3, labels = false): string {
  const base = `https://${SUBDOMAINS[sub]}.basemaps.cartocdn.com/rastertiles/${labels ? "voyager" : "voyager_nolabels"}/${z}/${x}/${y}@2x.png`;
  return CARTO_KEY ? `${base}?api_key=${encodeURIComponent(CARTO_KEY)}` : base;
}

export function terrainUrl(z: number, x: number, y: number): string {
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
}

/* ---------- blob LRU 캐시 (키 = URL without api_key) ---------- */

const CACHE_MAX = 64;
const blobCache = new Map<string, Blob>();

function cacheGet(key: string): Blob | undefined {
  const b = blobCache.get(key);
  if (b) {
    blobCache.delete(key);
    blobCache.set(key, b);
  }
  return b;
}

function cachePut(key: string, blob: Blob) {
  blobCache.set(key, blob);
  if (blobCache.size > CACHE_MAX) {
    const oldest = blobCache.keys().next().value;
    if (oldest !== undefined) blobCache.delete(oldest);
  }
}

/* ---------- fetch with manual timeout (AbortSignal.any 미사용) ---------- */

async function fetchBlob(url: string, timeoutMs: number, outer: AbortSignal): Promise<Blob> {
  if (outer.aborted) throw new RouteError("aborted");
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  outer.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), Math.max(200, timeoutMs));
  try {
    const res = await fetch(url, {
      mode: "cors",
      signal: ctrl.signal,
      referrerPolicy: "strict-origin-when-cross-origin",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) throw new Error(`not an image: ${type}`);
    return await res.blob();
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  }
}

export interface TileFetchResult {
  plan: GridPlan;
  /** cols*rows, row-major; null = 결손 */
  blobs: (Blob | null)[];
  missing: Uint8Array;
  urls: string[];
}

/**
 * 타일 fetch. 타일별 3s 타임아웃, 실패 시 다음 서브도메인으로 1회 재시도(남은 예산 내).
 * 결손이 GUARD.maxMissingTiles를 넘거나 원점 타일이 없으면 RouteError('tiles').
 */
export async function startTileFetch(
  plan: GridPlan,
  signal: AbortSignal,
  budgetEndsAt: number,
  labels = false
): Promise<TileFetchResult> {
  const total = plan.cols * plan.rows;
  const blobs: (Blob | null)[] = new Array(total).fill(null);
  const missing = new Uint8Array(total);
  const urls: string[] = new Array(total);

  const tasks: Promise<void>[] = [];
  for (let r = 0; r < plan.rows; r++) {
    for (let c = 0; c < plan.cols; c++) {
      const i = r * plan.cols + c;
      const x = plan.x0 + c;
      const y = plan.y0 + r;
      const sub = (x + y) & 3;
      const key = `${labels ? "l" : "b"}/${plan.z}/${x}/${y}`;
      urls[i] = tileUrl(plan.z, x, y, sub, labels);
      const cached = cacheGet(key);
      if (cached) {
        blobs[i] = cached;
        continue;
      }
      tasks.push(
        (async () => {
          try {
            blobs[i] = await fetchBlob(urls[i], GUARD.tileTimeoutMs, signal);
          } catch (e) {
            if (signal.aborted) throw new RouteError("aborted");
            const remaining = budgetEndsAt - performance.now() - 1500;
            if (remaining < 300) {
              missing[i] = 1;
              return;
            }
            try {
              blobs[i] = await fetchBlob(
                tileUrl(plan.z, x, y, (sub + 1) & 3, labels),
                Math.min(GUARD.tileTimeoutMs, remaining),
                signal
              );
            } catch {
              if (signal.aborted) throw new RouteError("aborted");
              missing[i] = 1;
              return;
            }
          }
          if (blobs[i]) cachePut(key, blobs[i] as Blob);
        })()
      );
    }
  }
  await Promise.all(tasks);
  if (signal.aborted) throw new RouteError("aborted");

  let missingCount = 0;
  for (let i = 0; i < total; i++) missingCount += missing[i];
  const oc = Math.floor(plan.originPx.x / plan.tilePx);
  const or = Math.floor(plan.originPx.y / plan.tilePx);
  const originIdx = or * plan.cols + oc;
  if (missingCount > GUARD.maxMissingTiles || missing[originIdx]) {
    throw new RouteError("tiles", `${missingCount}/${total} tiles missing`);
  }
  return { plan, blobs, missing, urls };
}

/* ---------- 디코딩 ---------- */

async function loadDrawable(blob: Blob): Promise<{ img: CanvasImageSource; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(blob);
    return { img: bmp, release: () => bmp.close?.() };
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    if (typeof img.decode === "function") await img.decode();
    else
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("img load failed"));
      });
  } finally {
    // drawImage 이후 revoke하면 되지만 decode 완료 시점이면 안전하다
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return { img, release: () => {} };
}

/**
 * 타일 blob → 하나의 RGBA 모자이크. 결손 타일은 alpha 0(UNKNOWN)으로 남긴다.
 * 캔버스 오염 시 RouteError('taint').
 */
export async function decodeMosaic(res: TileFetchResult): Promise<Mosaic> {
  const { plan } = res;
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new RouteError("unsupported", "no 2d context");

  const drawables = await Promise.all(
    res.blobs.map((b) => (b ? loadDrawable(b).catch(() => null) : Promise.resolve(null)))
  );
  const missing = res.missing.slice();
  for (let r = 0; r < plan.rows; r++) {
    for (let c = 0; c < plan.cols; c++) {
      const d = drawables[r * plan.cols + c];
      if (!d) {
        missing[r * plan.cols + c] = 1;
        continue;
      }
      ctx.drawImage(d.img, c * plan.tilePx, r * plan.tilePx, plan.tilePx, plan.tilePx);
      d.release();
    }
  }

  let rgba: Uint8ClampedArray;
  try {
    rgba = ctx.getImageData(0, 0, plan.width, plan.height).data;
  } catch (e) {
    canvas.width = canvas.height = 0;
    throw new RouteError("taint", String(e));
  }
  canvas.width = canvas.height = 0;
  const originIdx = Math.floor(plan.originPx.y / plan.tilePx) * plan.cols + Math.floor(plan.originPx.x / plan.tilePx);
  if (missing[originIdx] || missing.reduce((sum, v) => sum + v, 0) > GUARD.maxMissingTiles) {
    throw new RouteError("tiles", "image decode failed");
  }
  return { plan, rgba, missing };
}

/** 좌표가 고정된 모자이크 전체를 PNG 스냅샷으로 만든다. DOM UI/사용자 마커는 포함하지 않는다. */
export function mosaicPng(mosaic: Mosaic): string {
  const canvas = document.createElement("canvas");
  canvas.width = mosaic.plan.width;
  canvas.height = mosaic.plan.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new RouteError("unsupported");
  const img = ctx.createImageData(canvas.width, canvas.height);
  img.data.set(mosaic.rgba);
  ctx.putImageData(img, 0, 0);
  const png = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 0;
  return png;
}

/* ---------- terrarium 고도 ---------- */

const TERRAIN_Z = 12;
const TERRAIN_PX = 256;

export function planTerrainGrid(origin: LatLng): { z: number; x0: number; y0: number; cols: number; rows: number } {
  const wx = lngToWorldX(origin.lng, TERRAIN_Z, TERRAIN_PX) / TERRAIN_PX;
  const wy = latToWorldY(origin.lat, TERRAIN_Z, TERRAIN_PX) / TERRAIN_PX;
  const max = 2 ** TERRAIN_Z - 2;
  return {
    z: TERRAIN_Z,
    x0: Math.min(max, Math.max(0, Math.round(wx) - 1)),
    y0: Math.min(max, Math.max(0, Math.round(wy) - 1)),
    cols: 2,
    rows: 2,
  };
}

/** 실패 시 null (고도는 선택 사항) */
export async function fetchTerrain(
  origin: LatLng,
  signal: AbortSignal,
  budgetEndsAt: number
): Promise<ElevationField | null> {
  const g = planTerrainGrid(origin);
  const width = g.cols * TERRAIN_PX;
  const height = g.rows * TERRAIN_PX;
  const field: ElevationField = {
    z: g.z,
    tilePx: TERRAIN_PX,
    x0: g.x0,
    y0: g.y0,
    width,
    height,
    data: new Float32Array(width * height).fill(NaN),
  };
  try {
    const blobs = await Promise.all(
      Array.from({ length: g.cols * g.rows }, (_, i) => {
        const x = g.x0 + (i % g.cols);
        const y = g.y0 + Math.floor(i / g.cols);
        const key = `t/${g.z}/${x}/${y}`;
        const cached = cacheGet(key);
        if (cached) return Promise.resolve(cached);
        const remaining = budgetEndsAt - performance.now() - 1500;
        return fetchBlob(terrainUrl(g.z, x, y), Math.min(GUARD.tileTimeoutMs, remaining), signal)
          .then((b) => {
            cachePut(key, b);
            return b;
          })
          .catch(() => null);
      })
    );
    if (signal.aborted) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    let any = false;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      if (!b) continue;
      const d = await loadDrawable(b).catch(() => null);
      if (!d) continue;
      ctx.drawImage(d.img, (i % g.cols) * TERRAIN_PX, Math.floor(i / g.cols) * TERRAIN_PX);
      d.release();
      any = true;
    }
    if (!any) return null;
    const rgba = ctx.getImageData(0, 0, width, height).data;
    canvas.width = canvas.height = 0;
    for (let p = 0, i = 0; p < rgba.length; p += 4, i++) {
      field.data[i] =
        rgba[p + 3] < 128 ? NaN : rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
    }
    return field;
  } catch {
    return null;
  }
}
