import test from "node:test";
import assert from "node:assert/strict";
import { astar, buildWalkGrid, createScratch, dijkstraMetres } from "../lib/route/graph";
import { parseElements } from "../lib/route/elements";
import { filterCandidates } from "../lib/route/strategy";
import { runPipeline } from "../lib/route/pipeline";
import { canvasToLatLng, latLngToCanvas, planGrid } from "../lib/route/mercator";
import { Cls, FEAT, NUM_CLS, NUM_FEAT, RouteError, WalkKind, type Candidate, type CellGrid, type WalkGrid } from "../lib/route/types";

function walkGrid(rows: number[][]): WalkGrid {
  const mask = new Uint8Array(rows.flat());
  return { gw: rows[0].length, gh: rows.length, cellM: 1, kind: mask.slice(), walkable: mask, passable: mask, widthM: new Float32Array(mask.length) };
}

test("A* and reachability cannot cut diagonally through blocked corners", () => {
  const walk = walkGrid([[1, 0], [0, 1]]);
  assert.equal(dijkstraMetres(walk, 0)[3], Infinity);
  assert.equal(astar(new Float32Array(4).fill(1), walk, 0, 3, null, 1, createScratch(4)), null);
});

test("road routing takes the visible detour around a building", () => {
  const walk = walkGrid([[1, 1, 1], [1, 0, 1], [1, 1, 1]]);
  const cells = astar(new Float32Array(9).fill(1), walk, 3, 5, null, 1, createScratch(9));
  assert.ok(cells);
  assert.equal(cells.length, 5);
  assert.ok([...cells].every((c) => c !== 4));
});

test("waterfront green and highways are never treated as walking surfaces", () => {
  const frac = new Uint8Array(3 * NUM_CLS);
  frac[Cls.GREEN] = 255; frac[NUM_CLS + Cls.TRUNK] = 255; frac[2 * NUM_CLS + Cls.MINOR] = 255;
  const grid: CellGrid = { gw: 3, gh: 1, down: 1, cellM: 1, frac, road: new Uint8Array([0, 0, 255]), roadCell: new Uint8Array([0, 0, 1]), widthM: new Float32Array(3) };
  const walk = buildWalkGrid(grid, 17, new Int32Array([1, 0, 0]), [{ id: 1, cls: Cls.GREEN, cells: 100000, areaM2: 100000, cx: 0, cy: 0, poleX: 0, poleY: 0, minX: 0, minY: 0, maxX: 0, maxY: 0, touchesWater: true }]);
  assert.deepEqual([...walk.passable], [0, 0, 1]);
  assert.equal(walk.kind[1], WalkKind.TRUNK);
});

const candidate = (): Candidate => ({ cell: 1, cx: 1, cy: 0, d: 100, bearing: 0, kind: "built", score: 0, f: new Float32Array(NUM_FEAT) });

test("cafe needs image evidence; dense buildings do not satisfy cafe", () => {
  const c = candidate(); c.f[FEAT.built] = 1; c.f[FEAT.minorDensity] = 1;
  assert.deepEqual(filterCandidates([c], ["cafe"]).strategy.missingTags, ["cafe"]);
  c.element = { id: "coffee", kind: "icon", category: "cafe", label: "카페", x: 10, y: 10, bounds: { x: 5, y: 5, width: 10, height: 10 }, confidence: 0.9 };
  assert.equal(filterCandidates([c], ["cafe"]).candidates.length, 1);
  assert.deepEqual(filterCandidates([c], ["cafe", "river"]).strategy.missingTags, ["river"]);
});

test("unavailable elevation does not imply flat terrain", () => {
  const c = candidate(); c.f[FEAT.slope] = -1;
  assert.equal(filterCandidates([c], ["flat"]).candidates.length, 0);
});

test("image boxes preserve projection and reject guesses, overflow and duplicates", () => {
  const e = { kind: "icon", category: "cafe", label: "카페", x: 0.25, y: 0.5, width: 0.1, height: 0.2, confidence: 0.9 };
  const elements = parseElements({ elements: [e, e, { ...e, x: 0.99 }, { ...e, confidence: 0.2 }, { ...e, x: NaN }, { ...e, width: -1 }] }, 1000, 500);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].x, 300);
  assert.equal(elements[0].y, 300);
  assert.throws(() => parseElements({ wrong: [] }, 512, 512));
});

function fixture() {
  const base = planGrid({ lat: 37.5485, lng: 126.9335 }, 30);
  const plan = { ...base, cols: 1, rows: 1, width: 512, height: 512, originPx: { x: 260, y: 260 }, windowHalfM: 250 };
  plan.origin = canvasToLatLng(plan, 260, 260);
  const rgba = new Uint8ClampedArray(512 * 512 * 4);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const road = x % 64 < 12 || y % 64 < 12;
    const i = (y * 512 + x) * 4;
    rgba.set(road ? [255, 255, 255, 255] : [224, 236, 211, 255], i);
  }
  return { plan, rgba, missing: new Uint8Array(1) };
}

test("full image pipeline yields reproducible closed paths entirely on road cells", () => {
  const { plan, rgba, missing } = fixture();
  const input = { origin: plan.origin, minutes: 15 as const, tags: ["nature"], seed: 42, plan };
  let walk: WalkGrid | undefined;
  let down = 0;
  const result = runPipeline(input, rgba, missing, null, { onDebug: (d) => { walk = d.walk; down = d.grid.down; } });
  assert.deepEqual(result.path[0], result.path.at(-1));
  assert.ok(result.lengthM >= 700 && result.lengthM <= 1300);
  assert.deepEqual(runPipeline(input, rgba, missing, null).path, result.path);
  assert.ok(result.waypoints.every((w) => w.matchedTags?.includes("nature")));
  for (const point of result.path) {
    const { x, y } = latLngToCanvas(plan, point);
    const cell = Math.floor(y / down) * walk!.gw + Math.floor(x / down);
    assert.equal(walk!.passable[cell], 1);
  }
  for (const waypoint of result.waypoints) assert.deepEqual(result.path[waypoint.pathIndex], { lat: waypoint.lat, lng: waypoint.lng });
});

test("empty and unmatchable images fail without fabricated geometry", () => {
  const { plan, rgba, missing } = fixture();
  const input = { origin: plan.origin, minutes: 15 as const, tags: ["cafe"], seed: 42, plan };
  assert.throws(() => runPipeline(input, new Uint8ClampedArray(rgba.length), missing, null), (e) => e instanceof RouteError && e.reason === "blank");
  assert.throws(() => runPipeline(input, rgba, missing, null), (e) => e instanceof RouteError && e.reason === "vision-unavailable");
  assert.throws(() => runPipeline({ ...input, semanticStatus: "analyzed" }, rgba, missing, null), (e) => e instanceof RouteError && e.reason === "no-match");
});
