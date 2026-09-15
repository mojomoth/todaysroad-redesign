/**
 * 메인 스레드 파사드. AppScreen이 import하는 유일한 모듈.
 *
 * startGeneration(): 타일 fetch만 즉시 시작(패널 축소 애니메이션과 겹침).
 * job.run(): 디코딩 → 이미지 요소 → 워커 → Course. 실패하면 코스 없이 사유를 반환한다.
 * 워커는 lazy 싱글턴이며 **잡 소유권**으로 보호된다: 소유 토큰이 일치할 때만 terminate,
 * settle된 잡은 타이머·리스너를 해제하고 절대 워커를 죽이지 않는다.
 */
import type { Course } from "../courses";
import type { RecommendPrefs } from "../types";
import { buildCourse } from "./course";
import { planGrid } from "./mercator";
import { runPipeline } from "./pipeline";
import { analyzeMapImage } from "./vision";
import { decodeMosaic, fetchTerrain, startTileFetch } from "./tiles";
import {
  GUARD,
  RouteError,
  type LatLng,
  type Phase,
  type PipelineInput,
  type RouteFailReason,
  type RouteResult,
  type WorkerIn,
  type WorkerOut,
} from "./types";

export type GeneratedCourse =
  | { course: Course; result: RouteResult; reason: null }
  | { course: null; result: null; reason: RouteFailReason };

export interface GenerationJob {
  id: number;
  token: number;
  seed: number;
  signal: AbortSignal;
  /** 지금까지 도달한 단계 (UI가 필 문구 초기값으로 사용) */
  phase: Phase | null;
  abort(): void;
  run(): Promise<GeneratedCourse>;
}

export interface StartOptions {
  seed?: number;
  debug?: boolean;
  onPhase?: (phase: Phase) => void;
}

let worker: Worker | null = null;
let workerOwner = 0;
let tokenSeq = 0;
let jobSeq = 0;

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./seg.worker.ts", import.meta.url), { type: "module" });
    } catch {
      return null;
    }
  }
  return worker;
}

export function disposeWorker(): void {
  worker?.terminate();
  worker = null;
  workerOwner = 0;
}

export function readDebugFlags(): { seed?: number; debug: boolean } {
  if (typeof window === "undefined") return { debug: false };
  const q = new URLSearchParams(window.location.search);
  const s = q.get("seed");
  const seed = s != null && s !== "" && Number.isFinite(Number(s)) ? Number(s) >>> 0 : undefined;
  return { seed, debug: q.has("debug") || process.env.NEXT_PUBLIC_ROUTE_DEBUG === "1" };
}

function runInWorker(
  w: Worker,
  token: number,
  msg: WorkerIn,
  transfer: Transferable[],
  onPhase: (p: Phase) => void,
  signal: AbortSignal
): Promise<RouteResult> {
  return new Promise<RouteResult>((resolve, reject) => {
    if (signal.aborted) { reject(new RouteError("aborted")); return; }
    workerOwner = token;
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onMessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (!m || m.token !== token) return;
      if (m.type === "phase") onPhase(m.phase);
      else if (m.type === "result") {
        cleanup();
        resolve(m.result);
      } else {
        cleanup();
        reject(new RouteError(m.reason, m.message));
      }
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      if (workerOwner === token) disposeWorker();
      reject(new RouteError("error", e.message || "worker error"));
    };
    const onAbort = () => {
      cleanup();
      if (workerOwner === token) disposeWorker();
      reject(new RouteError("aborted"));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
    try { w.postMessage(msg, transfer); } catch (e) { cleanup(); reject(e); }
  });
}

let activeJob: GenerationJob | null = null;

export function startGeneration(
  position: LatLng | Promise<LatLng>,
  prefs: RecommendPrefs,
  opts: StartOptions = {}
): GenerationJob {
  activeJob?.abort();
  const id = ++jobSeq;
  const token = ++tokenSeq;
  const controller = new AbortController();
  const { signal } = controller;
  const seed = (opts.seed ?? (Date.now() ^ Math.floor(Math.random() * 2 ** 32))) >>> 0;
  const budgetEndsAt = performance.now() + GUARD.totalTimeoutMs;
  let settled = false;
  let running: Promise<GeneratedCourse> | null = null;
  const job: GenerationJob = {
    id, token, seed, signal, phase: "locating",
    abort: () => { if (!settled) controller.abort(); },
    run: () => running ?? (running = run()),
  };
  activeJob = job;
  const setPhase = (p: Phase) => {
    if (settled || signal.aborted) return;
    job.phase = p;
    opts.onPhase?.(p);
  };
  const checkAbort = () => { if (signal.aborted) throw new RouteError("aborted"); };
  const prefetch = Promise.resolve(position).then((origin) => {
    checkAbort();
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || Math.abs(origin.lat) > 85 || Math.abs(origin.lng) > 180) throw new RouteError("location");
    setPhase("snapshot");
    const plan = planGrid(origin, prefs.minutes);
    return startTileFetch(plan, signal, budgetEndsAt).then((tiles) => ({ origin, plan, tiles }));
  });
  prefetch.catch(() => {});

  async function work(): Promise<{ result: RouteResult; origin: LatLng }> {
    const { origin, plan, tiles } = await prefetch;
    checkAbort();
    const mosaic = await decodeMosaic(tiles);
    checkAbort();
    setPhase("reading");
    const [analysis, elev] = await Promise.all([
      analyzeMapImage(plan, signal, budgetEndsAt),
      prefs.tags.some((t) => t === "hill" || t === "flat") ? fetchTerrain(origin, signal, budgetEndsAt) : Promise.resolve(null),
    ]);
    checkAbort();
    const input: PipelineInput = {
      origin, minutes: prefs.minutes, tags: prefs.tags, seed, plan, debug: opts.debug,
      elements: analysis.elements, semanticStatus: analysis.status,
    };
    const w = getWorker();
    let result: RouteResult;
    if (w) {
      const msg: WorkerIn = { type: "run", token, input, rgba: mosaic.rgba, missing: mosaic.missing, elev };
      const transfer: Transferable[] = [mosaic.rgba.buffer];
      if (elev) transfer.push(elev.data.buffer);
      result = await runInWorker(w, token, msg, transfer, setPhase, signal);
    } else {
      await new Promise((r) => setTimeout(r, 0));
      checkAbort();
      result = runPipeline(input, mosaic.rgba, mosaic.missing, elev, setPhase);
    }
    checkAbort();
    if (performance.now() > budgetEndsAt) throw new RouteError("timeout");
    return { result, origin };
  }

  async function run(): Promise<GeneratedCourse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new RouteError("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      timer = setTimeout(() => reject(new RouteError("timeout")), Math.max(0, budgetEndsAt - performance.now()));
    });
    try {
      const { result, origin } = await Promise.race([work(), interrupted]);
      if (opts.debug) {
        console.info("[route] result", { seed, lengthM: result.lengthM, targetM: result.targetM, strategy: result.strategy, semanticStatus: result.semanticStatus });
        console.table(result.timings);
      }
      return { course: buildCourse(origin, prefs, result), result, reason: null };
    } catch (e) {
      const reason: RouteFailReason = signal.aborted ? "aborted" : e instanceof RouteError ? e.reason : "error";
      if (opts.debug) console.warn("[route] failed:", reason);
      controller.abort(); // 타임아웃/실패 후 fetch·워커·단계 이벤트를 모두 정리한다.
      if (reason === "aborted") throw new RouteError("aborted");
      return { course: null, result: null, reason };
    } finally {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (activeJob === job) activeJob = null;
    }
  }
  return job;
}
