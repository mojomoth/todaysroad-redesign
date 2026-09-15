/**
 * voyager_nolabels @2x 팔레트 → 7bit/채널 LUT → 픽셀 클래스.
 *
 * 앵커는 2026-09-03 서울 8지점 × z14~z17 실측(plan 팔레트 표). tol은 8bit 값이며
 * 앵커마다 r±tol, g±tol, b±tol(0..255 클램프)을 순회해 버킷 (r>>1, g>>1, b>>1)에 기록한다.
 * 순수 typed-array — DOM/window 접근 없음(워커·Node 공용).
 */
import { Cls, GUARD, NUM_CLS, type ClsId } from "./types";

export interface PaletteEntry {
  hex: string;
  cls: ClsId;
  /** 8bit 허용 오차 (r, g, b 각각 ±tol) */
  tol: number;
  /** 이 줌 레벨에서만 활성 (undefined = 모든 줌) */
  zooms?: readonly number[];
}

/** 공백 구분 hex 목록을 같은 클래스·tol의 앵커로 펼친다 */
function anchors(cls: ClsId, tol: number, hexes: string, zooms?: readonly number[]): PaletteEntry[] {
  return hexes
    .trim()
    .split(/\s+/)
    .map((hex) => (zooms ? { hex, cls, tol, zooms } : { hex, cls, tol }));
}

const Z14 = [14] as const;
const Z15 = [15] as const;
const Z16_17 = [16, 17] as const;
const Z15_PLUS = [15, 16, 17] as const;

/** plan 팔레트 표 그대로 (순서: 표 순서) */
export const PALETTE: readonly PaletteEntry[] = [
  // WATER — 한강 z16 56.6%, z17 94.9% 정확 일치
  ...anchors(Cls.WATER, 2, "#d5e8eb #cde7ea #cce7ea #b0d0d6"),
  // GREEN — 공원·숲·잔디 단일 클래스 (z15~17: #e0ecd3, z14: #e6efd9 … #d1e6c0)
  ...anchors(Cls.GREEN, 2, "#e0ecd3 #e6efd9 #e7efd9 #d9e9c9 #dae9c9 #d1e6c0 #c5e1b2 #e5efda"),
  // OPEN(연회녹) — 운동장·광장류
  ...anchors(Cls.OPEN, 2, "#dfe1d7 #e0e1d7 #e0e1d8 #dee1d7 #dadcd7 #d9ddd7 #d8ddd6"),
  // GRAY(시설) — 학교·병원·주차·철도부지. 도로 아님
  ...anchors(
    Cls.GRAY,
    1,
    "#dfdedc #dfdedd #e0dfdd #e0dedc #e0dfde #e7e5e1 #e6e4e0 #e7e6e1 #e6e5e2 #dddddc #dddddd",
  ),
  // BUILT(건물) — z14에는 건물이 안 그려짐
  ...anchors(
    Cls.BUILT,
    1,
    "#f6efe4 #f6efe5 #f6f0e5 #e4dcd0 #e5dccf #e5dcce #e5dcd0 #f3eadc #f3eadb #f0e4d1 #f1e7d6 #f0e3d0 #e7dfcb",
    Z15_PLUS,
  ),
  // 건물 외곽선·그림자 블렌드 (실측 UNKNOWN 상위)
  ...anchors(Cls.BUILT, 1, "#e7dbc9 #e7dbc8 #e7dbca #ecdfcb #eee1ce #ebe0ce", Z15_PLUS),
  // URBAN(시가지 landuse) — 줌별 채움색이 다름
  ...anchors(
    Cls.URBAN,
    1,
    "#f5ede2 #f5ede1 #f8f4ec #f8f4eb #f8f3ea #f6f0e7 #f5ecde #f5ecdf #f9f5ee #fbf6ed",
    Z14,
  ),
  ...anchors(Cls.URBAN, 1, "#f9f5ed #fbf9f4", Z15),
  ...anchors(Cls.URBAN, 1, "#f9f6ef #f9f6f0", Z16_17),
  // LAND (+ classify의 연한 난색 미스 규칙)
  ...anchors(Cls.LAND, 1, "#fbf8f3 #fcf8f3 #faf7f1 #faf6f0 #f0eee7 #fdfbf8"),
  // TRUNK(고속화도로) — 보행 불가
  ...anchors(Cls.TRUNK, 2, "#ffe9a5 #fde2a1 #fbdb98 #fbdc98 #fbdc99"),
  // ROAD_MAJOR — fill #fefdd7, casing #ffeabb #ffeabc #ffecbe (primary)
  ...anchors(Cls.MAJOR, 2, "#fefdd7 #ffeabb #ffeabc #ffecbe"),
  // ROAD_SEC_CASE — 흰 fill 2차도로의 주황 외곽선
  ...anchors(Cls.SEC_CASE, 2, "#ffedc0 #ffeec0 #ffeec1"),
  // ROAD_MINOR — 골목·2차도로 공통 fill
  ...anchors(Cls.MINOR, 1, "#ffffff #fffffe #fffdf9"),
  // ROAD_MINOR_CASE — 골목 베이지 외곽선
  ...anchors(
    Cls.MINOR_CASE,
    2,
    "#fdebce #fdebcf #fdeccf #fdecd1 #fdedd4 #fdefd7 #fdefd8 #fdefd9 #fef0d5 #fef0d7 #fdf0db",
  ),
  // PATH — 보행로(희박)
  ...anchors(Cls.PATH, 1, "#d7d7d7 #dedcd8"),
];

/** 디버그 렌더 색 (ClsId → hex) */
export const CLASS_COLORS: Record<number, string> = {
  [Cls.UNKNOWN]: "#ff00ff",
  [Cls.LAND]: "#f4f1ea",
  [Cls.URBAN]: "#dccbb0",
  [Cls.BUILT]: "#c9a06a",
  [Cls.WATER]: "#3b82f6",
  [Cls.GREEN]: "#22a54a",
  [Cls.OPEN]: "#b8c9b0",
  [Cls.GRAY]: "#9a9a9a",
  [Cls.TRUNK]: "#e11d48",
  [Cls.MAJOR]: "#f97316",
  [Cls.SEC_CASE]: "#f5b400",
  [Cls.MINOR]: "#e5e5e5",
  [Cls.MINOR_CASE]: "#f1dfc4",
  [Cls.PATH]: "#8b5cf6",
};

/* ---------- LUT ---------- */

/** 2^21 버킷 (7bit/채널) */
const LUT_SIZE = 1 << 21;
/** 서로 다른 클래스의 껍질이 겹친 슬롯 → classify에서 UNKNOWN */
const CONFLICT = 0xff;
/** 빌드 중 정확 앵커 표시 비트 (완료 시 제거) */
const EXACT = 0x40;
const CLS_MASK = 0x3f;

const lutCache = new Map<number, Uint8Array>();

function lutKey(r: number, g: number, b: number): number {
  return ((r >> 1) << 14) | ((g >> 1) << 7) | (b >> 1);
}

function parseHex(hex: string): number {
  const v = parseInt(hex.charAt(0) === "#" ? hex.slice(1) : hex, 16);
  if (!Number.isFinite(v)) throw new Error(`palette: bad hex ${hex}`);
  return v;
}

/**
 * 줌별 LUT (메모). 정확 앵커(tol 0)를 먼저 기록하고, 껍질(±tol)은 빈 슬롯에만 쓴다.
 * 정확 앵커 슬롯은 다른 클래스의 껍질이 와도 유지되고, 껍질끼리 다른 클래스가 겹치면 CONFLICT.
 *
 * 예상 충돌쌍(껍질 겹침; 팔레트 수정 시 새 충돌이 생기면 여기 갱신).
 * 2026-09-03 앵커 기준 실제 CONFLICT 슬롯은 z14 18개, z15 20개, z16·17 21개이며 쌍은 다음 4개:
 *   LAND/URBAN     — #faf6f0·#fbf8f3(LAND) ↔ #f9f6ef(z16~17)·#fbf9f4(z15)·#f9f5ee(z14)
 *   MAJOR/SEC_CASE — casing #ffecbe(MAJOR, tol 2) ↔ #ffedc0·#ffeec0(SEC_CASE, tol 2)
 *   GRAY/OPEN      — #dddddc·#dddddd(GRAY) ↔ #dadcd7·#d9ddd7(OPEN)
 *   OPEN/PATH      — #dadcd7·#d9ddd7(OPEN) ↔ #d7d7d7·#dedcd8(PATH)
 * plan이 예상한 BUILT/URBAN은 현재 앵커로는 발생하지 않는다: BUILT(z15+)와 가까운 URBAN 앵커는
 * z14 전용(#f5ede2·#f6f0e7…)이라 같은 줌에서 동시에 활성화되지 않고, z15+ URBAN(#f9f5ed·#fbf9f4·#f9f6ef)은
 * 7bit 버킷에서 BUILT와 떨어져 있다. 정확 앵커는 어떤 경우에도 자기 클래스를 유지한다.
 */
export function buildLut(z: number): Uint8Array {
  const cached = lutCache.get(z);
  if (cached) return cached;

  const lut = new Uint8Array(LUT_SIZE);
  const active = PALETTE.filter((e) => !e.zooms || e.zooms.includes(z));

  // 1) 정확 앵커
  for (let k = 0; k < active.length; k++) {
    const e = active[k];
    const v = parseHex(e.hex);
    const key = lutKey(v >> 16, (v >> 8) & 0xff, v & 0xff);
    const cur = lut[key];
    if (cur === 0) lut[key] = e.cls | EXACT;
    else if (cur !== CONFLICT && (cur & CLS_MASK) !== e.cls) lut[key] = CONFLICT;
  }

  // 2) 껍질 — 빈 슬롯에만; 다른 클래스 껍질과 겹치면 CONFLICT
  for (let k = 0; k < active.length; k++) {
    const e = active[k];
    if (e.tol <= 0) continue;
    const v = parseHex(e.hex);
    const r = v >> 16;
    const g = (v >> 8) & 0xff;
    const b = v & 0xff;
    const cls = e.cls;
    const r0 = Math.max(0, r - e.tol);
    const r1 = Math.min(255, r + e.tol);
    const g0 = Math.max(0, g - e.tol);
    const g1 = Math.min(255, g + e.tol);
    const b0 = Math.max(0, b - e.tol);
    const b1 = Math.min(255, b + e.tol);
    for (let rr = r0; rr <= r1; rr++) {
      for (let gg = g0; gg <= g1; gg++) {
        for (let bb = b0; bb <= b1; bb++) {
          const key = lutKey(rr, gg, bb);
          const cur = lut[key];
          if (cur === 0) lut[key] = cls;
          else if (cur === cls || cur === CONFLICT || (cur & EXACT) !== 0) continue;
          else lut[key] = CONFLICT;
        }
      }
    }
  }

  // 3) 정확 앵커 표시 비트 제거 (앵커 슬롯만 순회)
  for (let k = 0; k < active.length; k++) {
    const v = parseHex(active[k].hex);
    const key = lutKey(v >> 16, (v >> 8) & 0xff, v & 0xff);
    const cur = lut[key];
    if (cur !== CONFLICT && (cur & EXACT) !== 0) lut[key] = cur & CLS_MASK;
  }

  lutCache.set(z, lut);
  return lut;
}

/* ---------- 분류 ---------- */

/**
 * RGBA → 클래스 라벨(out). 반환: 클래스별 픽셀 수(NUM_CLS).
 * alpha<128 → UNKNOWN; max(r,g,b) < GUARD.darkMax → UNKNOWN(어두운 철도선·텍스트);
 * LUT 미스 중 연한 난색(r≥e8, g≥e0, b≥d0, r≥g≥b)만 LAND로 흡수, 나머지·CONFLICT → UNKNOWN.
 */
export function classify(rgba: Uint8ClampedArray, n: number, lut: Uint8Array, out: Uint8Array): Uint32Array {
  const counts = new Uint32Array(NUM_CLS);
  const darkMax = GUARD.darkMax;
  const LAND = Cls.LAND;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    let c = 0;
    if (rgba[p + 3] >= 128) {
      const m = r > g ? (r > b ? r : b) : g > b ? g : b;
      if (m >= darkMax) {
        const v = lut[((r >> 1) << 14) | ((g >> 1) << 7) | (b >> 1)];
        if (v === 0) {
          if (r >= 0xe8 && g >= 0xe0 && b >= 0xd0 && r >= g && g >= b) c = LAND;
        } else if (v !== CONFLICT) {
          c = v;
        }
      }
    }
    out[i] = c;
    counts[c]++;
  }
  return counts;
}

/** 분류된 픽셀 비율 = 1 − UNKNOWN/n (실측 0.94~0.985, <0.4 → 'blank') */
export function classifiedFraction(counts: Uint32Array, n: number): number {
  if (n <= 0) return 0;
  return 1 - counts[Cls.UNKNOWN] / n;
}

/**
 * /dev/seg 용: UNKNOWN 픽셀의 상위 k 색. 4픽셀마다 샘플, alpha<128(결손 타일)은 제외.
 * share = 샘플된 불투명 픽셀 전체 대비 비율.
 */
export function topUnknownColors(
  rgba: Uint8ClampedArray,
  cls: Uint8Array,
  n: number,
  k = 10,
): { hex: string; share: number }[] {
  const counts = new Map<number, number>();
  let sampled = 0;
  for (let i = 0; i < n; i += 4) {
    const p = i * 4;
    if (rgba[p + 3] < 128) continue;
    sampled++;
    if (cls[i] !== Cls.UNKNOWN) continue;
    const key = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const top = sorted.slice(0, Math.max(0, k));
  return top.map(([key, c]) => ({
    hex: "#" + key.toString(16).padStart(6, "0"),
    share: sampled > 0 ? c / sampled : 0,
  }));
}
