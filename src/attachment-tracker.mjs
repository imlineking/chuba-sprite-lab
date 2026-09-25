import sharp from "sharp";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Обработка отменена.");
}

async function loadTrackingFrame(filePath) {
  const { data, info } = await sharp(filePath)
    .resize({ width: 420, height: 420, fit: "inside", kernel: sharp.kernel.lanczos3 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function patchError(previous, current, point, candidateX, candidateY, patchRadius) {
  const previousX = Math.round(point.x * (previous.width - 1));
  const previousY = Math.round(point.y * (previous.height - 1));
  let error = 0;
  let samples = 0;
  for (let dy = -patchRadius; dy <= patchRadius; dy += 2) {
    const py = previousY + dy;
    const cy = candidateY + dy;
    if (py < 0 || py >= previous.height || cy < 0 || cy >= current.height) continue;
    for (let dx = -patchRadius; dx <= patchRadius; dx += 2) {
      const px = previousX + dx;
      const cx = candidateX + dx;
      if (px < 0 || px >= previous.width || cx < 0 || cx >= current.width) continue;
      error += Math.abs(previous.data[py * previous.width + px] - current.data[cy * current.width + cx]);
      samples += 1;
    }
  }
  return samples ? error / samples : Infinity;
}

function trackPoint(previous, current, point) {
  const predictedX = Math.round(point.x * (current.width - 1));
  const predictedY = Math.round(point.y * (current.height - 1));
  const patchRadius = 7;
  const searchRadius = Math.max(10, Math.round(Math.max(current.width, current.height) * 0.055));
  let best = { x: predictedX, y: predictedY, score: Infinity };
  for (let y = Math.max(0, predictedY - searchRadius); y <= Math.min(current.height - 1, predictedY + searchRadius); y += 1) {
    for (let x = Math.max(0, predictedX - searchRadius); x <= Math.min(current.width - 1, predictedX + searchRadius); x += 1) {
      const appearance = patchError(previous, current, point, x, y, patchRadius);
      const motionPenalty = Math.hypot(x - predictedX, y - predictedY) * 0.16;
      const score = appearance + motionPenalty;
      if (score < best.score) best = { x, y, score };
    }
  }
  if (!Number.isFinite(best.score) || best.score > 72) return { ...point, confidence: 0 };
  return {
    x: best.x / Math.max(1, current.width - 1),
    y: best.y / Math.max(1, current.height - 1),
    confidence: clamp(1 - best.score / 72, 0, 1),
  };
}

function smoothTrack(track, fixedIndex) {
  return track.map((point, index) => {
    if (!point || index === fixedIndex || !track[index - 1] || !track[index + 1]) return point;
    return {
      ...point,
      x: (track[index - 1].x + point.x * 2 + track[index + 1].x) / 4,
      y: (track[index - 1].y + point.y * 2 + track[index + 1].y) / 4,
    };
  });
}

export async function trackAttachmentPlacements(inputFrames, attachments = [], { onProgress, signal } = {}) {
  if (!attachments.length) return inputFrames.map(() => []);
  const trackingFrames = [];
  for (let index = 0; index < inputFrames.length; index += 1) {
    throwIfAborted(signal);
    trackingFrames.push(await loadTrackingFrame(inputFrames[index]));
    onProgress?.({
      stage: "track-load",
      value: 0.08 + (index + 1) / inputFrames.length * 0.04,
      message: `Готовлю умную привязку · ${index + 1}/${inputFrames.length}`,
    });
  }

  const placements = inputFrames.map(() => []);
  for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
    const attachment = attachments[attachmentIndex];
    const referenceIndex = clamp(Math.round(Number(attachment.frameIndex) || 0), 0, inputFrames.length - 1);
    const pointTracks = [];
    for (const sourcePoint of (attachment.points || []).slice(0, 2)) {
      const track = new Array(inputFrames.length);
      track[referenceIndex] = { x: clamp(Number(sourcePoint.x) || 0, 0, 1), y: clamp(Number(sourcePoint.y) || 0, 0, 1), confidence: 1 };
      for (let index = referenceIndex + 1; index < inputFrames.length; index += 1) {
        throwIfAborted(signal);
        track[index] = trackPoint(trackingFrames[index - 1], trackingFrames[index], track[index - 1]);
      }
      for (let index = referenceIndex - 1; index >= 0; index -= 1) {
        throwIfAborted(signal);
        track[index] = trackPoint(trackingFrames[index + 1], trackingFrames[index], track[index + 1]);
      }
      pointTracks.push(smoothTrack(track, referenceIndex));
    }
    for (let index = 0; index < inputFrames.length; index += 1) {
      placements[index].push({
        id: attachment.id,
        path: attachment.path,
        title: attachment.title,
        sizeRatio: clamp(Number(attachment.sizeRatio) || 0.22, 0.02, 1.5),
        rotation: clamp(Number(attachment.rotation) || 0, -360, 360),
        anchorX: clamp(Number(attachment.anchorX) || 0.5, 0, 1),
        anchorY: clamp(Number(attachment.anchorY) || 0.5, 0, 1),
        referenceDistance: Number(attachment.referenceDistance) || 0,
        referenceAngle: Number(attachment.referenceAngle) || 0,
        points: pointTracks.map((track) => track[index]),
      });
    }
    onProgress?.({
      stage: "track",
      value: 0.12 + (attachmentIndex + 1) / attachments.length * 0.04,
      message: `Отслеживаю PNG-элементы · ${attachmentIndex + 1}/${attachments.length}`,
    });
  }
  return placements;
}

function alphaBounds(data, info, threshold = 12) {
  const { width, height, channels } = info;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels + 3] <= threshold) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export async function compositeAttachments(result, placements = []) {
  if (!placements.length) return result;
  const width = result.info.width;
  const height = result.info.height;
  const overlays = [];
  for (const placement of placements) {
    if (!placement.path || !placement.points?.length) continue;
    const first = placement.points[0];
    const second = placement.points[1];
    const centerX = second ? (first.x + second.x) / 2 : first.x;
    const centerY = second ? (first.y + second.y) / 2 : first.y;
    let scale = 1;
    let angle = placement.rotation;
    if (second) {
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      if (placement.referenceDistance > 0) scale = clamp(distance / placement.referenceDistance, 0.45, 2.4);
      const currentAngle = Math.atan2(second.y - first.y, second.x - first.x) * 180 / Math.PI;
      angle += currentAngle - placement.referenceAngle;
    }
    const targetWidth = Math.max(4, Math.round(width * placement.sizeRatio * scale));
    let transformed = await sharp(placement.path)
      .ensureAlpha()
      .resize({ width: targetWidth, withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
      .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const metadata = await sharp(transformed).metadata();
    const overlayWidth = metadata.width || targetWidth;
    const overlayHeight = metadata.height || targetWidth;
    let left = Math.round(centerX * (width - 1) - overlayWidth * placement.anchorX);
    let top = Math.round(centerY * (height - 1) - overlayHeight * placement.anchorY);
    const cropLeft = Math.max(0, -left);
    const cropTop = Math.max(0, -top);
    const visibleWidth = Math.min(overlayWidth - cropLeft, width - Math.max(0, left));
    const visibleHeight = Math.min(overlayHeight - cropTop, height - Math.max(0, top));
    if (visibleWidth <= 0 || visibleHeight <= 0) continue;
    if (cropLeft || cropTop || visibleWidth < overlayWidth || visibleHeight < overlayHeight) {
      transformed = await sharp(transformed).extract({ left: cropLeft, top: cropTop, width: visibleWidth, height: visibleHeight }).png().toBuffer();
      left = Math.max(0, left);
      top = Math.max(0, top);
    }
    overlays.push({ input: transformed, left, top });
  }
  if (!overlays.length) return result;
  const buffer = await sharp(result.buffer).composite(overlays).png().toBuffer();
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ...result, buffer, info, bounds: alphaBounds(data, info) };
}
