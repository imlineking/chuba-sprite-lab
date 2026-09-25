import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveColorCount,
  hexToColor,
  medianCutPalette,
  pixelate,
  pixelDithers,
  pixelModes,
  pixelPalettes,
  resolvePalette,
} from "../src/pixelate.mjs";

function fixture(width = 16, height = 16) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      // A smooth gradient inside a transparent margin: enough structure to reveal the grid, the
      // palette and the contour, and an edge for the alpha rule to act on.
      const inside = x >= 2 && x < width - 2 && y >= 2 && y < height - 2;
      data[offset] = Math.round((x / width) * 255);
      data[offset + 1] = Math.round((y / height) * 255);
      data[offset + 2] = 128;
      data[offset + 3] = inside ? 255 : 0;
    }
  }
  return { data, info: { width, height, channels: 4 } };
}

function pixel(buffer, width, x, y) {
  const offset = (y * width + x) * 4;
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
}

test("the grid follows the requested pixel size and the cell keeps its size", () => {
  const { data, info } = fixture(32, 16);
  const result = pixelate(data, info, { size: 4, colors: 8 });
  assert.equal(result.gridWidth, 8);
  assert.equal(result.gridHeight, 4);
  assert.equal(result.data.length, data.length, "the frame geometry must not change");
});

test("one grid pixel becomes one uniform block", () => {
  const { data, info } = fixture(16, 16);
  const result = pixelate(data, info, { size: 4, colors: 4, palette: "gameboy" });
  assert.deepEqual(pixel(result.data, 16, 4, 4), pixel(result.data, 16, 7, 7), "the block must be uniform");
  assert.deepEqual(pixel(result.data, 16, 4, 4), pixel(result.data, 16, 5, 6));
  assert.equal(pixel(result.data, 16, 0, 0)[3], 0, "a mostly transparent cell stays transparent");
  assert.equal(pixel(result.data, 16, 8, 8)[3], 255, "an opaque cell stays opaque");
});

test("a named palette decides the colour count, an extracted one uses the request", () => {
  const { data, info } = fixture(16, 16);
  assert.equal(pixelate(data, info, { size: 2, palette: "pico8", colors: 200 }).colors, 16);
  const extracted = pixelate(data, info, { size: 2, palette: "auto", colors: 6 });
  assert.ok(extracted.colors <= 6 && extracted.colors >= 2);
  const seen = new Set();
  for (let index = 0; index < extracted.data.length; index += 4) {
    if (extracted.data[index + 3] === 0) continue;
    seen.add(`${extracted.data[index]},${extracted.data[index + 1]},${extracted.data[index + 2]}`);
  }
  assert.ok(seen.size <= 6, `the result must not exceed its palette, saw ${seen.size}`);
});

test("ordered dithering changes the shading without leaving the palette", () => {
  const { data, info } = fixture(32, 32);
  const flat = pixelate(data, info, { size: 1, palette: "gameboy", dither: "none" });
  const dithered = pixelate(data, info, { size: 1, palette: "gameboy", dither: "bayer4" });
  assert.notDeepEqual(dithered.data, flat.data, "dithering must have an effect");
  const allowed = new Set(resolvePalette("gameboy").map((color) => color.join(",")));
  for (let index = 0; index < dithered.data.length; index += 4) {
    if (dithered.data[index + 3] === 0) continue;
    assert.ok(allowed.has([dithered.data[index], dithered.data[index + 1], dithered.data[index + 2]].join(",")));
  }
});

test("error diffusion also stays inside the palette", () => {
  const { data, info } = fixture(24, 24);
  const allowed = new Set(resolvePalette("gameboy").map((color) => color.join(",")));
  const result = pixelate(data, info, { size: 2, palette: "gameboy", dither: "floyd" });
  for (let index = 0; index < result.data.length; index += 4) {
    if (result.data[index + 3] === 0) continue;
    assert.ok(allowed.has([result.data[index], result.data[index + 1], result.data[index + 2]].join(",")), "diffusion must not invent colours");
  }
  const atkinson = pixelate(data, info, { size: 2, palette: "gameboy", dither: "atkinson" });
  assert.notDeepEqual(atkinson.data, result.data, "the two diffusion kernels differ");
});

test("the outline mode adds a contour around the silhouette, not over it", () => {
  const { data, info } = fixture(16, 16);
  const clean = pixelate(data, info, { size: 2, palette: "grayscale4", mode: "clean" });
  const outlined = pixelate(data, info, { size: 2, palette: "grayscale4", mode: "outline" });
  let added = 0;
  let removed = 0;
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const before = pixel(clean.data, 16, x, y)[3] > 0;
      const after = pixel(outlined.data, 16, x, y)[3] > 0;
      if (!before && after) added += 1;
      if (before && !after) removed += 1;
    }
  }
  assert.ok(added > 0, "the contour must appear");
  assert.equal(removed, 0, "the contour must not eat the sprite");
  assert.ok(added < 200, `the contour must stay a contour, added ${added} pixels`);
});

test("line art draws ink instead of areas", () => {
  const { data, info } = fixture(16, 16);
  const result = pixelate(data, info, { size: 2, mode: "lineart", palette: "grayscale4" });
  const levels = new Set();
  for (let index = 0; index < result.data.length; index += 4) {
    if (result.data[index + 3] === 0) continue;
    levels.add(result.data[index]);
  }
  assert.ok(levels.size <= 2, `line art uses ink and paper only, saw ${levels.size}`);
});

test("hard alpha is the default and soft alpha can be asked for", () => {
  const { data, info } = fixture(16, 16);
  const hard = pixelate(data, info, { size: 4, colors: 4 });
  const soft = pixelate(data, info, { size: 4, colors: 4, softAlpha: true });
  const alphas = (buffer) => {
    const seen = new Set();
    for (let index = 3; index < buffer.length; index += 4) seen.add(buffer[index]);
    return seen;
  };
  assert.ok([...alphas(hard.data)].every((value) => value === 0 || value === 255), "pixel art uses hard edges");
  assert.ok([...alphas(soft.data)].some((value) => value > 0 && value < 255), "soft alpha keeps intermediate values");
});

test("median cut returns the requested size and stays in range", () => {
  const colors = [];
  for (let index = 0; index < 100; index += 1) colors.push([index * 2, 255 - index * 2, 128]);
  const palette = medianCutPalette(colors, 5);
  assert.equal(palette.length, 5);
  for (const color of palette) assert.ok(color.every((value) => value >= 0 && value <= 255));
  assert.deepEqual(medianCutPalette([], 4), [[0, 0, 0]], "an empty colour set still needs a colour");
});

test("the vocabulary of palettes, modes and dithers is closed", () => {
  assert.ok(pixelModes.includes("outline") && pixelModes.includes("lineart") && pixelModes.includes("stitch"));
  assert.ok(pixelDithers.includes("atkinson") && pixelDithers.includes("bayer8"));
  assert.deepEqual(hexToColor("#ff7617"), [255, 118, 23]);
  assert.equal(hexToColor("nonsense"), null);
  assert.equal(resolvePalette("unknown"), null, "an unknown palette name falls back to extraction");
  assert.equal(resolvePalette("auto"), null);
  assert.equal(effectiveColorCount({ palette: "c64", colors: 200 }), 16);
  assert.equal(effectiveColorCount({ palette: "auto", colors: 32 }), 32);
  for (const [name, values] of Object.entries(pixelPalettes)) {
    assert.ok(values.length >= 2, `${name} needs at least two colours`);
    for (const hex of values) assert.ok(hexToColor(hex), `${name} has a broken colour: ${hex}`);
  }
});
