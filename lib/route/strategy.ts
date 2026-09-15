import { FEAT, type Candidate, type RouteStrategy } from "./types";

/** 장소 유형은 이미지 증거로 필터링하고 분위기는 주변 형태의 대리 지표로만 사용한다. */
export function matchingTags(c: Candidate, tags: string[]): string[] {
  const f = c.f;
  const category = c.element?.category;
  return tags.filter((tag) => {
    switch (tag) {
      case "nature": return c.kind === "green" || category === "green" || category === "mountain" || f[FEAT.green] >= 0.12;
      case "river": return c.kind === "shore" || category === "water" || f[FEAT.waterNear] > 0;
      case "urban": return c.kind === "built" || category === "building" || category === "culture" || f[FEAT.built] >= 0.1;
      case "cafe": return category === "cafe"; // 건물이 많다는 이유로 카페를 만들어내지 않는다.
      case "hill": return category === "mountain" || f[FEAT.elevGain] >= 0.15;
      case "flat": return f[FEAT.slope] >= 0 && f[FEAT.slope] < 0.08;
      case "alley": return f[FEAT.thin] > 0 && f[FEAT.major] < 0.1;
      case "quiet": return (f[FEAT.green] >= 0.1 || f[FEAT.path] > 0) && f[FEAT.major] < 0.08;
      case "lively": return category === "shop" || category === "culture" || (f[FEAT.built] >= 0.1 && f[FEAT.major] + f[FEAT.secondary] > 0);
      case "night": return f[FEAT.waterNear] > 0 || f[FEAT.built] >= 0.1;
      default: return false;
    }
  });
}

export function filterCandidates(candidates: Candidate[], tags: string[]): { candidates: Candidate[]; strategy: RouteStrategy } {
  const requestedTags = [...new Set(tags)];
  const filtered = candidates.filter((c) => {
    c.matchedTags = matchingTags(c, requestedTags);
    return requestedTags.length === 0 || c.matchedTags.length > 0;
  });
  const matchedTags = requestedTags.filter((tag) => filtered.some((c) => c.matchedTags?.includes(tag)));
  return {
    candidates: filtered,
    strategy: {
      requestedTags,
      candidateCount: candidates.length,
      filteredCount: filtered.length,
      matchedTags,
      missingTags: requestedTags.filter((tag) => !matchedTags.includes(tag)),
    },
  };
}
