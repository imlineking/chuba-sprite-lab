import crypto from "node:crypto";

// Engine exporters and their parsers. Input is one neutral atlas description:
//
// atlas = {
//   name, app, version, fps,
//   pages: [{ file, width, height }],
//   frames: [{ name, page, x, y, w, h, rotated, trimmed,
//              spriteSourceSize: { x, y, w, h }, sourceSize: { w, h },
//              pivot: { x, y }, animation, index, tags }],
//   animations: { [name]: [frameName, ...] }   // aliases (duplicates) included
// }
//
// x/y/w/h are the frame rectangle in the page *before* rotation (TexturePacker
// convention): a rotated frame occupies h x w pixels in the page. Each parser returns
// the same shape of frames, which is what the round-trip tests compare.

export const formats = ["texturepacker-hash", "texturepacker-array", "phaser-hash", "phaser-array", "godot-spriteframes", "godot-atlastexture", "unity-meta", "unity-json"];

function frameEntry(frame) {
  return {
    frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
    rotated: Boolean(frame.rotated),
    trimmed: Boolean(frame.trimmed),
    spriteSourceSize: { ...frame.spriteSourceSize },
    sourceSize: { ...frame.sourceSize },
    pivot: { ...frame.pivot },
    ...(frame.durationMs > 0 ? { durationMs: frame.durationMs, animation: frame.animation } : {}),
  };
}

function meta(atlas, page, extra = {}) {
  return { app: atlas.app || "Chuba Sprite Lab", version: String(atlas.version || "1"), image: page.file, format: "RGBA8888", size: { w: page.width, h: page.height }, scale: "1", ...extra };
}

function pageFileName(atlas, pageIndex, suffix) {
  return atlas.pages.length === 1 ? `${atlas.name}${suffix}` : `${atlas.name}-${pageIndex}${suffix}`;
}

function texturePacker(atlas, { array, suffix }) {
  return atlas.pages.map((page, pageIndex) => {
    const frames = atlas.frames.filter((frame) => frame.page === pageIndex);
    const frameTags = Object.entries(atlas.animations).map(([name, list]) => ({ name, frames: list.filter((f) => frames.some((fr) => fr.name === f)) })).filter((tag) => tag.frames.length);
    const content = {
      frames: array ? frames.map((frame) => ({ filename: frame.name, ...frameEntry(frame) })) : Object.fromEntries(frames.map((frame) => [frame.name, frameEntry(frame)])),
      meta: meta(atlas, page, {
        animations: Object.fromEntries(frameTags.map((tag) => [tag.name, tag.frames])),
        ...(atlas.animationMetadata ? { frameTags: Object.entries(atlas.animationMetadata).map(([name, value]) => ({ ...value, name })) } : {}),
        ...(atlas.animationLoop != null ? { animationLoop: atlas.animationLoop } : {}),
        ...(atlas.pages.length > 1 ? { related_multi_packs: atlas.pages.map((_, i) => pageFileName(atlas, i, suffix)).filter((_, i) => i !== pageIndex) } : {}),
      }),
    };
    return { file: pageFileName(atlas, pageIndex, suffix), text: `${JSON.stringify(content, null, 2)}\n` };
  });
}

function animationFrames(atlas, name, list) {
  const byName = new Map(atlas.frames.map((frame) => [frame.name, frame]));
  const metadata = atlas.animationMetadata?.[name];
  const loop = metadata?.loop;
  const selected = loop ? list.slice(loop.from ?? 0, (loop.to ?? list.length - 1) + 1) : [...list];
  if (["reverse", "pingpong_reverse"].includes(metadata?.direction)) selected.reverse();
  const order = loop?.mode === "pingpong" || ["pingpong", "pingpong_reverse"].includes(metadata?.direction)
    ? [...selected, ...selected.slice(1, -1).reverse()] : selected;
  return order.map((key) => byName.get(key));
}

function phaser(atlas, { array }) {
  const files = texturePacker(atlas, { array, suffix: array ? ".phaser-array.json" : ".phaser-hash.json" });
  // Phaser 3 loads several pages with load.multiatlas; one page works with load.atlas.
  if (atlas.pages.length > 1) {
    const textures = atlas.pages.map((page, pageIndex) => ({
      image: page.file, format: "RGBA8888", size: { w: page.width, h: page.height }, scale: 1,
      frames: atlas.frames.filter((frame) => frame.page === pageIndex).map((frame) => ({ filename: frame.name, ...frameEntry(frame) })),
    }));
    files.push({ file: `${atlas.name}.phaser-multiatlas.json`, text: `${JSON.stringify({ textures, meta: meta(atlas, atlas.pages[0]) }, null, 2)}\n` });
  }
  const anims = Object.entries(atlas.animations).map(([key, list]) => {
    const frames = animationFrames(atlas, key, list);
    const fps = atlas.animationMetadata?.[key]?.fps || atlas.fps || 12;
    // Phaser adds per-frame duration to its base interval. Keep that interval
    // no longer than the shortest source frame instead of stretching it.
    const base = Math.min(1000 / fps, ...frames.map((frame) => frame.durationMs || 1000 / fps));
    return { key, type: "frame", frameRate: 1000 / base, repeat: atlas.animationLoop > 0 ? atlas.animationLoop - 1 : -1,
      frames: frames.map((frame) => ({ key: atlas.name, frame: frame.name, ...(frame.durationMs > 0 ? { duration: Math.max(0, frame.durationMs - base) } : {}) })),
    };
  });
  files.push({ file: `${atlas.name}.phaser-anims.json`, text: `${JSON.stringify({ anims }, null, 2)}\n` });
  return files;
}

function godotAtlasTextureBody(frame) {
  const margin = frame.trimmed ? `margin = Rect2(${frame.spriteSourceSize.x}, ${frame.spriteSourceSize.y}, ${frame.sourceSize.w - frame.w}, ${frame.sourceSize.h - frame.h})\n` : "";
  return `region = Rect2(${frame.x}, ${frame.y}, ${frame.w}, ${frame.h})\n${margin}filter_clip = true\n`;
}

function godot(atlas, { spriteFrames }) {
  if (atlas.frames.some((frame) => frame.rotated)) throw new Error("Godot AtlasTexture cannot represent rotated frames; disable rotate for Godot exports");
  if (!spriteFrames) {
    return atlas.frames.map((frame) => ({
      file: `${atlas.name}/${frame.name}.tres`,
      text: `[gd_resource type="AtlasTexture" load_steps=2 format=3]\n\n[ext_resource type="Texture2D" path="res://${atlas.pages[frame.page].file}" id="1_sheet"]\n\n[resource]\natlas = ExtResource("1_sheet")\n${godotAtlasTextureBody(frame)}`,
    }));
  }
  const byName = new Map(atlas.frames.map((frame) => [frame.name, frame]));
  const subIds = new Map();
  const sub = [];
  const animations = Object.entries(atlas.animations).map(([name, list]) => {
    const fps = atlas.animationMetadata?.[name]?.fps || atlas.fps || 12;
    const entries = animationFrames(atlas, name, list).map((entry) => {
      const frame = byName.get(entry.name) ?? byName.get(atlas.aliases?.[entry.name]);
      const key = `${frame.page}:${frame.x}:${frame.y}`;
      if (!subIds.has(key)) {
        const id = `AtlasTexture_${subIds.size}`;
        subIds.set(key, id);
        sub.push(`[sub_resource type="AtlasTexture" id="${id}"]\natlas = ExtResource("${frame.page + 1}_sheet")\n${godotAtlasTextureBody(frame)}`);
      }
      const duration = frame.durationMs > 0 ? round(frame.durationMs * fps / 1000) : "1.0";
      return `{\n"duration": ${duration},\n"texture": SubResource("${subIds.get(key)}")\n}`;
    });
    const speed = atlas.animationMetadata ? String(fps) : fps.toFixed(1);
    return `{\n"frames": [${entries.join(", ")}],\n"loop": ${atlas.animationLoop === 1 ? "false" : "true"},\n"name": &"${name.replace(/["\\]/g, "")}",\n"speed": ${speed}\n}`;
  });
  const ext = atlas.pages.map((page, index) => `[ext_resource type="Texture2D" path="res://${page.file}" id="${index + 1}_sheet"]`);
  const text = `[gd_resource type="SpriteFrames" load_steps=${ext.length + sub.length + 1} format=3]\n\n${ext.join("\n")}\n\n${sub.join("\n")}\n[resource]\nanimations = [${animations.join(", ")}]\n`;
  return [{ file: `${atlas.name}.tres`, text }];
}

/** Deterministic GUID so re-exports keep Unity references stable. */
export function unityGuid(seed) {
  return crypto.createHash("md5").update(`chuba-sprite-lab:${seed}`).digest("hex");
}

function unityMeta(atlas) {
  if (atlas.frames.some((frame) => frame.rotated)) throw new Error("Unity sprite slicing cannot represent rotated frames; disable rotate for Unity exports");
  return atlas.pages.map((page, pageIndex) => {
    const sprites = atlas.frames.filter((frame) => frame.page === pageIndex).map((frame) => {
      // Unity rect origin is bottom-left; pivot is normalised inside the trimmed rect.
      const y = page.height - frame.y - frame.h;
      const px = (frame.pivot.x * frame.sourceSize.w - frame.spriteSourceSize.x) / frame.w;
      const py = 1 - (frame.pivot.y * frame.sourceSize.h - frame.spriteSourceSize.y) / frame.h;
      return [
        `    - serializedVersion: 2`,
        `      name: ${frame.name}`,
        `      rect:`,
        `        serializedVersion: 2`,
        `        x: ${frame.x}`,
        `        y: ${y}`,
        `        width: ${frame.w}`,
        `        height: ${frame.h}`,
        `      alignment: 9`,
        `      pivot: {x: ${round(px)}, y: ${round(py)}}`,
        `      border: {x: 0, y: 0, z: 0, w: 0}`,
        `      spriteID: ${unityGuid(`${atlas.name}/${frame.name}`)}`,
      ].join("\n");
    });
    const text = [
      "fileFormatVersion: 2",
      `guid: ${unityGuid(`${atlas.name}/${page.file}`)}`,
      "TextureImporter:",
      "  serializedVersion: 12",
      "  mipmaps:",
      "    enableMipMap: 0",
      "  textureType: 8",
      "  spriteMode: 2",
      "  alphaIsTransparency: 1",
      "  filterMode: 0",
      "  textureCompression: 0",
      "  spritePixelsToUnits: 100",
      "  spriteSheet:",
      "    serializedVersion: 2",
      `    sprites:${sprites.length ? `\n${sprites.join("\n")}` : " []"}`,
      "",
    ].join("\n");
    return { file: `${page.file}.meta`, text };
  });
}

function round(value) { return Math.round(value * 1e6) / 1e6; }

function unityJson(atlas) {
  const content = {
    app: atlas.app || "Chuba Sprite Lab", fps: atlas.fps || 12,
    pages: atlas.pages.map((page) => ({ ...page })),
    frames: atlas.frames.map((frame) => ({ name: frame.name, page: frame.page, rect: { x: frame.x, y: atlas.pages[frame.page].height - frame.y - frame.h, width: frame.w, height: frame.h }, pivot: { x: round((frame.pivot.x * frame.sourceSize.w - frame.spriteSourceSize.x) / frame.w), y: round(1 - (frame.pivot.y * frame.sourceSize.h - frame.spriteSourceSize.y) / frame.h) }, ...(frame.durationMs > 0 ? { durationMs: frame.durationMs } : {}) })),
    animations: atlas.animations,
    ...(atlas.animationMetadata ? { animationMetadata: atlas.animationMetadata } : {}),
    ...(atlas.animationLoop != null ? { animationLoop: atlas.animationLoop } : {}),
  };
  return [{ file: `${atlas.name}.unity.json`, text: `${JSON.stringify(content, null, 2)}\n` }];
}

export function exportAtlas(atlas, format) {
  switch (format) {
    case "texturepacker-hash": return texturePacker(atlas, { array: false, suffix: ".json" });
    case "texturepacker-array": return texturePacker(atlas, { array: true, suffix: ".array.json" });
    case "phaser-hash": return phaser(atlas, { array: false });
    case "phaser-array": return phaser(atlas, { array: true });
    case "godot-spriteframes": return godot(atlas, { spriteFrames: true });
    case "godot-atlastexture": return godot(atlas, { spriteFrames: false });
    case "unity-meta": return unityMeta(atlas);
    case "unity-json": return unityJson(atlas);
    default: throw new Error(`Unknown export format "${format}". Known: ${formats.join(", ")}`);
  }
}

// ---------------------------------------------------------------- parsers

/** TexturePacker / Phaser JSON hash or array -> [{ name, x, y, w, h, rotated, trimmed, spriteSourceSize, sourceSize, pivot }]. */
export function parseTexturePacker(text) {
  const data = typeof text === "string" ? JSON.parse(text) : text;
  const entries = Array.isArray(data.frames) ? data.frames.map((f) => [f.filename, f]) : Object.entries(data.frames);
  return entries.map(([name, f]) => ({ name, x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h, rotated: Boolean(f.rotated), trimmed: Boolean(f.trimmed), spriteSourceSize: f.spriteSourceSize, sourceSize: f.sourceSize, pivot: f.pivot }));
}

/** Godot SpriteFrames / AtlasTexture -> regions and animations (frame order by sub-resource). */
export function parseGodot(text) {
  const regions = {};
  for (const match of text.matchAll(/(?:\[sub_resource type="AtlasTexture" id="([^"]+)"\]|\[resource\])\natlas = ExtResource\("(\d+)_sheet"\)\nregion = Rect2\(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)\n(?:margin = Rect2\(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)\n)?/g)) {
    regions[match[1] ?? "resource"] = { page: Number(match[2]) - 1, x: +match[3], y: +match[4], w: +match[5], h: +match[6], margin: match[7] === undefined ? null : { x: +match[7], y: +match[8], w: +match[9], h: +match[10] } };
  }
  const animations = {};
  for (const match of text.matchAll(/"frames": \[(.*?)\],\n"loop": true,\n"name": &"([^"]*)"/gs)) {
    animations[match[2]] = [...match[1].matchAll(/SubResource\("([^"]+)"\)/g)].map((m) => regions[m[1]]);
  }
  return { regions, animations };
}

/** Unity TextureImporter .meta -> [{ name, x, y, w, h, pivot }] in Unity coordinates. */
export function parseUnityMeta(text) {
  const sprites = [];
  for (const match of text.matchAll(/name: (.+)\n\s+rect:\n\s+serializedVersion: 2\n\s+x: (-?[\d.]+)\n\s+y: (-?[\d.]+)\n\s+width: ([\d.]+)\n\s+height: ([\d.]+)\n\s+alignment: \d+\n\s+pivot: \{x: (-?[\d.e-]+), y: (-?[\d.e-]+)\}/g)) {
    sprites.push({ name: match[1].trim(), x: +match[2], y: +match[3], w: +match[4], h: +match[5], pivot: { x: +match[6], y: +match[7] } });
  }
  return { guid: /guid: ([0-9a-f]{32})/.exec(text)?.[1] ?? null, sprites };
}
