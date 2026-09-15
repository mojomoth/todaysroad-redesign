/**
 * 세그멘테이션 워커 셸: RGBA 버퍼를 받아 순수 파이프라인을 돌리고 결과를 돌려준다.
 * 모든 메시지에 jobToken을 실어 오래된 잡의 메시지가 새 잡에 섞이지 않게 한다.
 */
import { runPipeline } from "./pipeline";
import { RouteError, type WorkerIn, type WorkerOut } from "./types";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(out: WorkerOut) {
  ctx.postMessage(out);
}

ctx.addEventListener("message", (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (!m || m.type !== "run") return;
  try {
    const result = runPipeline(m.input, m.rgba, m.missing, m.elev, (phase) =>
      post({ type: "phase", token: m.token, phase })
    );
    post({ type: "result", token: m.token, result });
  } catch (err) {
    post({
      type: "error",
      token: m.token,
      reason: err instanceof RouteError ? err.reason : "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
