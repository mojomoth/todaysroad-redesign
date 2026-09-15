/**
 * 코스 카드 조립 (한국어 문구), 분위기 태그, 실패 안내.
 * lib/route 안에서 UI 텍스트를 담당하는 유일한 모듈.
 */
import type { Course } from "../courses";
import type { RecommendPrefs } from "../types";
import {
  WALK_KMH,
  type LatLng,
  type RouteFailReason,
  type RouteResult,
} from "./types";

export interface MoodTag {
  id: string;
  emoji: string;
  label: string;
}

export const MOOD_TAGS: MoodTag[] = [
  { id: "nature", emoji: "🌿", label: "자연적인" },
  { id: "urban", emoji: "🏙️", label: "도시적인" },
  { id: "quiet", emoji: "🤫", label: "조용한" },
  { id: "lively", emoji: "🎉", label: "활기찬" },
  { id: "river", emoji: "🌊", label: "강변" },
  { id: "alley", emoji: "🏘️", label: "골목길" },
  { id: "night", emoji: "🌙", label: "야경" },
  { id: "cafe", emoji: "☕", label: "카페 투어" },
  { id: "hill", emoji: "⛰️", label: "언덕" },
  { id: "flat", emoji: "🚶", label: "평지" },
];

/** 실패 사유별 시트 안내 문구 */
export const NOTICE_BY_REASON: Record<RouteFailReason, string> = {
  tiles: "주변 지도 이미지를 불러오지 못했어요. 연결 상태를 확인하고 다시 시도해주세요.",
  taint: "지도 이미지를 읽을 수 없어요. 잠시 후 다시 시도해주세요.",
  blank: "지도 이미지에서 길을 구분하기 어려워요. 다른 위치에서 시도해주세요.",
  "no-road": "현재 위치 주변에서 연결된 길을 찾지 못했어요.",
  "no-match": "주변 지도에서 선택한 조건에 맞는 경유지를 연결하지 못했어요. 시간이나 분위기를 바꿔보세요.",
  "vision-unavailable": "지금은 지도 속 카페를 확인할 수 없어요. 다른 분위기를 선택해주세요.",
  location: "현재 위치를 확인하지 못했어요. 브라우저의 위치 권한을 허용한 뒤 다시 시도해주세요.",
  diverged: "희망 시간에 맞는 길을 연결하지 못했어요. 시간을 바꿔보세요.",
  timeout: "지도 분석이 오래 걸려 중단했어요. 다시 시도해주세요.",
  unsupported: "이 브라우저에서는 지도 이미지를 읽을 수 없어요.",
  error: "코스를 완성하지 못했어요. 다시 시도해주세요.",
  aborted: "",
};

function tagLabels(tags: string[]): string[] {
  return tags
    .map((id) => MOOD_TAGS.find((t) => t.id === id)?.label)
    .filter((l): l is string => Boolean(l));
}

function titleFor(labels: string[]): string {
  return labels.length ? `${labels.slice(0, 2).join(" ")} 산책` : "오늘의 산책";
}

export function difficultyFor(prefs: RecommendPrefs, ascentM: number | null): string {
  if (ascentM != null) return ascentM >= 60 ? "어려움" : ascentM >= 25 ? "보통" : "쉬움";
  return prefs.tags.includes("hill") || prefs.minutes >= 120 ? "보통" : "쉬움";
}

/** 세그멘테이션 결과 → 코스 카드 (거리·시간은 실측) */
export function buildCourse(origin: LatLng, prefs: RecommendPrefs, result: RouteResult): Course {
  const km = result.lengthM / 1000;
  const minutes = Math.max(5, Math.round(((km / WALK_KMH) * 60) / 5) * 5);
  const labels = tagLabels(prefs.tags);
  const title = titleFor(labels);

  const facts: string[] = [];
  if (result.facts.greenRegions > 0) facts.push(`녹지 ${result.facts.greenRegions}곳`);
  if (result.facts.waterEdgeM >= 50) facts.push(`강변 ${Math.round(result.facts.waterEdgeM / 10) * 10}m`);

  let description = `${labels.join(", ")} 분위기에 맞춰 주변 길을 이어 만든 ${km.toFixed(1)}km 순환 코스예요.`;
  if (facts.length) description += ` ${facts.join(", ")} 구간을 지나요.`;
  if (result.ascentM != null) description += ` 오르막은 약 ${Math.round(result.ascentM)}m예요.`;
  description += " 가까운 길에서 출발해 같은 지점으로 돌아와요.";
  const notices: string[] = [];
  if (result.startOffsetM > 10) notices.push(`출발점은 현재 위치에서 약 ${Math.round(result.startOffsetM)}m 떨어진 길 위에 있어요.`);
  if (result.semanticStatus === "unavailable") notices.push("아이콘과 장소명 확인 없이 지도에 보이는 지형과 길로 구성했어요.");
  if (prefs.tags.some((t) => ["quiet", "lively", "night"].includes(t))) notices.push("분위기는 지도 형태로 추정하며 소음이나 조명 상태는 확인하지 못해요.");

  return {
    id: `generated-${result.seed}`,
    markerName: title,
    markerMeta: `${km.toFixed(1)}km · 약 ${minutes}분`,
    title,
    distance: `${km.toFixed(1)}km`,
    duration: `약 ${minutes}분`,
    difficulty: difficultyFor(prefs, result.ascentM),
    description,
    lat: origin.lat,
    lng: origin.lng,
    generated: true,
    path: result.path,
    source: "segmented",
    seed: result.seed,
    lengthM: result.lengthM,
    ascentM: result.ascentM,
    waypoints: result.waypoints,
    turnIndex: result.turnIndex,
    notice: notices.join(" ") || undefined,
  };
}
