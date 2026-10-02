// Compare existing corpus runs with identical input hashes, without rerunning models.
// node scripts/compare-cleanup-tools.mjs <new-output-directory> <run-directory> ...
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
const output = path.resolve(process.argv[2]);
const directories = process.argv.slice(3).map(directory => path.resolve(directory));
assert.ok(directories.length >= 2, "Нужны минимум два прогона");
const runs = await Promise.all(directories.map(async directory => ({ directory,
  report: JSON.parse(await fs.readFile(path.join(directory, "report.json"), "utf8")) })));
await fs.mkdir(output);
const names = runs[0].report.cases.map(item => item.name);
for (const run of runs) {
  assert.deepEqual(run.report.cases.map(item => item.name), names, "Разные наборы входов");
  for (const [index, item] of run.report.cases.entries()) assert.equal(item.beforeHash, runs[0].report.cases[index].beforeHash, "Разные исходные пиксели");
}
const relative = file => path.relative(output, file).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
const escaped = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const label = mode => ({ confirmed: "Встроенная очистка · палитра подтверждена", toonout: "ToonOut", "birefnet-tiny": "BiRefNet Tiny" }[mode] || mode);
const preview = (run, item, backdrop, before = false) => relative(path.join(run.directory,
  item.previews.find(p => p.title === backdrop).images[before ? 0 : 1]));
const summaries = runs.map(run => ({ mode: run.report.mode, totalMs: run.report.cases.reduce((sum, item) => sum + item.ms, 0),
  cases: run.report.cases.map(item => ({ name: item.name, ms: item.ms, changed: item.changed, removed: item.removed, issues: item.issues })) }));
await fs.writeFile(path.join(output, "comparison.json"), JSON.stringify({ sameInputs: true, groundTruth: false, summaries }, null, 2));
await fs.writeFile(path.join(output, "review.html"), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Сравнение инструментов очистки</title><style>body{font:16px system-ui;background:#f3f3f3;color:#202020;margin:24px}h1{font-size:28px}p{line-height:1.5}section{margin:24px 0;padding:20px;background:white;border:1px solid #d5d5d5;border-radius:14px}.grid{display:grid;grid-template-columns:repeat(${runs.length + 1},minmax(0,1fr));gap:12px}figure{margin:0;min-width:0}figcaption{min-height:44px;font-size:13px;font-weight:700}img{width:100%;height:300px;object-fit:contain;background:#101010;image-rendering:pixelated}small{display:block;margin-top:8px;line-height:1.5}select{padding:8px}table{border-collapse:collapse}td,th{padding:8px 16px;text-align:left;border-bottom:1px solid #ccc}@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}</style><h1>Одни файлы · три способа очистки</h1><p>SHA-256 всех входов совпадает. Счётчики показывают изменения, а не точность. Встроенный режим использует подтверждённую палитру; белые цветы и пятна грибов защищены. Модели запускаются явно. Время — отдельные проходы на текущем ПК, не универсальный рейтинг.</p><label>Подложка <select id="backdrop"><option value="black">Чёрная</option><option value="white">Белая</option><option value="magenta">Маджента</option></select></label><table><tr><th>Способ</th><th>Время всех ${names.length} файлов</th></tr>${summaries.map(item => `<tr><td>${escaped(label(item.mode))}</td><td>${(item.totalMs / 1000).toFixed(2)} с</td></tr>`).join("")}</table>${names.map((name, index) => `<section><h2>${escaped(name)}</h2><div class="grid"><figure><figcaption>Исходник</figcaption><img ${["black", "white", "magenta"].map(b => `data-${b}="${preview(runs[0], runs[0].report.cases[index], b, true)}"`).join(" ")} src="${preview(runs[0], runs[0].report.cases[index], "black", true)}" alt="Исходник"></figure>${runs.map(run => { const item = run.report.cases[index]; return `<figure><figcaption>${escaped(label(run.report.mode))}</figcaption><img ${["black", "white", "magenta"].map(b => `data-${b}="${preview(run, item, b)}"`).join(" ")} src="${preview(run, item, "black")}" alt="${escaped(label(run.report.mode))}"><small>${item.ms} мс · изменено ${item.changed} px<br>${escaped(item.warnings.join(" ") || "Требуется визуальная проверка.")}</small></figure>`; }).join("")}</div></section>`).join("")}<script>document.querySelector('#backdrop').addEventListener('change',event=>{document.querySelectorAll('img').forEach(img=>{img.src=img.dataset[event.target.value];img.style.background=event.target.value==='white'?'#fff':event.target.value==='magenta'?'#ed00a9':'#101010';});});</script></html>`);
// A compact raster sheet for inspecting all results outside a browser.
const rows = [];
for (const [index, name] of names.entries()) {
  const cells = [path.join(runs[0].directory, runs[0].report.cases[index].previews[0].images[0]),
    ...runs.map(run => path.join(run.directory, run.report.cases[index].previews[0].images[1]))];
  for (const [column, cell] of cells.entries()) {
    const labelText = column ? label(runs[column - 1].report.mode) : "Исходник";
    const text = Buffer.from(`<svg width="300" height="42"><rect width="300" height="42" fill="white"/><text x="8" y="14" font-size="11">${escaped(name)}</text><text x="8" y="32" font-size="11">${escaped(labelText)}</text></svg>`);
    rows.push({ input: text, left: column * 300, top: index * 302 });
    rows.push({ input: await sharp(cell).resize(300, 260, { fit: "contain", background: "#101010" }).png().toBuffer(), left: column * 300, top: index * 302 + 42 });
  }
}
await sharp({ create: { width: 300 * (runs.length + 1), height: names.length * 302, channels: 3, background: "white" } }).composite(rows).png().toFile(path.join(output, "comparison.png"));
console.log(JSON.stringify(summaries.map(item => ({ mode: item.mode, totalMs: item.totalMs }))));
