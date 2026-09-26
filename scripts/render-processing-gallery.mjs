import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
const game = path.resolve(process.argv[2]), root = path.resolve(process.argv[3]), bzzz = path.resolve(process.argv[4]);
const html = [];
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character]));
async function panel(name, items, columns = 4, w = 480, h = 300) {
  const pieces = [], rowHeight = h + 36;
  for (const [index, [title, file]] of items.entries()) {
    const left = index % columns * w, top = Math.floor(index / columns) * rowHeight;
    const image = await sharp(file).flatten({ background: "#53bda8" }).resize(w - 16, h - 16, { fit: "contain", background: "#53bda8", kernel: "nearest" }).png().toBuffer();
    pieces.push({ input: image, left: left + 8, top: top + 44 });
    pieces.push({ input: Buffer.from(`<svg width="${w}" height="36"><rect width="${w}" height="36" fill="#15232d"/><text x="10" y="24" font-size="17" fill="white" font-family="Segoe UI">${escape(title)}</text></svg>`), left, top });
  }
  const file = path.join(root, `${name}.png`);
  await sharp({ create: { width: columns * w, height: Math.ceil(items.length / columns) * rowHeight, channels: 3, background: "#53bda8" } }).composite(pieces).png().toFile(file);
  html.push(`<section><h2>${escape(name)}</h2><a href="${name}.png"><img src="${name}.png"></a></section>`);
}
const photo = path.join(game, "public/images/NEW sprites/Varyag/references/gudkov-indoor-front.jpeg");
await panel("portrait-matting-comparison", [["Original photo", photo], ["U2-Net small", path.join(root, "photo-u2netp.png")], ["U2-Net portrait", path.join(root, "photo-u2net-portrait.png")], ["BiRefNet Tiny", path.join(root, "photo-birefnet-tiny.png")], ["BiRefNet portrait", path.join(root, "photo-birefnet-portrait.png")], ["ToonOut", path.join(root, "toonout/photo.png")]], 3, 440, 420);
await panel("portrait-styles-comparison", [["Original photo", photo], ...["clean", "shaded", "outline", "lineart", "stitch"].map(name => [name, path.join(root, `portrait-best-${name}.png`)]), ["Tuned: clean, 48 colours, 4px", path.join(root, "portrait-best-tuned-clean.png")], ["Tuned: shaded, 8 steps", path.join(root, "portrait-best-tuned-shaded.png")]], 4, 420, 400);
for (const [id, original] of [["bzzz", bzzz], ["branch", path.join(game, "new assets/branch_leaves_hanging_01.png")], ["white-flowers", path.join(game, "new assets/flower_white.png")]]) {
  await panel(`${id}-comparison`, [["Original", original], [id === "branch" ? "Checker tool" : "Colour: contour", path.join(root, `${id}-${id === "branch" ? "checker" : "contour"}.png`)], ["U2-Net small", path.join(root, `${id}-u2netp.png`)], ["BiRefNet Tiny", path.join(root, `${id}-birefnet-tiny.png`)], ["ToonOut", path.join(root, `toonout/${id}.png`)]], 3, 650, id === "bzzz" ? 265 : 400);
}
for (const id of ["white-controlled", "checker-controlled"]) {
  await panel(`${id}-comparison`, [["Known foreground alpha", path.join(root, "inputs/flowers-truth.png")], ["Composite input", path.join(root, `inputs/flowers-${id.startsWith("white") ? "white" : "checker"}.png`)], [id.startsWith("white") ? "Colour: contour" : "Checker tool", path.join(root, `${id}-${id.startsWith("white") ? "contour" : "checker"}.png`)], ["U2-Net small", path.join(root, `${id}-u2netp.png`)], ["BiRefNet Tiny", path.join(root, `${id}-birefnet-tiny.png`)], ["ToonOut", path.join(root, `toonout/${id}.png`)]], 3, 360, 420);
}
const main = JSON.parse(await fs.readFile(path.join(root, "report.json"), "utf8"));
for (const id of ["atlas-mixed", "video-pig", "animation-yarn"]) {
  const result = main.workflows.find(item => item.id === id).plans[0];
  const items = [["Exported atlas PNG", result.sheet], ...result.frames.slice(0, 5).map((file, index) => [`Frame ${index + 1}`, file])];
  await panel(`${id}-frames`, items, 3, 460, id === "video-pig" ? 460 : 340);
  if (result.preview) { html.push(`<section><h2>${escape(id)} · actual WebP animation</h2><img class="animation" src="${path.relative(root, result.preview).replaceAll("\\", "/")}"></section>`); }
}
await panel("auxiliary-comparison", [["RIFE intermediate", path.join(root, "aux-rife.png")], ["Real-ESRGAN 4x", path.join(root, "aux-real-esrgan.png")], ["Depth Anything V2", path.join(root, "aux-depth-anything-v2.png")], ["LaMa masked removal", path.join(root, "aux-lama.png")]], 2, 480, 400);
await panel("auxiliary-quality-comparison", [["Small input (96px)", path.join(root, "inputs/photo-small-quality.png")], ["Regular Lanczos 4x", path.join(root, "aux-resize-baseline.png")], ["Real-ESRGAN 4x", path.join(root, "aux-quality-real-esrgan.png")], ["Depth: original photo", path.join(root, "aux-quality-depth-anything-v2.png")], ["Before: door handle", path.join(root, "inputs/photo-320.png")], ["LaMa: handle removed", path.join(root, "aux-quality-lama.png")]], 3, 440, 420);
await panel("lama-detail", await Promise.all([["Before", "inputs/photo-320.png"], ["After LaMa", "aux-quality-lama.png"]].map(async ([title, file]) => [title, await sharp(path.join(root, file)).extract({ left: 5, top: 205, width: 75, height: 60 }).png().toBuffer()])), 2, 600, 480);
await panel("automatic-portrait-comparison", [["Original", photo], ["Actual automatic plan", path.join(root, "portrait-automatic.png")], ["Manual: portrait + clean", path.join(root, "portrait-best-tuned-clean.png")]], 3, 440, 420);
const videos = JSON.parse(await fs.readFile(path.join(root, "video-auto-report.json"), "utf8"));
await panel("video-cut-comparison", [["Original video frame", main.workflows.find(item => item.id === "video-pig").plans[0].frames[0]], ...videos.cases.filter(item => item.id.startsWith("video-cut")).map(item => [item.id, item.result.framePaths[0]]), ["Paper: green background removed", videos.cases.find(item => item.id === "paper-clean").result.framePaths[0]]], 4, 420, 520);
const sourceTruth = await sharp(path.join(root, "inputs/flowers-truth.png")).ensureAlpha().raw().toBuffer();
const scores = [];
for (const id of ["white-controlled", "checker-controlled"]) {
  const actual = await sharp(path.join(root, `toonout/${id}.png`)).ensureAlpha().raw().toBuffer();
  let union = 0, intersection = 0, white = 0, retained = 0;
  for (let o = 0; o < actual.length; o += 4) { const a = actual[o + 3] > 127, b = sourceTruth[o + 3] > 127; if (a || b) union++; if (a && b) intersection++; if (b && Math.min(sourceTruth[o], sourceTruth[o + 1], sourceTruth[o + 2]) > 230) { white++; if (a) retained++; } }
  scores.push({ id, tool: "toonout", iou: intersection / union, whitePixels: white, whiteDetailRecall: retained / white });
}
await fs.writeFile(path.join(root, "toonout-controlled-metrics.json"), JSON.stringify(scores, null, 2));
await fs.writeFile(path.join(root, "gallery.html"), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Sprite Lab · реальные тесты</title><style>body{margin:0;padding:32px;background:#f3f5f7;color:#19232e;font:16px/1.5 system-ui}main{max-width:1500px;margin:auto}section{margin:28px 0;padding:20px;background:white;border-radius:12px}img{max-width:100%;height:auto}.animation{max-height:520px;max-width:700px}h1,h2{line-height:1.2}</style><main><h1>Sprite Lab: реальные результаты обработки</h1><p>Бирюзовый фон — подложка просмотра. Сравниваются исходники и фактические PNG. Оригиналы не изменены.</p>${html.join("\n")}</main></html>`);
console.log(JSON.stringify(scores));
