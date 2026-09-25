// Artistic conversion of a frame into pixel art. Everything here is pure pixel arithmetic on a raw
// RGBA buffer, so it is testable without image files and works identically in the preview, in the
// export and from the command line.
//
// The look of pixel art comes from three separate decisions, and mixing them up is why naive
// "pixelate" filters look like a small blurry photo instead of a sprite:
//   1. the grid the image is reduced to,
//   2. the palette and how the remaining colours are chosen,
//   3. the drawing convention: flat shading steps, a contour, or ink lines.

export const pixelPalettes = {
  gameboy: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  pico8: ["#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8", "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa"],
  c64: ["#000000", "#ffffff", "#880000", "#aaffee", "#cc44cc", "#00cc55", "#0000aa", "#eeee77", "#dd8855", "#664400", "#ff7777", "#333333", "#777777", "#aaff66", "#0088ff", "#bbbbbb"],
  cga: ["#000000", "#55ffff", "#ff55ff", "#ffffff"],
  zx: ["#000000", "#0000d7", "#d70000", "#d700d7", "#00d700", "#00d7d7", "#d7d700", "#d7d7d7"],
  grayscale4: ["#000000", "#555555", "#aaaaaa", "#ffffff"],
  grayscale16: Array.from({ length: 16 }, (_value, index) => {
    const level = index.toString(16).padStart(2, "0");
    return `#${level}${level}${level}`;
  }),
};

export const pixelModes = ["clean", "shaded", "outline", "lineart", "stitch"];
export const pixelDithers = ["none", "bayer2", "bayer4", "bayer8", "floyd", "atkinson"];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bayerMatrix(order) {
  if (order <= 1) return [[0]];
  const half = bayerMatrix(order / 2);
  const size = half.length;
  const matrix = Array.from({ length: size * 2 }, () => new Array(size * 2).fill(0));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const base = half[y][x] * 4;
      matrix[y][x] = base;
      matrix[y][x + size] = base + 2;
      matrix[y + size][x] = base + 3;
      matrix[y + size][x + size] = base + 1;
    }
  }
  return matrix;
}

const BAYER = { 2: bayerMatrix(2), 4: bayerMatrix(4), 8: bayerMatrix(8) };

export function hexToColor(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
  return match ? [1, 2, 3].map((index) => Number.parseInt(match[index], 16)) : null;
}

export function resolvePalette(name) {
  const requested = String(name || "auto");
  const known = Object.keys(pixelPalettes);
  if (requested === "auto" || !known.includes(requested)) return null;
  return pixelPalettes[requested].map((hex) => hexToColor(hex)).filter(Boolean);
}

// Median cut: repeatedly split the colour cloud along its widest channel. Cheap, deterministic and
// good enough that the result reads as a deliberate palette rather than as noise.
export function medianCutPalette(colors, count) {
  if (!colors.length) return [[0, 0, 0]];
  let boxes = [colors];
  while (boxes.length < count) {
    let target = -1;
    let widest = -1;
    let channel = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (let axis = 0; axis < 3; axis += 1) {
        let min = 255;
        let max = 0;
        for (const color of box) {
          if (color[axis] < min) min = color[axis];
          if (color[axis] > max) max = color[axis];
        }
        if (max - min > widest) {
          widest = max - min;
          target = index;
          channel = axis;
        }
      }
    });
    if (target < 0) break;
    const box = boxes[target];
    box.sort((left, right) => left[channel] - right[channel]);
    const middle = Math.floor(box.length / 2);
    boxes = [
      ...boxes.slice(0, target),
      box.slice(0, middle),
      box.slice(middle),
      ...boxes.slice(target + 1),
    ];
  }
  return boxes.filter((box) => box.length).map((box) => {
    const total = box.reduce((sum, color) => [sum[0] + color[0], sum[1] + color[1], sum[2] + color[2]], [0, 0, 0]);
    return total.map((value) => Math.round(value / box.length));
  });
}

function nearestColor(palette, red, green, blue) {
  let best = palette[0];
  let bestDistance = Infinity;
  for (const color of palette) {
    const dr = red - color[0];
    const dg = green - color[1];
    const db = blue - color[2];
    // Roughly perceptual weights: the eye is far more sensitive to green than to blue.
    const distance = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color;
    }
  }
  return best;
}

function posterizeLevel(value, steps) {
  if (steps < 2) return value;
  return Math.round(Math.round((value / 255) * (steps - 1)) / (steps - 1) * 255);
}

// Reduces the frame to a small grid. Cell boundaries are computed so every source pixel belongs to
// exactly one cell, which avoids the seams a naive `width / size` division produces.
function toGrid(data, info, gridWidth, gridHeight, options) {
  const { width, height, channels } = info;
  const grid = Buffer.alloc(gridWidth * gridHeight * 4);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    const top = Math.floor((gy * height) / gridHeight);
    const bottom = Math.max(top + 1, Math.floor(((gy + 1) * height) / gridHeight));
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const left = Math.floor((gx * width) / gridWidth);
      const right = Math.max(left + 1, Math.floor(((gx + 1) * width) / gridWidth));
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let count = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * width + x) * channels;
          const weight = data[offset + 3] / 255;
          red += data[offset] * weight;
          green += data[offset + 1] * weight;
          blue += data[offset + 2] * weight;
          alpha += data[offset + 3];
          count += 1;
        }
      }
      const offset = (gy * gridWidth + gx) * 4;
      const weight = count || 1;
      // Colour is averaged with transparency as weight, otherwise the transparent background drags
      // the subject towards black and the sprite acquires a dark fringe.
      const alphaWeight = alpha > 0 ? alpha / 255 : 1;
      grid[offset] = clamp(Math.round(red / Math.max(1, alphaWeight)), 0, 255);
      grid[offset + 1] = clamp(Math.round(green / Math.max(1, alphaWeight)), 0, 255);
      grid[offset + 2] = clamp(Math.round(blue / Math.max(1, alphaWeight)), 0, 255);
      grid[offset + 3] = Math.round(alpha / weight);
      if (options.shadingSteps > 1) {
        grid[offset] = posterizeLevel(grid[offset], options.shadingSteps);
        grid[offset + 1] = posterizeLevel(grid[offset + 1], options.shadingSteps);
        grid[offset + 2] = posterizeLevel(grid[offset + 2], options.shadingSteps);
      }
    }
  }
  return grid;
}

function quantize(grid, gridWidth, gridHeight, palette, dither, strength = 0.75) {
  const size = gridWidth * gridHeight;
  const output = Buffer.from(grid);
  const spread = dither.startsWith("bayer") ? 48 : 0;
  const matrix = spread ? BAYER[Number(dither.slice(5))] : null;
  const order = matrix ? matrix.length : 0;

  const quantizeAt = (index, red, green, blue) => {
    const color = nearestColor(palette, clamp(red, 0, 255), clamp(green, 0, 255), clamp(blue, 0, 255));
    output[index * 4] = color[0];
    output[index * 4 + 1] = color[1];
    output[index * 4 + 2] = color[2];
    return color;
  };

  if (dither === "floyd" || dither === "atkinson") {
    // Error diffusion needs a float scratch buffer, otherwise rounding kills the effect.
    const scratch = Float32Array.from({ length: size * 3 });
    for (let index = 0; index < size; index += 1) {
      scratch[index * 3] = grid[index * 4];
      scratch[index * 3 + 1] = grid[index * 4 + 1];
      scratch[index * 3 + 2] = grid[index * 4 + 2];
    }
    const weights = dither === "floyd"
      ? [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
      : [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]];
    for (let y = 0; y < gridHeight; y += 1) {
      for (let x = 0; x < gridWidth; x += 1) {
        const index = y * gridWidth + x;
        const red = scratch[index * 3];
        const green = scratch[index * 3 + 1];
        const blue = scratch[index * 3 + 2];
        const color = quantizeAt(index, red, green, blue);
        const errorRed = red - color[0];
        const errorGreen = green - color[1];
        const errorBlue = blue - color[2];
        for (const [dx, dy, weight] of weights) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
          const target = (ny * gridWidth + nx) * 3;
          // The error is deliberately damped: passing all of it on with a saturated hardware palette
          // scatters single colourful pixels instead of shading.
          scratch[target] += errorRed * weight * strength;
          scratch[target + 1] += errorGreen * weight * strength;
          scratch[target + 2] += errorBlue * weight * strength;
        }
      }
    }
    return output;
  }

  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      const index = y * gridWidth + x;
      let red = grid[index * 4];
      let green = grid[index * 4 + 1];
      let blue = grid[index * 4 + 2];
      if (matrix) {
        // Ordered dithering: a fixed threshold pattern instead of random noise, which is what gives
        // the recognisable checkered look of old hardware.
        const threshold = ((matrix[y % order][x % order] + 0.5) / (order * order) - 0.5) * spread;
        red += threshold;
        green += threshold;
        blue += threshold;
      }
      quantizeAt(index, red, green, blue);
    }
  }
  return output;
}

function drawContour(grid, gridWidth, gridHeight, ink) {
  const output = Buffer.from(grid);
  const opaque = (x, y) => x >= 0 && y >= 0 && x < gridWidth && y < gridHeight && grid[(y * gridWidth + x) * 4 + 3] > 8;
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      const index = y * gridWidth + x;
      if (opaque(x, y)) continue;
      const touches = opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1);
      if (!touches) continue;
      output[index * 4] = ink[0];
      output[index * 4 + 1] = ink[1];
      output[index * 4 + 2] = ink[2];
      output[index * 4 + 3] = 255;
    }
  }
  return output;
}

// Ink drawing: the contour of the luminance instead of its areas. The threshold is a share of the
// strongest edge in the frame — an absolute value inks one picture and leaves the next blank.
function drawLineArt(grid, gridWidth, gridHeight, palette, percent) {
  const output = Buffer.alloc(gridWidth * gridHeight * 4);
  const paper = palette[palette.length - 1];
  const ink = palette[0];
  const luminance = (x, y) => {
    if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return 255;
    const index = (y * gridWidth + x) * 4;
    return grid[index] * 0.3 + grid[index + 1] * 0.59 + grid[index + 2] * 0.11;
  };
  const magnitude = new Float32Array(gridWidth * gridHeight);
  let peak = 0;
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      const gx = -luminance(x - 1, y - 1) - 2 * luminance(x - 1, y) - luminance(x - 1, y + 1)
        + luminance(x + 1, y - 1) + 2 * luminance(x + 1, y) + luminance(x + 1, y + 1);
      const gy = -luminance(x - 1, y - 1) - 2 * luminance(x, y - 1) - luminance(x + 1, y - 1)
        + luminance(x - 1, y + 1) + 2 * luminance(x, y + 1) + luminance(x + 1, y + 1);
      const edge = Math.hypot(gx, gy) / 4;
      magnitude[y * gridWidth + x] = edge;
      if (edge > peak) peak = edge;
    }
  }
  const limit = Math.max(1e-3, peak * (clamp(percent, 1, 100) / 100));
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      const index = y * gridWidth + x;
      if (grid[index * 4 + 3] < 8) continue;
      const color = magnitude[index] >= limit ? ink : paper;
      output[index * 4] = color[0];
      output[index * 4 + 1] = color[1];
      output[index * 4 + 2] = color[2];
      output[index * 4 + 3] = 255;
    }
  }
  return output;
}

export function pixelate(data, info, options = {}) {
  const { width, height, channels } = info;
  const size = clamp(Math.round(Number(options.size) || 4), 1, 64);
  const mode = pixelModes.includes(options.mode) ? options.mode : "clean";
  const dither = pixelDithers.includes(options.dither) ? options.dither : "none";
  const shadingSteps = clamp(Math.round(Number(options.shadingSteps) || 0), 0, 8);
  const softness = clamp(Number(options.alphaCutoff ?? 128), 1, 254);

  const gridWidth = Math.max(1, Math.round(width / size));
  const gridHeight = Math.max(1, Math.round(height / size));
  let grid = toGrid(data, info, gridWidth, gridHeight, { shadingSteps: mode === "shaded" ? Math.max(2, shadingSteps || 4) : 0 });

  // Hard alpha is part of the pixel-art convention: a soft edge on a 4-pixel grid reads as dirt.
  if (!options.softAlpha) {
    for (let index = 0; index < gridWidth * gridHeight; index += 1) {
      grid[index * 4 + 3] = grid[index * 4 + 3] >= softness ? 255 : 0;
    }
  }

  const fixed = resolvePalette(options.palette);
  const colorCount = clamp(Math.round(Number(options.colors) || 16), 2, 256);
  const sampled = [];
  for (let index = 0; index < gridWidth * gridHeight; index += 1) {
    if (grid[index * 4 + 3] < 8) continue;
    sampled.push([grid[index * 4], grid[index * 4 + 1], grid[index * 4 + 2]]);
  }
  // Line art only needs ink and paper, whatever palette was requested.
  const palette = mode === "lineart"
    ? (fixed ? [fixed[0], fixed[fixed.length - 1]] : [[16, 16, 20], [245, 244, 238]])
    : (fixed || medianCutPalette(sampled.length ? sampled : [[0, 0, 0]], colorCount));

  if (palette.length > 1) grid = quantize(grid, gridWidth, gridHeight, palette, dither, clamp(Number(options.ditherStrength ?? 0.75), 0.1, 1));
  if (mode === "lineart") grid = drawLineArt(grid, gridWidth, gridHeight, palette, Number(options.edgeThreshold) || 35);
  else if (mode === "outline") grid = drawContour(grid, gridWidth, gridHeight, Array.isArray(options.inkColor) ? options.inkColor : [18, 18, 22]);

  // Back to the original cell size with hard blocks: the rest of the pipeline keeps working with the
  // same geometry, so the atlas, the hitbox and the point of support need no changes.
  const output = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const gy = clamp(Math.floor((y * gridHeight) / height), 0, gridHeight - 1);
    for (let x = 0; x < width; x += 1) {
      const gx = clamp(Math.floor((x * gridWidth) / width), 0, gridWidth - 1);
      const from = (gy * gridWidth + gx) * 4;
      const to = (y * width + x) * channels;
      output[to] = grid[from];
      output[to + 1] = grid[from + 1];
      output[to + 2] = grid[from + 2];
      if (channels > 3) output[to + 3] = grid[from + 3];
    }
  }
  return { data: output, info, gridWidth, gridHeight, colors: palette.length, mode, palette };
}

// A named palette is a fixed artistic choice, so it reports its own size; the colour count only
// applies to an extracted palette. Kept separate so the interface can explain the difference.
export function effectiveColorCount(options = {}) {
  const fixed = resolvePalette(options.palette);
  return fixed ? fixed.length : clamp(Math.round(Number(options.colors) || 16), 2, 256);
}
