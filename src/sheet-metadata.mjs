// Frame rectangles read from a sprite-sheet manifest that sits next to the image.
// Three shapes exist in the wild: Chuba's own array of frames carrying "name",
// Aseprite's array carrying "filename", and object-style manifests such as
// TexturePacker that key every frame by its file name.

export function frameNameWithoutExtension(value) {
  const base = String(value ?? "").split(/[\\/]/).pop() || "";
  return base.replace(/\.(png|webp|jpe?g|avif|tiff?|gif)$/i, "");
}

export function readSheetFrameRects(manifest) {
  const frames = manifest?.frames;
  const raw = Array.isArray(frames)
    ? frames.map((entry) => ({ name: entry?.name ?? entry?.filename ?? "", entry }))
    : Object.entries(frames || {}).map(([name, entry]) => ({ name, entry }));
  return raw.map(({ name, entry }) => {
    const rect = entry?.frame || entry || {};
    return {
      name: frameNameWithoutExtension(name),
      x: Number(rect.x),
      y: Number(rect.y),
      width: Number(rect.w ?? rect.width ?? manifest?.frameWidth),
      height: Number(rect.h ?? rect.height ?? manifest?.frameHeight),
    };
  }).filter((entry) => [entry.x, entry.y, entry.width, entry.height].every(Number.isFinite));
}

// Give every detected cell the name of the frame rectangle that contains its centre.
export function matchSheetFrameNames(cells, rects) {
  return (cells || []).map((cell) => {
    const centerX = cell.left + cell.width / 2;
    const centerY = cell.top + cell.height / 2;
    const match = (rects || []).find((entry) => centerX >= entry.x && centerX < entry.x + entry.width && centerY >= entry.y && centerY < entry.y + entry.height);
    return match?.name || null;
  });
}
