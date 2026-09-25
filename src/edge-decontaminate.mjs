// A soft edge pixel is a blend of the subject and the background: C = a*F + (1-a)*B.
// Once the frame is placed on a different background, the leftover B reads as a halo —
// the pale rim around fur, hair and thin antennae. Solving the same equation for F
// recovers the subject colour, so no amount of background swapping brings the halo back.
//
// This is arithmetic, not a model: it needs only an estimate of the background colour.

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function decontaminateEdges(data, info, background) {
  const { width, height, channels } = info;
  if (!Array.isArray(background) || background.length < 3) return data;
  const red = clampChannel(background[0]);
  const green = clampChannel(background[1]);
  const blue = clampChannel(background[2]);

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * channels;
    const alpha = data[offset + 3];
    // Fully opaque pixels have nothing to unmix and fully transparent ones have no colour.
    if (alpha === 0 || alpha === 255) continue;
    const ratio = alpha / 255;
    const rest = 1 - ratio;
    data[offset] = clampChannel((data[offset] - rest * red) / ratio);
    data[offset + 1] = clampChannel((data[offset + 1] - rest * green) / ratio);
    data[offset + 2] = clampChannel((data[offset + 2] - rest * blue) / ratio);
  }
  return data;
}
