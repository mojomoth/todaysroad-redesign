"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { COURSES, type Course } from "@/lib/courses";
import type { GenPhase, MapStyle, Panel, RecommendPrefs } from "@/lib/types";
import { NOTICE_BY_REASON } from "@/lib/route/course";
import { RouteError } from "@/lib/route/types";
import {
  disposeWorker,
  readDebugFlags,
  startGeneration,
  type GenerationJob,
} from "@/lib/recommend";
import KakaoMap, { type KakaoMapHandle, type RouteWaypoint } from "./KakaoMap";
import StatusBar from "./StatusBar";
import BrandButton from "./BrandButton";
import TopActions from "./TopActions";
import IslandPanel from "./IslandPanel";
import NotificationsPanel from "./NotificationsPanel";
import SettingsPanel from "./SettingsPanel";
import RecommendPanel from "./RecommendPanel";
import CourseSheet from "./CourseSheet";
import BottomControls from "./BottomControls";

/** 지도 위 경로 그리기 애니메이션 길이 */
const ROUTE_DRAW_MS = 1600;
/** 필이 최소한 보이는 시간 (패널이 닫힌 시점 기준) */
const MIN_PILL_MS = 600;
/** 필 문구 한 단계가 최소한 머무는 시간 */
const PHASE_DWELL_MS = 300;
/** 산책 속도 4km/h 기준 루프 반경 (스캔 링 크기용) */
const WALK_KMH = 4;

const PHASE_LABEL: Record<GenPhase, string> = {
  locating: "현재 위치를 확인하고 있어요",
  snapshot: "주변 지도를 한 장에 담고 있어요",
  reading: "길과 자연, 건물, 아이콘을 구분해요",
  strategy: "산책 방향을 정하고 있어요",
  filtering: "선택한 분위기의 장소를 찾고 있어요",
  vertices: "지나갈 지점을 고르고 있어요",
  linking: "길을 이어 코스를 만들고 있어요",
  drawing: "오늘의 코스를 그리고 있어요",
};

interface PhaseEntry {
  phase: GenPhase;
  then?: () => void;
}

/** 진행 중인 생성 1건. consumed = 패널이 닫혀 필이 떠서 UI가 이 잡을 소비하기 시작함 */
interface Gen {
  id: number;
  job: GenerationJob;
  consumed: boolean;
  /** 워커가 도달한 최신 단계 (필 초기 문구) */
  phase: GenPhase;
  /** 마지막으로 표시(또는 대기열에 추가)한 단계 — 중복 방지 */
  lastQueued: GenPhase | null;
  queue: PhaseEntry[];
  pumping: boolean;
  shownAt: number;
  pillShownAt: number;
  timers: ReturnType<typeof setTimeout>[];
}

export default function AppScreen() {
  const mapRef = useRef<KakaoMapHandle>(null);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [mapStyle, setMapStyle] = useState<MapStyle>("light");
  // 지도에 그려진 생성 코스 경로와 '만드는 중' 연출 상태
  const [route, setRoute] = useState<Course["path"] | null>(null);
  const [waypoints, setWaypoints] = useState<RouteWaypoint[] | null>(null);
  const [turnIndex, setTurnIndex] = useState<number | null>(null);
  const [routeSource, setRouteSource] = useState<Course["source"] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [genPhase, setGenPhase] = useState<GenPhase>("reading");
  const [scanRadiusM, setScanRadiusM] = useState<number | null>(null);
  const genRef = useRef<Gen | null>(null);
  const genSeqRef = useRef(0);

  /** 진행 중 생성 정리 (abort=true면 워커/fetch까지 취소) */
  const clearGen = useCallback((abort: boolean) => {
    const gen = genRef.current;
    if (!gen) return;
    gen.timers.forEach(clearTimeout);
    gen.timers = [];
    if (abort) gen.job.abort();
    genRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearGen(true);
      disposeWorker();
    },
    [clearGen]
  );

  /** 단계 문구 대기열: 순서대로, 각 단계 최소 PHASE_DWELL_MS, 'drawing'은 필 최소 노출 이후 */
  const pump = useCallback((gen: Gen) => {
    if (gen.pumping || gen.queue.length === 0) return;
    const entry = gen.queue.shift()!;
    const now = performance.now();
    let at = gen.shownAt + PHASE_DWELL_MS;
    if (entry.phase === "drawing") at = Math.max(at, gen.pillShownAt + MIN_PILL_MS);
    gen.pumping = true;
    const t = setTimeout(
      () => {
        gen.pumping = false;
        if (genRef.current !== gen) return;
        setGenPhase(entry.phase);
        gen.shownAt = performance.now();
        entry.then?.();
        pump(gen);
      },
      Math.max(0, at - now)
    );
    gen.timers.push(t);
  }, []);

  const enqueuePhase = useCallback(
    (gen: Gen, entry: PhaseEntry) => {
      if (entry.phase === gen.lastQueued && !entry.then) return;
      gen.lastQueued = entry.phase;
      gen.queue.push(entry);
      pump(gen);
    },
    [pump]
  );

  const handleSelectCourse = useCallback((course: Course | null) => {
    setSelectedCourse(course);
  }, []);

  const handleLocate = useCallback(() => {
    mapRef.current?.moveToCurrentLocation();
  }, []);

  const openPanel = useCallback(
    (next: Exclude<Panel, null>) => {
      // 필이 뜨기 전(미소비) 다른 패널을 열면 대기 중 생성은 취소
      if (genRef.current && !genRef.current.consumed) clearGen(true);
      setSelectedCourse(null);
      setGenerationError(null);
      setPanel(next);
    },
    [clearGen]
  );

  const closePanel = useCallback(() => setPanel(null), []);

  // '오늘의길' 버튼: 어떤 상태에서든 처음 화면으로
  const goHome = useCallback(() => {
    clearGen(true);
    setGenerating(false);
    setGenerationError(null);
    setScanRadiusM(null);
    setRoute(null);
    setWaypoints(null);
    setTurnIndex(null);
    setRouteSource(null);
    setPanel(null);
    setSelectedCourse(null);
    mapRef.current?.resetView();
  }, [clearGen]);

  // 추천 조건 제출: 타일 fetch를 즉시 시작하고 패널을 닫는다. UI 소비는 패널이 닫힌 뒤.
  const handleRecommendSubmit = useCallback(
    (prefs: RecommendPrefs) => {
      clearGen(true);
      setGenerationError(null);
      const id = ++genSeqRef.current;
      const origin = mapRef.current?.getCurrentPosition() ?? Promise.reject(new RouteError("location"));
      const flags = readDebugFlags();
      const job = startGeneration(origin, prefs, {
        seed: flags.seed,
        debug: flags.debug,
        onPhase: (p) => {
          const gen = genRef.current;
          if (!gen || gen.id !== id) return;
          gen.phase = p;
          if (gen.consumed) enqueuePhase(gen, { phase: p });
        },
      });
      genRef.current = {
        id,
        job,
        consumed: false,
        phase: "locating",
        lastQueued: null,
        queue: [],
        pumping: false,
        shownAt: 0,
        pillShownAt: 0,
        timers: [],
      };
      const radiusM = ((prefs.minutes / 60) * WALK_KMH * 1000) / (2 * Math.PI);
      setScanRadiusM(radiusM * 1.3);
      setPanel(null);
    },
    [clearGen, enqueuePhase]
  );

  // 패널 수축 완료 → '만드는 중' 필 + 지도에 경로가 그려짐 → 코스 시트 등장
  // (onExitComplete는 어떤 패널이 닫혀도 발화하므로 consumed 게이트로 1회만 소비)
  const handlePanelExitComplete = useCallback(() => {
    const gen = genRef.current;
    if (!gen || gen.consumed) return;
    gen.consumed = true;

    setSelectedCourse(null);
    setRoute(null);
    setWaypoints(null);
    setTurnIndex(null);
    setRouteSource(null);
    setGenerating(true);
    setGenPhase(gen.phase);
    gen.lastQueued = gen.phase;
    gen.shownAt = gen.pillShownAt = performance.now();

    gen.job.run().then(
      ({ course, reason }) => {
        if (genRef.current !== gen) return;
        if (!course) {
          gen.timers.forEach(clearTimeout);
          genRef.current = null;
          setGenerating(false);
          setScanRadiusM(null);
          setGenerationError(NOTICE_BY_REASON[reason]);
          return;
        }
        enqueuePhase(gen, {
          phase: "drawing",
          then: () => {
            setScanRadiusM(null);
            setRoute(course.path ?? null);
            setWaypoints(course.waypoints ?? null);
            setTurnIndex(course.turnIndex ?? null);
            setRouteSource(course.source ?? null);
            const t = setTimeout(() => {
              if (genRef.current !== gen) return;
              setGenerating(false);
              setSelectedCourse(course);
              genRef.current = null;
            }, ROUTE_DRAW_MS + 250);
            gen.timers.push(t);
          },
        });
      },
      () => {
        /* aborted: goHome/openPanel이 이미 UI를 정리했다 */
      }
    );
  }, [enqueuePhase]);

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="app" data-map-style={mapStyle}>
        <KakaoMap
          ref={mapRef}
          courses={COURSES}
          selectedCourseId={selectedCourse?.id ?? null}
          onSelectCourse={handleSelectCourse}
          route={route}
          routeDrawMs={ROUTE_DRAW_MS}
          waypoints={waypoints}
          turnIndex={turnIndex}
          scanRadiusM={generating && genPhase !== "locating" ? scanRadiusM : null}
          attribution={Boolean(route) && routeSource === "segmented"}
        />
        <StatusBar />

        <AnimatePresence>
          {panel && (
            <motion.div
              key="scrim"
              className="island-scrim"
              onClick={closePanel}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            />
          )}
        </AnimatePresence>

        <header className="top-bar">
          <BrandButton onClick={goHome} />
          <TopActions panel={panel} onOpen={openPanel} />
        </header>

        <AnimatePresence onExitComplete={handlePanelExitComplete}>
          {panel === "notifications" && (
            <IslandPanel
              key="notifications"
              layoutId="island-notifications"
              anchor="top"
              title="알림"
              onClose={closePanel}
            >
              <NotificationsPanel />
            </IslandPanel>
          )}
          {panel === "settings" && (
            <IslandPanel
              key="settings"
              layoutId="island-settings"
              anchor="top"
              title="설정"
              onClose={closePanel}
            >
              <SettingsPanel mapStyle={mapStyle} onMapStyleChange={setMapStyle} />
            </IslandPanel>
          )}
          {panel === "recommend" && (
            <IslandPanel
              key="recommend"
              layoutId="island-recommend"
              anchor="top"
              fill
              title="코스 추천"
              onClose={closePanel}
            >
              <RecommendPanel onSubmit={handleRecommendSubmit} />
            </IslandPanel>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {generating && (
            <motion.div
              key="generating"
              className="generating-pill"
              role="status"
              initial={{ opacity: 0, y: 24, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.94, transition: { duration: 0.16 } }}
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
            >
              <motion.svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
                animate={{ rotate: [0, 20, -12, 0], scale: [1, 1.2, 0.95, 1] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
              >
                <path d="M12 2.5c.5 3.9 2 6.6 5.5 7.5-3.5.9-5 3.6-5.5 7.5-.5-3.9-2-6.6-5.5-7.5 3.5-.9 5-3.6 5.5-7.5z" />
                <path d="M19 13.5c.3 2.1 1.1 3.5 3 4-1.9.5-2.7 1.9-3 4-.3-2.1-1.1-3.5-3-4 1.9-.5 2.7-1.9 3-4z" />
              </motion.svg>
              <span className="pill-text">
                <AnimatePresence initial={false}>
                  <motion.span
                    key={genPhase}
                    className="pill-text-item"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                  >
                    {PHASE_LABEL[genPhase]}
                  </motion.span>
                </AnimatePresence>
              </span>
              <span className="generating-dots">
                {[0, 1, 2].map((i) => (
                  <motion.i
                    key={i}
                    animate={{ opacity: [0.2, 1, 0.2], y: [0, -3, 0] }}
                    transition={{
                      duration: 0.9,
                      repeat: Infinity,
                      delay: i * 0.15,
                      ease: "easeInOut",
                    }}
                  />
                ))}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {generationError && !panel && (
            <motion.section className="route-error" role="alert" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <p>{generationError}</p>
              <button type="button" onClick={() => openPanel("recommend")}>조건 바꿔 다시 만들기</button>
              <button type="button" aria-label="안내 닫기" onClick={() => setGenerationError(null)}>닫기</button>
            </motion.section>
          )}
          {selectedCourse && !panel && (
            <CourseSheet
              key={selectedCourse.id}
              course={selectedCourse}
              onClose={() => setSelectedCourse(null)}
            />
          )}
        </AnimatePresence>

        <BottomControls
          panel={panel}
          onOpenRecommend={() => openPanel("recommend")}
          onLocate={handleLocate}
        />
      </div>
    </MotionConfig>
  );
}
