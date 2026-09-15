export interface Course {
  id: string;
  /** 지도 말풍선에 표시되는 코스 이름 */
  markerName: string;
  /** 말풍선 하단 보조 정보 (시작점까지 거리 · 도보 시간) */
  markerMeta: string;
  /** 하단 시트 제목 */
  title: string;
  distance: string;
  duration: string;
  difficulty: string;
  description: string;
  lat: number;
  lng: number;
  /** '코스 추천받기'로 방금 만들어진 코스 */
  generated?: boolean;
  /** 지도에 그릴 산책 경로 (생성 코스만) */
  path?: { lat: number; lng: number }[];
  /** 생성 방식: 지도 이미지 세그멘테이션 */
  source?: "segmented";
  /** 시트 하단에 작게 보이는 안내 (폴백 사유 등) */
  notice?: string;
  /** 재현용 시드 (`generated-${seed}`) */
  seed?: number;
  lengthM?: number;
  ascentM?: number | null;
  /** 테마 정점 — 선이 지나갈 때 점으로 나타난다 (turn은 반환점) */
  waypoints?: import("./route/types").Waypoint[] | null;
  /** 반환점의 path 인덱스 */
  turnIndex?: number;
}

export const COURSES: Course[] = [
  {
    id: "sinsu",
    markerName: "신수동 골목길",
    markerMeta: "0.3km · 4분",
    title: "신수동 골목길 코스",
    distance: "1.2km",
    duration: "18분",
    difficulty: "쉬움",
    description: "조용한 골목길을 따라 걷는 추천 코스예요.",
    lat: 37.5505,
    lng: 126.9322,
  },
  {
    id: "daeheung",
    markerName: "대흥동 골목길",
    markerMeta: "0.5km · 7분",
    title: "대흥동 골목길 코스",
    distance: "1.8km",
    duration: "27분",
    difficulty: "보통",
    description: "정겨운 골목 풍경을 즐기며 걷는 코스예요.",
    lat: 37.5462,
    lng: 126.9345,
  },
];

/** 데모용 현재 위치 (마포구 신수동 인근) */
export const CURRENT_LOCATION = { lat: 37.5485, lng: 126.9335 };

export const MAP_CENTER = { lat: 37.549, lng: 126.9335 };
