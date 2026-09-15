/**
 * 코스 추천 파사드 — UI는 이 모듈만 import한다.
 * 실제 구현은 lib/route/* (세그멘테이션 파이프라인·코스 문구·워커 클라이언트).
 */
export { MOOD_TAGS, type MoodTag, buildCourse } from "./route/course";
export {
  startGeneration,
  disposeWorker,
  readDebugFlags,
  type GenerationJob,
  type GeneratedCourse,
} from "./route/client";
export type { LatLng } from "./route/types";
