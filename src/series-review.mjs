import sharp from "sharp";

// Diagnostic only: motion, highlights and occlusion can legitimately change.
// Sample bounded thumbnails serially; never choose or repaint a mask here.
export async function reviewSeries(frames, signal) {
  const samples = [];
  for (const frame of frames) {
    signal?.throwIfAborted();
    const { data } = await sharp(frame.buffer).resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let area = 0, pale = 0;
    for (let o = 0; o < data.length; o += 4) { if (data[o + 3] >= 128) { area++; if (Math.min(data[o], data[o + 1], data[o + 2]) >= 200) pale++; } }
    samples.push({ frameIndex: frame.sourceIndex, area, pale });
  }
  const issues = [];
  for (let i = 1; i + 1 < samples.length; i++) {
    const before = samples[i - 1], here = samples[i], after = samples[i + 1];
    const comparable = (a, b) => Math.abs(a - b) <= Math.max(10, Math.max(a, b) * .15);
    const isolatedDrop = (key) => comparable(before[key], after[key]) && Math.min(before[key], after[key]) >= 40 && here[key] < Math.min(before[key], after[key]) * .6;
    if (isolatedDrop("area") || isolatedDrop("pale")) issues.push({ code: "series-mask-change", frameIndex: here.frameIndex, message: "Резкое уменьшение силуэта или светлых деталей относительно соседних кадров. Проверьте маску; движение тоже может объяснять изменение." });
  }
  return { samples, issues, diagnosticOnly: true };
}
