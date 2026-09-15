"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CURRENT_LOCATION } from "../../../lib/courses";
import { latLngToCanvas, planGrid } from "../../../lib/route/mercator";
import { CLASS_COLORS } from "../../../lib/route/palette";
import { runPipeline, type PipelineDebug } from "../../../lib/route/pipeline";
import { decodeMosaic, fetchTerrain, startTileFetch, mosaicPng } from "../../../lib/route/tiles";
import { analyzeMapImage } from "../../../lib/route/vision";
import {
  Cls,
  GUARD,
  RouteError,
  WalkKind,
  targetMetres,
  type Minutes,
  type RouteResult,
} from "../../../lib/route/types";

const MINUTES: Minutes[] = [15, 30, 60, 120];
const TAGS = ["nature", "urban", "quiet", "lively", "river", "alley", "night", "cafe", "hill", "flat"];

interface RunState {
  status: "idle" | "running" | "done" | "error";
  result: RouteResult | null;
  debug: PipelineDebug | null;
  error: string | null;
  elapsedMs: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export default function SegDebugView() {
  const [lat, setLat] = useState(CURRENT_LOCATION.lat);
  const [lng, setLng] = useState(CURRENT_LOCATION.lng);
  const [minutes, setMinutes] = useState<Minutes>(30);
  const [tags, setTags] = useState<string[]>(["river"]);
  const [seed, setSeed] = useState(42);
  const [showClasses, setShowClasses] = useState(true);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [run, setRun] = useState<RunState>({ status: "idle", result: null, debug: null, error: null, elapsedMs: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runSeq = useRef(0);

  // URL 쿼리로 초기값 (?lat&lng&minutes&tags&seed)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("lat")) setLat(Number(q.get("lat")));
    if (q.get("lng")) setLng(Number(q.get("lng")));
    const m = Number(q.get("minutes"));
    if ((MINUTES as number[]).includes(m)) setMinutes(m as Minutes);
    if (q.get("tags")) setTags(q.get("tags")!.split(",").filter(Boolean));
    if (q.get("seed")) setSeed(Number(q.get("seed")) >>> 0);
  }, []);

  const plan = useMemo(() => planGrid({ lat, lng }, minutes), [lat, lng, minutes]);

  interface RunCfg {
    lat?: number;
    lng?: number;
    minutes?: Minutes;
    tags?: string[];
    seed?: number;
  }

  /** 실행 (cfg로 덮어쓰면 상태도 갱신) — window.__segRun(cfg)로도 호출 가능 */
  const execute = async (cfg: RunCfg = {}) => {
    const cLat = cfg.lat ?? lat;
    const cLng = cfg.lng ?? lng;
    const cMinutes = cfg.minutes ?? minutes;
    const cTags = cfg.tags ?? tags;
    const cSeed = cfg.seed ?? seed;
    if (cfg.lat != null) setLat(cLat);
    if (cfg.lng != null) setLng(cLng);
    if (cfg.minutes != null) setMinutes(cMinutes);
    if (cfg.tags) setTags(cTags);
    if (cfg.seed != null) setSeed(cSeed);
    const cPlan = planGrid({ lat: cLat, lng: cLng }, cMinutes);
    const id = ++runSeq.current;
    setRun({ status: "running", result: null, debug: null, error: null, elapsedMs: 0 });
    const t0 = performance.now();
    const controller = new AbortController();
    const budgetEndsAt = t0 + GUARD.totalTimeoutMs;
    const dbg: { v: PipelineDebug | null } = { v: null };
    setSnapshot(null);
    try {
      const tiles = await startTileFetch(cPlan, controller.signal, budgetEndsAt);
      const mosaic = await decodeMosaic(tiles);
      const analysis = await analyzeMapImage(cPlan, controller.signal, budgetEndsAt);
      if (runSeq.current !== id) return null;
      setSnapshot(analysis.snapshot ?? mosaicPng(mosaic));
      const elev =
        cTags.includes("hill") || cTags.includes("flat")
          ? await fetchTerrain({ lat: cLat, lng: cLng }, controller.signal, budgetEndsAt)
          : null;
      const result = runPipeline(
        { origin: { lat: cLat, lng: cLng }, minutes: cMinutes, tags: cTags, seed: cSeed, plan: cPlan, debug: true, elements: analysis.elements, semanticStatus: analysis.status },
        mosaic.rgba,
        mosaic.missing,
        elev,
        { onDebug: (d) => (dbg.v = d) }
      );
      if (runSeq.current !== id) return null;
      const elapsedMs = performance.now() - t0;
      setRun({ status: "done", result, debug: dbg.v, error: null, elapsedMs });
      return { result, error: null, elapsedMs, cands: dbg.v?.cands.length ?? 0, unknown: dbg.v?.unknownColors ?? [] };
    } catch (e) {
      if (runSeq.current !== id) return null;
      const msg = e instanceof RouteError ? `${e.reason}: ${e.message}` : String(e);
      const elapsedMs = performance.now() - t0;
      setRun({ status: "error", result: null, debug: dbg.v, error: msg, elapsedMs });
      return { result: null, error: msg, elapsedMs, cands: dbg.v?.cands.length ?? 0, unknown: dbg.v?.unknownColors ?? [] };
    }
  };

  useEffect(() => {
    (window as unknown as { __segRun?: typeof execute }).__segRun = execute;
  });

  // 캔버스 렌더: 클래스 맵 + 통행 종류 + 후보/정점 + 루프
  useEffect(() => {
    const canvas = canvasRef.current;
    const d = run.debug;
    if (!canvas || !d) return;
    const { w, h, grid, walk, cands } = d;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    const px = img.data;
    const palette: [number, number, number][] = [];
    for (let c = 0; c < 16; c++) palette[c] = hexToRgb(CLASS_COLORS[c] ?? "#ff00ff");
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const [r, g, b] = showClasses ? palette[d.cls[i]] : [250, 248, 243];
      px[p] = r;
      px[p + 1] = g;
      px[p + 2] = b;
      px[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    const down = grid.down;
    // 통행 격자 종류 (TRUNK 빨강, PARK 초록, 도로 회색 반투명)
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < walk.kind.length; i++) {
      const k = walk.kind[i];
      if (k === WalkKind.NONE) continue;
      ctx.fillStyle =
        k === WalkKind.TRUNK ? "#e0242b" : k === WalkKind.PARK ? "#1a9e4a" : k === WalkKind.MAJOR ? "#d98a00" : "#666";
      const x = (i % grid.gw) * down;
      const y = Math.floor(i / grid.gw) * down;
      ctx.fillRect(x, y, down, down);
    }
    ctx.globalAlpha = 1;
    for (const element of d.elements) {
      ctx.strokeStyle = "#c026d3";
      ctx.lineWidth = 2;
      const b = element.bounds;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      ctx.fillStyle = "#701a75";
      ctx.font = "16px sans-serif";
      ctx.fillText(`${element.category}: ${element.label}`, b.x, Math.max(16, b.y - 4));
    }

    // 후보 (회색), 점수 상위는 진하게
    const maxScore = cands.reduce((m, c) => Math.max(m, c.score), 0.001);
    for (const c of cands) {
      const s = Math.max(0, c.score) / maxScore;
      ctx.fillStyle = `rgba(20,20,20,${0.15 + 0.5 * s})`;
      ctx.beginPath();
      ctx.arc(c.cx * down + down / 2, c.cy * down + down / 2, Math.max(2, down * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }

    // 루프 (셀 경로: 파랑 얇게, 최종 폴리라인: 검정 굵게)
    if (d.loopCells) {
      ctx.strokeStyle = "rgba(0,90,255,0.8)";
      ctx.lineWidth = Math.max(1, down * 0.6);
      ctx.beginPath();
      for (let i = 0; i < d.loopCells.length; i++) {
        const c = d.loopCells[i];
        const x = (c % grid.gw) * down + down / 2;
        const y = Math.floor(c / grid.gw) * down + down / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    if (run.result) {
      ctx.strokeStyle = "#0f0f0f";
      ctx.lineWidth = Math.max(3, down * 1.2);
      ctx.lineJoin = "round";
      ctx.beginPath();
      run.result.path.forEach((p, i) => {
        const { x, y } = latLngToCanvas(plan, p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      for (const wp of run.result.waypoints) {
        const { x, y } = latLngToCanvas(plan, wp);
        ctx.fillStyle = wp.kind === "turn" ? "#e0242b" : "#0f0f0f";
        ctx.beginPath();
        ctx.arc(x, y, Math.max(6, down * 2), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    // 원점
    ctx.fillStyle = "#1a6dff";
    ctx.beginPath();
    ctx.arc(plan.originPx.x, plan.originPx.y, Math.max(6, down * 2), 0, Math.PI * 2);
    ctx.fill();
    // 분석 창(원점 ± 2.2R)
    const halfPx = plan.windowHalfM / plan.mpp;
    ctx.strokeStyle = "rgba(26,109,255,0.6)";
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeRect(plan.originPx.x - halfPx, plan.originPx.y - halfPx, halfPx * 2, halfPx * 2);
    ctx.setLineDash([]);
  }, [run, plan, showClasses]);

  const r = run.result;
  const d = run.debug;
  const targetM = targetMetres(minutes);
  const legend = Object.entries(Cls).map(([name, id]) => ({ name, id, color: CLASS_COLORS[id] }));

  return (
    <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, padding: 16, display: "flex", gap: 16, alignItems: "flex-start", background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ flex: "0 0 auto" }}>
        {snapshot && <details><summary>분석한 지도 스냅샷</summary>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={snapshot} alt="현재 위치 주변 분석용 지도 스냅샷" style={{ maxWidth: "min(70vw, 1100px)" }} /></details>}
        <canvas ref={canvasRef} style={{ maxWidth: "min(70vw, 1100px)", maxHeight: "92vh", border: "1px solid #ccc", imageRendering: "pixelated" }} />
      </div>
      <div style={{ flex: 1, minWidth: 320 }}>
        <h1 style={{ fontSize: 16, margin: "0 0 8px" }}>/dev/seg — 세그멘테이션 디버거</h1>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 8px", alignItems: "center" }}>
          <label>lat</label>
          <input value={lat} onChange={(e) => setLat(Number(e.target.value))} />
          <label>lng</label>
          <input value={lng} onChange={(e) => setLng(Number(e.target.value))} />
          <label>minutes</label>
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value) as Minutes)}>
            {MINUTES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <label>seed</label>
          <input value={seed} onChange={(e) => setSeed(Number(e.target.value) >>> 0)} />
          <label>tags</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {TAGS.map((t) => (
              <label key={t} style={{ border: "1px solid #ccc", borderRadius: 6, padding: "2px 6px", background: tags.includes(t) ? "#111" : "#fff", color: tags.includes(t) ? "#fff" : "#111" }}>
                <input type="checkbox" style={{ display: "none" }} checked={tags.includes(t)} onChange={() => setTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))} />
                {t}
              </label>
            ))}
          </div>
        </div>
        <div style={{ margin: "10px 0", display: "flex", gap: 8 }}>
          <button onClick={() => execute()} disabled={run.status === "running"} style={{ padding: "6px 12px", border: "1px solid #111", borderRadius: 6 }}>
            {run.status === "running" ? "running…" : "run"}
          </button>
          <button disabled={run.status === "running"} onClick={() => execute({ seed: (seed + 1) >>> 0 })} style={{ padding: "6px 12px", border: "1px solid #999", borderRadius: 6 }}>
            seed+1 & run
          </button>
          <label><input type="checkbox" checked={showClasses} onChange={(e) => setShowClasses(e.target.checked)} /> class map</label>
        </div>
        <p style={{ margin: "4px 0" }}>
          plan: z{plan.z} {plan.cols}×{plan.rows} tiles, {plan.width}×{plan.height}px, {plan.mpp.toFixed(3)} m/px, window ±{Math.round(plan.windowHalfM)} m, target {targetM} m
        </p>
        {run.error && <p style={{ color: "#c00" }}>ERROR {run.error}</p>}
        {run.status !== "idle" && <p>elapsed {Math.round(run.elapsedMs)} ms</p>}
        {r && (
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {[
                ["length / target", `${Math.round(r.lengthM)} / ${r.targetM} m (ratio ${(r.lengthM / r.targetM).toFixed(3)})`],
                ["iterations / converged", `${r.iterations} / ${r.converged}`],
                ["classified", (r.classifiedFraction * 100).toFixed(1) + "%"],
                ["unreachable road share", (r.unreachableRoadShare * 100).toFixed(1) + "%"],
                ["waypoints", r.waypoints.map((w) => `${w.kind}@${w.pathIndex}`).join(", ")],
                ["turnIndex / path pts", `${r.turnIndex} / ${r.path.length}`],
                ["facts", `green ${r.facts.greenRegions}, water ${Math.round(r.facts.waterEdgeM)} m, ascent ${r.ascentM == null ? "-" : Math.round(r.ascentM)} m`],
                ["road share", Object.entries(r.facts.roadShare).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join("  ")],
                ["timings", Object.entries(r.timings).map(([k, v]) => `${k} ${v}`).join("  ")],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding: "2px 8px 2px 0", color: "#666", verticalAlign: "top" }}>{k}</td>
                  <td style={{ padding: "2px 0" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d && (
          <p style={{ margin: "8px 0" }}>
            filtering: {d.strategy.candidateCount} → {d.strategy.filteredCount}; matched: {d.strategy.matchedTags.join(", ") || "none"}; missing: {d.strategy.missingTags.join(", ") || "none"}; image elements: {d.elements.length}<br />
            candidates {d.cands.length} (green {d.cands.filter((c) => c.kind === "green").length}, shore {d.cands.filter((c) => c.kind === "shore").length}, built {d.cands.filter((c) => c.kind === "built").length}, road {d.cands.filter((c) => c.kind === "road").length}); regions {d.regions.length}; grid {d.grid.gw}×{d.grid.gh} @ {d.grid.cellM.toFixed(2)} m
            {d.unknownColors.length > 0 && (
              <>
                <br />unknown: {d.unknownColors.map((u) => `${u.hex} ${(u.share * 100).toFixed(2)}%`).join(", ")}
              </>
            )}
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {legend.map((l) => (
            <span key={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <i style={{ width: 12, height: 12, background: l.color, border: "1px solid #999", display: "inline-block" }} />
              {l.name}
            </span>
          ))}
          <span>overlay: <i style={{ background: "rgba(224,36,43,.5)", width: 12, height: 12, display: "inline-block" }} /> TRUNK <i style={{ background: "rgba(26,158,74,.5)", width: 12, height: 12, display: "inline-block" }} /> PARK <i style={{ background: "rgba(217,138,0,.5)", width: 12, height: 12, display: "inline-block" }} /> MAJOR</span>
        </div>
      </div>
    </div>
  );
}
