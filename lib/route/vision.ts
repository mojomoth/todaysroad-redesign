import { parseElements } from "./elements";
import { decodeMosaic, mosaicPng, startTileFetch } from "./tiles";
import { RouteError, type GridPlan, type MapElement } from "./types";

export interface ImageAnalysis {
  elements: MapElement[];
  status: "analyzed" | "unavailable";
  snapshot?: string;
}

/** 도로용 무라벨 이미지와 동일한 좌표/해상도의 유라벨 이미지를 분석한다. */
export async function analyzeMapImage(plan: GridPlan, signal: AbortSignal, budgetEndsAt: number): Promise<ImageAnalysis> {
  try {
    const config = await fetch("/api/route/segment", { signal });
    if (!config.ok || !(await config.json()).enabled) return { elements: [], status: "unavailable" };
    const tiles = await startTileFetch(plan, signal, budgetEndsAt, true);
    const snapshot = mosaicPng(await decodeMosaic(tiles));
    if (signal.aborted) throw new RouteError("aborted");
    const response = await fetch("/api/route/segment", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ image: snapshot, width: plan.width, height: plan.height }),
    });
    if (!response.ok) return { elements: [], status: "unavailable", snapshot };
    const elements = parseElements(await response.json(), plan.width, plan.height);
    return { elements, status: "analyzed", snapshot };
  } catch {
    if (signal.aborted) throw new RouteError("aborted");
    return { elements: [], status: "unavailable" };
  }
}
