import sharp from "sharp";

// Resolve the canvas once for a series. A fixed geometry canvas wins. Individual
// silhouettes never decide the scale or the origin of this grid.
export async function withSeriesPixelGrid(options, paths, sourceIndexes = []) {
  if (!["target", "fixed"].includes(options?.pixelate?.gridMode) || options.pixelate.referenceWidth && options.pixelate.referenceHeight) return options;
  const geometry = options.imageGeometry;
  const fixed = geometry && ["contain", "cover", "stretch"].includes(geometry.mode);
  const sizes = fixed ? [{ width: geometry.width, height: geometry.height }] : await Promise.all(paths.map(async (file, index) => {
    const meta = await sharp(options.frameOverrides?.[sourceIndexes[index] ?? index] || file).metadata();
    return { width: meta.width, height: meta.height };
  }));
  return { ...options, pixelate: { ...options.pixelate,
    referenceWidth: Math.max(...sizes.map(s => s.width)), referenceHeight: Math.max(...sizes.map(s => s.height)) } };
}
