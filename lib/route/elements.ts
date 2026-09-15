import { ELEMENT_CATEGORIES, type MapElement } from "./types";

export const ELEMENT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["elements"],
  properties: {
    elements: {
      type: "array", maxItems: 80,
      items: {
        type: "object", additionalProperties: false,
        required: ["kind", "category", "label", "x", "y", "width", "height", "confidence"],
        properties: {
          kind: { type: "string", enum: ["nature", "building", "icon"] },
          category: { type: "string", enum: [...ELEMENT_CATEGORIES] },
          label: { type: "string" },
          x: { type: "number" }, y: { type: "number" },
          width: { type: "number" }, height: { type: "number" },
          confidence: { type: "number" },
        },
      },
    },
  },
};

/** 모델의 정규화 박스(0..1)를 검증하고 원본 픽셀 좌표로 변환한다. */
export function parseElements(value: unknown, width: number, height: number): MapElement[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { elements?: unknown }).elements)) throw new Error("invalid elements");
  const raw = (value as { elements: unknown[] }).elements;
  if (raw.length > 80) throw new Error("too many elements");
  const out: MapElement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (!["nature", "building", "icon"].includes(String(e.kind)) || !ELEMENT_CATEGORIES.includes(e.category as MapElement["category"])) continue;
    if (typeof e.label !== "string" || e.label.length > 100) continue;
    const values = [e.x, e.y, e.width, e.height, e.confidence];
    if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) continue;
    const [x, y, w, h, confidence] = values as number[];
    if (x < 0 || y < 0 || x >= 1 || y >= 1 || w <= 0 || h <= 0 || x + w > 1.001 || y + h > 1.001 || confidence < 0.8 || confidence > 1) continue;
    const category = e.category as MapElement["category"];
    if (category === "cafe" && e.kind !== "icon" && e.kind !== "building") continue;
    const bounds = { x: x * width, y: y * height, width: Math.min(w, 1 - x) * width, height: Math.min(h, 1 - y) * height };
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    if (out.some((p) => p.category === category && Math.hypot(p.x - cx, p.y - cy) < 12)) continue;
    out.push({ id: `image-${out.length}`, kind: e.kind as MapElement["kind"], category, label: e.label.trim(), x: cx, y: cy, bounds, confidence });
  }
  return out;
}
