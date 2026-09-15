export type Panel = "notifications" | "settings" | "recommend" | null;

export type MapStyle = "light" | "mono" | "dark";

export interface RecommendPrefs {
  minutes: 15 | 30 | 60 | 120;
  tags: string[];
}

export type { LatLng } from "./route/types";

/** 코스 생성 필 문구 단계 */
export type GenPhase = import("./route/types").Phase | "drawing";
