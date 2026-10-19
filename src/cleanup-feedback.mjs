import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { analyseAlphaResidue } from './alpha-residue.mjs';
import { refineEdgeRgba } from './edge-refine.mjs';

export function compareCleanupPixels(before, after) {
  if (before.length !== after.length) throw new Error('Сравниваемые RGBA имеют разный размер.');
  let changed = 0, alphaChanged = 0, rgbChanged = 0, alphaLowered = 0, alphaRaised = 0;
  for (let p = 0; p < before.length; p += 4) {
    const alpha = before[p + 3] !== after[p + 3];
    const rgb = (before[p + 3] || after[p + 3]) && (before[p] !== after[p] || before[p + 1] !== after[p + 1] || before[p + 2] !== after[p + 2]);
    if (alpha || rgb) changed++;
    if (alpha) alphaChanged++;
    if (rgb) rgbChanged++;
    if (before[p + 3] > after[p + 3]) alphaLowered++;
    if (before[p + 3] < after[p + 3]) alphaRaised++;
  }
  return { changed, alphaChanged, rgbChanged, alphaLowered, alphaRaised, alphaPreserved: alphaChanged === 0 };
}

// A single RGB-only trial. No repeated inference, erosion or generated pixels.
export function proposeContourRetry(input, info, { depth = 5, protect = true } = {}) {
  const before = analyseAlphaResidue(input, info, { masks: true });
  const after = refineEdgeRgba(input, info, { mode: 'recolor', width: 1, depth, whiteOnly: true,
    whiteThreshold: 175, neutralTolerance: 45, preserveLightArtwork: protect });
  const evidence = analyseAlphaResidue(after, info);
  const change = compareCleanupPixels(input, after);
  const accepted = change.changed > 0 && change.alphaPreserved && evidence.neutralEdgePixels < before.neutralEdgePixels;
  return { data: accepted ? after : Buffer.from(input), report: { attempted: true, accepted, attempts: 1,
    beforeNeutralEdge: before.neutralEdgePixels, afterNeutralEdge: evidence.neutralEdgePixels, ...change,
    reason: accepted ? 'RGB кромки изменён; альфа и защищённые светлые детали сохранены. Сравните с первым проходом.' : 'Пробный проход не улучшил измерение кромки. Оставлен первый результат.', reviewRequired: accepted } };
}

export async function boundedContourRetry(preview, { enabled, depth, protect = true, signal } = {}) {
  if (!enabled) return { preview, report: { attempted: false, accepted: false, attempts: 0 } };
  signal?.throwIfAborted();
  const raw = await sharp(preview.afterPath).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const evidence = analyseAlphaResidue(raw.data, raw.info);
  if (evidence.neutralEdgePixels < 4) return { preview, report: { attempted: false, accepted: false, attempts: 0, reason: 'Нет измеримого светлого края для дополнительного прохода.' } };
  const trial = proposeContourRetry(raw.data, raw.info, { depth, protect });
  signal?.throwIfAborted();
  if (!trial.report.accepted) return { preview, report: trial.report };
  const afterPath = path.join(path.dirname(preview.afterPath), 'after-edge-retry.png');
  await sharp(trial.data, { raw: raw.info }).png().toFile(afterPath);
  await fs.access(preview.afterPath); // The first candidate remains available for comparison.
  return { preview: { ...preview, afterPath }, firstPath: preview.afterPath, report: trial.report };
}
