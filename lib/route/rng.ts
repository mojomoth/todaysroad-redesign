/**
 * 시드 난수 — sfc32 (상태 4워드), 시드는 splitmix32로 확장.
 * 모든 확률적 선택(밴드 중심·섹터 각·softmax 룰렛·진행 방향)은 이 스트림 하나만 쓴다.
 * 같은 seed → 같은 수열 (워커·Node·브라우저 동일: Math.imul/>>> 정수 연산만 사용).
 */
import type { Rng } from "./types";

/** splitmix32: 32비트 시드에서 상태 워드를 뽑는다 */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function createRng(seed: number): Rng {
  const sm = splitmix32(seed);
  let a = sm() | 0;
  let b = sm() | 0;
  let c = sm() | 0;
  let d = sm() | 0;

  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  // 초기 상태 상관 제거용 워밍업 (sfc32 권장 12회)
  for (let i = 0; i < 12; i++) next();

  return {
    next,
    int: (n: number): number => Math.floor(next() * n),
    bool: (p = 0.5): boolean => next() < p,
    range: (lo: number, hi: number): number => lo + (hi - lo) * next(),
  };
}

/** FNV-1a 32비트 (문자열 → 시드) */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
