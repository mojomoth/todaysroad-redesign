/**
 * 한 번의 생성을 순수하게 조립한다 (DOM·fetch 없음; 워커·메인 스레드·개발 페이지 공용).
 *
 *   classify → 가드 → 셀 격자 → 마스크 → CCL/pole → 통행 격자·특징 → 원점 스냅
 *   → 도로거리장 → 후보/점수 → 테마 비용 → 루프(밴드 선택 + A* + 길이 제어) → 기하 → 사실(facts)
 */
import { ascentAlong, sampleElevationToCells } from "./elevation";
import {
  buildCostGrid,
  buildWalkGrid,
  computeCellFeatures,
  dijkstraMetres,
  nearestWalkable,
} from "./graph";
import { buildLoop, nearestPathIndex } from "./loop";
import { canvasToLatLng, haversineM } from "./mercator";
import { buildLut, classify, classifiedFraction, topUnknownColors } from "./palette";
import { buildCellGrid, close3, connectedComponents, fracMask, open3 } from "./raster";
import { createRng } from "./rng";
import { filterCandidates } from "./strategy";
import { collectCandidates, scoreCandidates, themeCostWeights, type ElevInput } from "./theme";
import {
  Cls,
  GUARD,
  K_BY_MINUTES,
  LOOP,
  REGION,
  RouteError,
  WalkKind,
  targetMetres,
  type Candidate,
  type CellFeatures,
  type CellGrid,
  type ElevationField,
  type LatLng,
  type Phase,
  type PipelineInput,
  type Region,
  type RouteResult,
  type WalkGrid,
  type Waypoint,
  type MapElement,
  type RouteStrategy,
} from "./types";

/** 개발 페이지용 중간 산출물 */
export interface PipelineDebug {
  cls: Uint8Array;
  w: number;
  h: number;
  grid: CellGrid;
  walk: WalkGrid;
  feats: CellFeatures;
  greenLabels: Int32Array;
  regions: Region[];
  dist: Float32Array;
  originCell: number;
  cands: Candidate[];
  loopCells: Int32Array | null;
  unknownColors: { hex: string; share: number }[];
  cost: Float32Array;
  elements: MapElement[];
  strategy: RouteStrategy;
}

export interface PipelineHooks {
  onPhase?: (p: Phase) => void;
  onDebug?: (d: PipelineDebug) => void;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function runPipeline(
  input: PipelineInput,
  rgba: Uint8ClampedArray,
  missing: Uint8Array,
  elev: ElevationField | null,
  onPhase?: ((p: Phase) => void) | PipelineHooks
): RouteResult {
  const hooks: PipelineHooks = typeof onPhase === "function" ? { onPhase } : (onPhase ?? {});
  const timings: Record<string, number> = {};
  const tStart = now();
  let t = tStart;
  const lap = (key: string) => {
    const n = now();
    timings[key] = Math.round((n - t) * 10) / 10;
    t = n;
  };

  const { plan, minutes, tags, seed } = input;
  const { width: w, height: h, z, mpp } = plan;
  const n = w * h;

  /* 1. 픽셀 분류 + 빈 이미지 가드 (결손 타일 픽셀은 분모에서 제외) */
  const lut = buildLut(z);
  const cls = new Uint8Array(n);
  const counts = classify(rgba, n, lut, cls);
  let missingTiles = 0;
  for (let i = 0; i < missing.length; i++) missingTiles += missing[i];
  const missingPx = missingTiles * plan.tilePx * plan.tilePx;
  const denom = Math.max(1, n - missingPx);
  const unknownEff = Math.max(0, counts[Cls.UNKNOWN] - missingPx);
  const classified = 1 - unknownEff / denom;
  lap("classify");
  if (classified < GUARD.minClassified) {
    throw new RouteError("blank", `classified ${(classified * 100).toFixed(1)}%`);
  }
  void classifiedFraction;

  /* 2. 셀 격자 */
  const grid = buildCellGrid(cls, w, h, z, mpp);
  const { gw, gh, cellM, down } = grid;
  lap("cellGrid");

  /* 3. 마스크 (셀 > 6 m 에서는 open 생략 — 선형 녹지 보존) */
  const clean = (m: Uint8Array) => (cellM > 6 ? close3(m, gw, gh) : close3(open3(m, gw, gh), gw, gh));
  const greenMask = clean(fracMask(grid, [Cls.GREEN]));
  const waterMask0 = clean(fracMask(grid, [Cls.WATER]));
  const builtCls = z >= 15 ? Cls.BUILT : Cls.URBAN;
  const builtMask = clean(fracMask(grid, [builtCls]));
  lap("masks");

  /* 4. 연결 성분 (물은 작은 웅덩이 제거 후 마스크 재구성) */
  const cellArea = cellM * cellM;
  const waterCC = connectedComponents(
    waterMask0,
    gw,
    gh,
    Cls.WATER,
    Math.max(1, Math.round(REGION.waterMinM2 / cellArea)),
    cellM,
    null
  );
  const waterMask = new Uint8Array(gw * gh);
  for (let i = 0; i < waterMask.length; i++) waterMask[i] = waterCC.labels[i] > 0 ? 1 : 0;
  const greenCC = connectedComponents(
    greenMask,
    gw,
    gh,
    Cls.GREEN,
    Math.max(1, Math.round(REGION.greenMinM2 / cellArea)),
    cellM,
    waterMask
  );
  const builtCC = connectedComponents(
    builtMask,
    gw,
    gh,
    builtCls,
    Math.max(2, Math.round(REGION.waterMinM2 / cellArea)),
    cellM,
    null
  );
  lap("regions");

  /* 5. 통행 격자 · 고도 · 셀 특징 */
  const walk = buildWalkGrid(grid, z, greenCC.labels, greenCC.regions);
  let elevIn: ElevInput = { elevAtCell: null, slope: null };
  if (elev) {
    const s = sampleElevationToCells(elev, plan, grid);
    elevIn = { elevAtCell: s.elevAtCell, slope: s.slope };
  }
  const feats = computeCellFeatures(grid, walk, greenMask, waterMask, elevIn.slope, z);
  lap("walkGrid");

  /* 6. 원점 스냅 */
  const ox = plan.originPx.x / down;
  const oy = plan.originPx.y / down;
  const originCell = nearestWalkable(walk, ox, oy, Math.ceil(GUARD.snapMaxM / cellM));
  if (originCell < 0) throw new RouteError("no-road", "no walkable cell near origin");

  /* 7. 도로거리장 + 도달 가능성 가드 */
  const dist = dijkstraMetres(walk, originCell);
  let walkableCount = 0;
  let reach = 0;
  for (let i = 0; i < dist.length; i++) {
    if (walk.walkable[i]) {
      walkableCount++;
      if (dist[i] < Infinity) reach++;
    }
  }
  const unreachableRoadShare = walkableCount ? 1 - reach / walkableCount : 1;
  lap("dijkstra");
  if (reach < GUARD.minReachableFrac * gw * gh * 0.2) {
    // 통행 셀은 격자의 20~30%가 보통이므로 '격자 5%'의 절반 수준(1%)을 하한으로 둔다
    throw new RouteError("no-road", `reachable cells ${reach}`);
  }

  /* 8. 후보 정점 + 테마 점수 */
  hooks.onPhase?.("strategy");
  const regions = [...greenCC.regions, ...builtCC.regions];
  const allCandidates = collectCandidates({
    grid,
    walk,
    plan,
    regions,
    greenLabels: greenCC.labels,
    waterMask,
    dist,
    originCell,
    tags,
    elev: elevIn,
    feats,
    elements: input.elements,
  });
  hooks.onPhase?.("filtering");
  const { candidates: cands, strategy } = filterCandidates(allCandidates, tags);
  scoreCandidates(cands, tags);
  lap("candidates");
  const { cost, minCost } = buildCostGrid(walk, feats, themeCostWeights(tags));
  lap("costGrid");
  const debugBase = {
    cls,
    w,
    h,
    grid,
    walk,
    feats,
    greenLabels: greenCC.labels,
    regions,
    dist,
    originCell,
    cands,
    cost,
    strategy,
    elements: input.elements ?? [],
    unknownColors: input.debug ? topUnknownColors(rgba, cls, n, 10) : [],
  };

  hooks.onDebug?.({ ...debugBase, loopCells: null });
  if (strategy.missingTags.includes("cafe") && input.semanticStatus !== "analyzed") {
    throw new RouteError("vision-unavailable");
  }
  if (cands.length === 0 || strategy.missingTags.length) throw new RouteError("no-match", strategy.missingTags.join(", "));
  hooks.onPhase?.("vertices");

  /* 9. 루프 */
  hooks.onPhase?.("linking");
  const rng = createRng(seed);
  const targetM = targetMetres(minutes);
  const k = K_BY_MINUTES[minutes];
  const loop = buildLoop({ cost, minCost, walk, plan, cands, targetM, k, originCell, rng, timings });
  lap("loop");


  if (!loop || loop.path.length < 3 || !(loop.lengthM > 0)) {
    hooks.onDebug?.({ ...debugBase, loopCells: null });
    throw new RouteError("diverged", "no loop");
  }
  if (Math.abs(loop.ratio - 1) > LOOP.accept) {
    hooks.onDebug?.({ ...debugBase, loopCells: loop.cells });
    throw new RouteError("diverged", `ratio ${loop.ratio.toFixed(2)}`);
  }
  const visitedTags = new Set(loop.waypoints.flatMap((wp) => cands.find((c) => c.cell === wp.cell)?.matchedTags ?? []));
  if (strategy.requestedTags.some((tag) => !visitedTags.has(tag))) {
    throw new RouteError("no-match", "selected categories not visited");
  }

  /* 10. 정점 → lat/lng, path 인덱스, 반환점 */
  const cellLatLng = (cell: number): LatLng =>
    canvasToLatLng(plan, (cell % gw) * down + down / 2, Math.floor(cell / gw) * down + down / 2);
  const waypoints: Waypoint[] = loop.waypoints.map((wp) => {
    const ll = cellLatLng(wp.cell);
    const candidate = cands.find((c) => c.cell === wp.cell);
    const label = candidate?.element?.label || (candidate?.kind === "green" ? "녹지 주변" : candidate?.kind === "shore" ? "물가 주변" : candidate?.kind === "built" ? "건물 주변" : "산책 경유지");
    return { lat: ll.lat, lng: ll.lng, pathIndex: nearestPathIndex(loop.path, ll), kind: wp.kind, label, category: candidate?.element?.category, matchedTags: candidate?.matchedTags };
  });
  let turnIndex = waypoints.find((wp) => wp.kind === "turn")?.pathIndex ?? -1;
  if (turnIndex < 0) {
    const o = loop.path[0];
    let far = 0;
    loop.path.forEach((p, i) => {
      const d = (p.lat - o.lat) ** 2 + (p.lng - o.lng) ** 2;
      if (d > far) {
        far = d;
        turnIndex = i;
      }
    });
  }

  /* 11. 사실: 녹지 성분 수(30 m), 물가 구간(60 m), 도로 종류 비율, 오르막 */
  const rGreen = Math.max(1, Math.ceil(30 / cellM));
  const greenSeen = new Set<number>();
  const shareCount: Record<"minor" | "secondary" | "major" | "path" | "park" | "trunk", number> = {
    minor: 0,
    secondary: 0,
    major: 0,
    path: 0,
    park: 0,
    trunk: 0,
  };
  let waterEdgeM = 0;
  const cells = loop.cells;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const cx = c % gw;
    const cy = (c - cx) / gw;
    for (let dy = -rGreen; dy <= rGreen; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= gh) continue;
      for (let dx = -rGreen; dx <= rGreen; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= gw) continue;
        const l = greenCC.labels[yy * gw + xx];
        if (l > 0) greenSeen.add(l);
      }
    }
    const kind = walk.kind[c];
    if (kind === WalkKind.MINOR) shareCount.minor++;
    else if (kind === WalkKind.SECONDARY) shareCount.secondary++;
    else if (kind === WalkKind.MAJOR) shareCount.major++;
    else if (kind === WalkKind.PATH) shareCount.path++;
    else if (kind === WalkKind.PARK) shareCount.park++;
    else if (kind === WalkKind.TRUNK) shareCount.trunk++;
    if (i > 0 && feats.nearWater[c] >= 0.5) {
      const p = cells[i - 1];
      const px = p % gw;
      const py = (p - px) / gw;
      waterEdgeM += (px !== cx && py !== cy ? Math.SQRT2 : 1) * cellM;
    }
  }
  const total = Math.max(1, cells.length);
  const roadShare = {
    minor: shareCount.minor / total,
    secondary: shareCount.secondary / total,
    major: shareCount.major / total,
    path: shareCount.path / total,
    park: shareCount.park / total,
    trunk: shareCount.trunk / total,
  };
  const ascentM = elev ? ascentAlong(loop.path, elev) : null;
  lap("facts");
  timings.total = Math.round((now() - tStart) * 10) / 10;

  hooks.onDebug?.({ ...debugBase, loopCells: loop.cells });

  return {
    path: loop.path,
    waypoints,
    turnIndex,
    lengthM: loop.lengthM,
    targetM,
    ascentM: ascentM != null && Number.isFinite(ascentM) ? ascentM : null,
    facts: { greenRegions: greenSeen.size, waterEdgeM, roadShare },
    seed,
    zoom: z,
    timings,
    classifiedFraction: classified,
    unreachableRoadShare,
    iterations: loop.iterations,
    converged: loop.converged,
    strategy,
    elements: input.elements ?? [],
    startOffsetM: haversineM(input.origin, loop.path[0]),
    semanticStatus: input.semanticStatus ?? "unavailable",
  };
}
