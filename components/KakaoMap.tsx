"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { CURRENT_LOCATION, MAP_CENTER, type Course } from "@/lib/courses";
import { RouteError } from "@/lib/route/types";

export interface KakaoMapHandle {
  moveToCurrentLocation: () => void;
  /** 초기 중심·줌으로 복귀 ('오늘의길' 버튼) */
  resetView: () => void;
  /** 생성 시 기기 위치를 확인한다. 데모 좌표로 대체하지 않는다. */
  getCurrentPosition: () => Promise<{ lat: number; lng: number }>;
}

export type RouteWaypoint = NonNullable<Course["waypoints"]>[number];

interface KakaoMapProps {
  courses: Course[];
  selectedCourseId: string | null;
  onSelectCourse: (course: Course | null) => void;
  /** 생성된 산책 경로 — 바뀌면 지도 위에 선이 그려지는 애니메이션이 재생된다 */
  route?: { lat: number; lng: number }[] | null;
  /** 경로 그리기 애니메이션 길이(ms) */
  routeDrawMs?: number;
  /** 테마 정점 — 선이 지나갈 때 점으로 나타난다 (route와 같은 배치로 커밋되어야 함) */
  waypoints?: RouteWaypoint[] | null;
  /** 반환점의 route 인덱스 (없으면 최원점) */
  turnIndex?: number | null;
  /** 주변 지도를 읽는 동안 현재위치 마커에 링을 띄우고 점선 원(반경 m)을 그린다 */
  scanRadiusM?: number | null;
  /** 세그멘테이션 경로가 표시될 때 지도 데이터 출처 표기 */
  attribution?: boolean;
}

declare global {
  interface Window {
    kakao: any;
    __kakaoSdkPromise?: Promise<any>;
  }
}

const INITIAL_LEVEL = 4;

const KAKAO_APP_KEY =
  process.env.NEXT_PUBLIC_KAKAO_MAP_KEY ?? "c27a21ad128ccdc8bc1b3ec50662e18b";

function loadKakaoSdk(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject();
  if (window.__kakaoSdkPromise) return window.__kakaoSdkPromise;

  window.__kakaoSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_APP_KEY}&autoload=false`;
    script.async = true;
    script.onload = () => window.kakao.maps.load(() => resolve(window.kakao));
    script.onerror = () => reject(new Error("Kakao Map SDK load failed"));
    document.head.appendChild(script);
  });
  return window.__kakaoSdkPromise;
}

function createCurrentLocationEl() {
  const el = document.createElement("div");
  el.className = "current-marker";
  el.innerHTML = `
    <span class="current-marker-pulse"></span>
    <span class="current-marker-dot">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3.5 18.5 19 12 15.6 5.5 19z"/>
      </svg>
    </span>`;
  return el;
}

function createCourseEl(course: Course, onClick: () => void) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "course-marker";
  el.setAttribute("aria-label", `추천 코스 ${course.markerName}`);
  el.innerHTML = `
    <span class="course-bubble">
      <span class="course-bubble-name"><i></i>${course.markerName}</span>
      <span class="course-bubble-meta">${course.markerMeta}</span>
    </span>
    <span class="course-bubble-tail"></span>
    <span class="course-anchor"><i></i></span>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  // 지도 드래그와의 충돌 방지: 마커 위에서 시작된 터치/드래그가 지도로 전파되지 않도록
  ["mousedown", "touchstart"].forEach((type) =>
    el.addEventListener(type, (e) => e.stopPropagation())
  );
  return el;
}

interface RouteOverlays {
  halo: any;
  line: any;
  turn: any;
  dots: any[];
}

const KakaoMap = forwardRef<KakaoMapHandle, KakaoMapProps>(function KakaoMap(
  {
    courses,
    selectedCourseId,
    onSelectCourse,
    route = null,
    routeDrawMs = 1600,
    waypoints = null,
    turnIndex = null,
    scanRadiusM = null,
    attribution = false,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const currentPosRef = useRef(CURRENT_LOCATION);
  const currentOverlayRef = useRef<any>(null);
  const currentElRef = useRef<HTMLElement | null>(null);
  const courseElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const routeRef = useRef<RouteOverlays | null>(null);
  // waypoints/turnIndex는 route와 같은 배치로 커밋되므로 ref로 읽는다 (deps에 넣으면 그리기가 재시작됨)
  const waypointsRef = useRef<RouteWaypoint[] | null>(waypoints);
  waypointsRef.current = waypoints;
  const turnIndexRef = useRef<number | null>(turnIndex);
  turnIndexRef.current = turnIndex;

  const onSelectRef = useRef(onSelectCourse);
  onSelectRef.current = onSelectCourse;

  useEffect(() => {
    let cancelled = false;
    const overlays: any[] = [];

    loadKakaoSdk()
      .then((kakao) => {
        if (cancelled || !containerRef.current) return;

        const map = new kakao.maps.Map(containerRef.current, {
          center: new kakao.maps.LatLng(MAP_CENTER.lat, MAP_CENTER.lng),
          level: INITIAL_LEVEL,
        });
        map.setDraggable(true);
        map.setZoomable(true);
        mapRef.current = map;

        // 현재 위치 마커
        const currentEl = createCurrentLocationEl();
        currentElRef.current = currentEl;
        const currentOverlay = new kakao.maps.CustomOverlay({
          position: new kakao.maps.LatLng(
            CURRENT_LOCATION.lat,
            CURRENT_LOCATION.lng
          ),
          content: currentEl,
          yAnchor: 0.5,
          zIndex: 2,
        });
        currentOverlay.setMap(map);
        currentOverlayRef.current = currentOverlay;
        overlays.push(currentOverlay);

        // 추천 코스 마커
        courses.forEach((course) => {
          const el = createCourseEl(course, () =>
            onSelectRef.current(course)
          );
          courseElsRef.current.set(course.id, el);
          const overlay = new kakao.maps.CustomOverlay({
            position: new kakao.maps.LatLng(course.lat, course.lng),
            content: el,
            yAnchor: 1,
            zIndex: 3,
          });
          overlay.setMap(map);
          overlays.push(overlay);
        });

        // 광흥창역 정차점 마커
        const stopEl = document.createElement("div");
        stopEl.className = "transit-stop";
        stopEl.innerHTML = `<i></i><span>광흥창역</span>`;
        const stopOverlay = new kakao.maps.CustomOverlay({
          position: new kakao.maps.LatLng(37.5475, 126.9319),
          content: stopEl,
          yAnchor: 0.28,
          zIndex: 1,
        });
        stopOverlay.setMap(map);
        overlays.push(stopOverlay);

        // 지도 빈 곳 클릭 시 코스 시트 닫기
        kakao.maps.event.addListener(map, "click", () =>
          onSelectRef.current(null)
        );

        // 뷰포트 변화(목업 ↔ 모바일 전환 포함) 시 지도 타일 재배치
        const resizeObserver = new ResizeObserver(() => {
          const center = map.getCenter();
          map.relayout();
          map.setCenter(center);
        });
        resizeObserver.observe(containerRef.current);
        overlays.push({ setMap: () => resizeObserver.disconnect() });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      overlays.forEach((o) => o.setMap(null));
      courseElsRef.current.clear();
      currentElRef.current = null;
      mapRef.current = null;
      setReady(false);
    };
  }, [courses]);

  // 생성된 경로를 출발점부터 차례로 그려 나간다 (정점 점은 선이 지날 때, 반환점은 turnIndex를 지날 때)
  useEffect(() => {
    const map = mapRef.current;
    const kakao = window.kakao;
    if (!ready || !map || !kakao) return;

    const prev = routeRef.current;
    prev?.halo.setMap(null);
    prev?.line.setMap(null);
    prev?.turn.setMap(null);
    prev?.dots.forEach((d) => d.setMap(null));
    routeRef.current = null;
    if (!route || route.length < 2) return;

    const toLatLng = (p: { lat: number; lng: number }) =>
      new kakao.maps.LatLng(p.lat, p.lng);
    const halo = new kakao.maps.Polyline({
      path: [],
      strokeWeight: 10,
      strokeColor: "#ffffff",
      strokeOpacity: 0.95,
      strokeStyle: "solid",
      zIndex: 1,
    });
    const line = new kakao.maps.Polyline({
      path: [],
      strokeWeight: 4.5,
      strokeColor: "#0f0f0f",
      strokeOpacity: 0.95,
      strokeStyle: "solid",
      zIndex: 2,
    });
    halo.setMap(map);
    line.setMap(map);

    const segs = route.length - 1;

    // 반환점: turnIndex가 있으면 그 지점, 없으면 출발점에서 가장 먼 지점(완료 시 표시)
    const ti = turnIndexRef.current;
    let turnPos = route[0];
    let turnAt = segs;
    if (ti != null && ti >= 0 && ti < route.length) {
      turnPos = route[ti];
      turnAt = ti;
    } else {
      const origin = route[0];
      let farD = 0;
      route.forEach((p) => {
        const d = (p.lat - origin.lat) ** 2 + (p.lng - origin.lng) ** 2;
        if (d > farD) {
          farD = d;
          turnPos = p;
        }
      });
    }
    const turnEl = document.createElement("div");
    turnEl.className = "route-turn";
    turnEl.innerHTML = `<i></i><span>반환점</span>`;
    const turn = new kakao.maps.CustomOverlay({
      position: toLatLng(turnPos),
      content: turnEl,
      yAnchor: 0.5,
      zIndex: 2,
    });

    // 테마 정점 점 (반환점 제외) — 선이 지나갈 때 하나씩 나타난다
    const dotDefs = (waypointsRef.current ?? [])
      .filter((w) => w.kind !== "turn")
      .map((w) => {
        const el = document.createElement("div");
        el.className = "route-vertex";
        el.title = w.label || "산책 경유지";
        el.setAttribute("aria-label", w.label || "산책 경유지");
        return {
          pathIndex: w.pathIndex,
          shown: false,
          overlay: new kakao.maps.CustomOverlay({
            position: toLatLng(w),
            content: el,
            yAnchor: 0.5,
            zIndex: 2,
          }),
        };
      });
    routeRef.current = { halo, line, turn, dots: dotDefs.map((d) => d.overlay) };

    // 경로 전체가 보이도록 맞춘 뒤, 하단 시트에 가리지 않게 살짝 위로 올린다
    const bounds = new kakao.maps.LatLngBounds();
    route.forEach((p) => bounds.extend(toLatLng(p)));
    map.setBounds(bounds);
    map.panBy(0, 120);

    // 점 사이를 보간하며 선을 늘려 나간다
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const start = performance.now();
    let raf = 0;
    let turnShown = false;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / routeDrawMs);
      const pos = ease(t) * segs;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const path = route.slice(0, idx + 1).map(toLatLng);
      if (idx < segs) {
        const a = route[idx];
        const b = route[idx + 1];
        path.push(
          toLatLng({
            lat: a.lat + (b.lat - a.lat) * frac,
            lng: a.lng + (b.lng - a.lng) * frac,
          })
        );
      }
      halo.setPath(path);
      line.setPath(path);
      for (const d of dotDefs) {
        if (!d.shown && d.pathIndex <= idx) {
          d.overlay.setMap(map);
          d.shown = true;
        }
      }
      if (!turnShown && (idx >= turnAt || t >= 1)) {
        turn.setMap(map);
        turnShown = true;
      }
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [route, ready, routeDrawMs]);

  // 주변 지도를 읽는 동안: 현재위치 마커 링 + 시각용 점선 원 (카메라는 움직이지 않는다)
  useEffect(() => {
    const map = mapRef.current;
    const kakao = window.kakao;
    const el = currentElRef.current;
    if (!ready || !map || !kakao) return;
    if (scanRadiusM == null) return;

    el?.classList.add("is-scanning");
    const pos = currentPosRef.current;
    const circle = new kakao.maps.Circle({
      center: new kakao.maps.LatLng(pos.lat, pos.lng),
      radius: scanRadiusM,
      strokeWeight: 2,
      strokeColor: "#0f0f0f",
      strokeOpacity: 0.35,
      strokeStyle: "dash",
      fillColor: "#0f0f0f",
      fillOpacity: 0.04,
      zIndex: 1,
    });
    circle.setMap(map);

    return () => {
      el?.classList.remove("is-scanning");
      circle.setOptions({ strokeOpacity: 0, fillOpacity: 0 });
      setTimeout(() => circle.setMap(null), 300);
    };
  }, [scanRadiusM, ready]);

  // 선택된 코스 마커 강조
  useEffect(() => {
    courseElsRef.current.forEach((el, id) => {
      el.classList.toggle("is-selected", id === selectedCourseId);
    });
  }, [selectedCourseId]);

  useImperativeHandle(ref, () => ({
    getCurrentPosition() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) { reject(new RouteError("location")); return; }
        navigator.geolocation.getCurrentPosition(({ coords }) => {
          const p = { lat: coords.latitude, lng: coords.longitude };
          currentPosRef.current = p;
          if (window.kakao && currentOverlayRef.current) currentOverlayRef.current.setPosition(new window.kakao.maps.LatLng(p.lat, p.lng));
          resolve(p);
        }, () => reject(new RouteError("location")), { timeout: 8000, maximumAge: 60_000, enableHighAccuracy: true });
      });
    },
    resetView() {
      const map = mapRef.current;
      const kakao = window.kakao;
      if (!map || !kakao) return;
      if (map.getLevel() !== INITIAL_LEVEL) map.setLevel(INITIAL_LEVEL, { animate: true });
      map.panTo(new kakao.maps.LatLng(MAP_CENTER.lat, MAP_CENTER.lng));
    },
    moveToCurrentLocation() {
      const map = mapRef.current;
      const kakao = window.kakao;
      if (!map || !kakao) return;

      const panTo = (lat: number, lng: number) => {
        const pos = new kakao.maps.LatLng(lat, lng);
        currentPosRef.current = { lat, lng };
        currentOverlayRef.current?.setPosition(pos);
        map.panTo(pos);
      };

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          ({ coords }) => panTo(coords.latitude, coords.longitude),
          () => panTo(currentPosRef.current.lat, currentPosRef.current.lng),
          { timeout: 3000, maximumAge: 60_000 }
        );
      } else {
        panTo(currentPosRef.current.lat, currentPosRef.current.lng);
      }
    },
  }));

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-root" />
      {attribution && (
        <div className="map-attribution" aria-label="지도 데이터 출처">
          © OpenStreetMap contributors © CARTO
        </div>
      )}
      {failed && (
        <div className="map-fallback">
          <p>
            지도를 불러오지 못했어요.
            <br />
            카카오 개발자 콘솔에 현재 도메인이
            <br />
            등록되어 있는지 확인해주세요.
          </p>
        </div>
      )}
    </div>
  );
});

export default KakaoMap;
