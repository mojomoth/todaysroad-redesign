import { notFound } from "next/navigation";
import SegDebugView from "./SegDebugView";

/** 개발 전용: 세그멘테이션·정점·루프 시각 디버거 (프로덕션 빌드에서는 404) */
export default function SegDebugPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SegDebugView />;
}
