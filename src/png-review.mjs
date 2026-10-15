import path from "node:path";
import { reviewMatteFile } from "./matte-review.mjs";
import { writeJsonAtomic } from "./conveyor.mjs";

// Technical observations only: white eyes and soft edges are never erased here.
export async function reviewPngs(cleaned, preset) {
  const started = performance.now(), metrics = [], issues = [];
  for (const [frameIndex, file] of (cleaned.framePaths || []).entries()) {
    const m = await reviewMatteFile(file); metrics.push({ file, ...m });
    const add = (severity, code, reason, regions = []) => issues.push({ severity, code, reason, source: "algorithm", target: { frame: path.basename(file), frameIndex }, regions });
    if (!m.bounds) add("error", "empty_png", "Изображение практически прозрачно: проверьте маску.");
    else {
      if (!m.clear && !m.partial && preset.background !== "none") add("warning", "opaque_png", "Результат полностью непрозрачен. Проверьте, удалён ли нужный фон.");
      if (m.innerPartial) add("info", "inner_alpha", `Внутри рисунка ${m.innerPartial} полупрозрачных пикселей. Это может быть частью рисунка; проверьте на разных подложках.`, m.regions.innerPartial);
      if (m.palePartial) add("info", "pale_alpha", `Светлых полупрозрачных пикселей: ${m.palePartial}. Мягкий край допустим; это не доказательство ореола. Показано до 96 участков.`, m.regions.palePartial);
      if (m.touchesCanvas) add("info", "canvas_edge", "Рисунок касается края холста. Проверьте полноту формы; касание само по себе не означает обрезку.", [ { left: 0, top: 0, width: m.width, height: 1 }, { left: 0, top: m.height - 1, width: m.width, height: 1 }, { left: 0, top: 0, width: 1, height: m.height }, { left: m.width - 1, top: 0, width: 1, height: m.height } ]);
    }
  }
  if (!metrics.length) issues.push({ severity: "error", code: "missing_png", reason: "Нет PNG для проверки.", source: "algorithm" });
  const verdict = issues.some(i => i.severity === "error") ? "rejected" : issues.some(i => i.severity === "warning") ? "needs_fix" : "accepted";
  const review = { kind: "png", mode: "algorithms", verdict, verdictLabel: { accepted: "Техническая проверка пройдена", needs_fix: "Проверьте результат", rejected: "Нужны исправления" }[verdict], score: verdict === "rejected" ? 0 : verdict === "needs_fix" ? 70 : 100, elapsedMs: Math.round(performance.now() - started), issues, metrics, summary: "Проверены сохранённые PNG. Художественное качество и полнота исходной формы требуют визуального просмотра. Пиксели не изменялись." };
  if (cleaned.outputDir) await writeJsonAtomic(path.join(cleaned.outputDir, "png-review.json"), review);
  return review;
}
