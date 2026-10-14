import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { sniffBuffer, countIslands, classifyFile, classifyMany, detectFile, detectInput, extensionMismatch } from "../src/input-types.mjs";
import { encodeAPNG, encodeGIF } from "../src/animated-images.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spritelab-types-"));
test.after(() => fs.rm(tmp, { recursive: true, force: true }));
const write = async (name, data) => { const file = path.join(tmp, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return file; };
const solid = (w, h, rgba) => { const b = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) b.set(rgba, i * 4); return b; };
const png = (w = 32, h = 32, alpha = 1) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 30, g: 90, b: 200, alpha } } }).png().toBuffer();
const ftyp = (brand) => { const b = Buffer.alloc(32); b.writeUInt32BE(32, 0); b.write("ftyp", 4, "latin1"); b.write(brand, 8, "latin1"); b.write("isom", 16, "latin1"); return b; };

test("sniffBuffer recognises formats by magic bytes", async () => {
  assert.equal(sniffBuffer(await png()).format, "png");
  assert.equal(sniffBuffer(await png()).animated, false);
  assert.equal(sniffBuffer(encodeAPNG([{ pixels: solid(4, 4, [1, 2, 3, 255]), durationMs: 50 }, { pixels: solid(4, 4, [9, 2, 3, 255]), durationMs: 50 }], 4, 4)).animated, true);
  const gif2 = await encodeGIF([{ pixels: solid(4, 4, [0, 0, 255, 255]), durationMs: 100 }, { pixels: solid(4, 4, [255, 0, 0, 255]), durationMs: 100 }], 4, 4);
  assert.deepEqual(sniffBuffer(gif2), { format: "gif", animated: true });
  const gif1 = await sharp(await png()).gif().toBuffer();
  assert.deepEqual(sniffBuffer(gif1), { format: "gif", animated: false });
  assert.equal(sniffBuffer(await sharp(await png()).jpeg().toBuffer()).format, "jpeg");
  assert.deepEqual(sniffBuffer(await sharp(await png()).webp().toBuffer()), { format: "webp", animated: false });
  assert.equal(sniffBuffer(Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj")).format, "pdf");
  assert.equal(sniffBuffer(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')).format, "svg");
  assert.equal(sniffBuffer(Buffer.concat([Buffer.from("8BPS"), Buffer.alloc(30)])).format, "psd");
  const bmp = Buffer.alloc(60); bmp.write("BM", 0, "latin1"); assert.equal(sniffBuffer(bmp).format, "bmp");
  assert.equal(sniffBuffer(ftyp("isom")).format, "mp4");
  assert.equal(sniffBuffer(ftyp("qt  ")).format, "mov");
  assert.equal(sniffBuffer(ftyp("avif")).format, "avif");
  assert.equal(sniffBuffer(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("\x42\x82\x84webm")])).format, "webm");
  assert.equal(sniffBuffer(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("matroska")])).format, "mkv");
  const avi = Buffer.alloc(16); avi.write("RIFF", 0, "latin1"); avi.write("AVI ", 8, "latin1"); assert.equal(sniffBuffer(avi).format, "avi");
  const ase = Buffer.alloc(128); ase.writeUInt16LE(0xa5e0, 4); assert.equal(sniffBuffer(ase).format, "aseprite");
  assert.deepEqual(sniffBuffer(Buffer.from('{"frames":{"a.png":{}},"meta":{}}')), { format: "json", atlas: true });
  assert.equal(sniffBuffer(Buffer.from('{"format":"chuba-sprite-lab-project"}')).format, "cslab");
  assert.equal(sniffBuffer(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])).format, "unknown");
});

test("animated WebP is flagged through the VP8X animation bit", async () => {
  const frames = Buffer.concat([solid(8, 8, [0, 0, 255, 255]), solid(8, 8, [255, 0, 0, 255])]);
  const webp = await sharp(frames, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.deepEqual(sniffBuffer(webp), { format: "webp", animated: true });
});

test("countIslands counts separate objects", () => {
  const w = 6, h = 3, m = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
  assert.equal(countIslands(m, w, h, { minArea: 1 }), 5);
  assert.equal(countIslands(m, w, h, { minArea: 2 }), 2);
});

test("classifyFile maps formats to input types", () => {
  assert.equal(classifyFile({ format: "mp4" }), "video");
  assert.equal(classifyFile({ format: "gif", animated: true }), "animated-image");
  assert.equal(classifyFile({ format: "gif", animated: false }), "image");
  assert.equal(classifyFile({ format: "png", animated: true }), "animated-image");
  assert.equal(classifyFile({ format: "webp", animated: true }), "animated-image");
  assert.equal(classifyFile({ format: "avif", animated: true }), "image");
  assert.equal(classifyFile({ format: "png" }, { sheet: true }), "sprite-sheet");
  assert.equal(classifyFile({ format: "png" }, {}, { name: "hero_spritesheet.png" }), "sprite-sheet");
  assert.equal(classifyFile({ format: "png" }, {}, { name: "hero.png" }), "image");
  for (const f of ["pdf", "svg", "psd", "bmp", "heic"]) assert.equal(classifyFile({ format: f }), f);
  assert.equal(classifyFile({ format: "json", atlas: true }), "atlas-json");
  assert.equal(classifyFile({ format: "json", atlas: false }), "unknown");
});

test("classifyMany handles folders, batches and mixtures", () => {
  assert.equal(classifyMany([{ isDirectory: true, childTypes: ["image", "image"] }]), "frames-folder");
  assert.equal(classifyMany([{ isDirectory: true, childTypes: ["pdf"] }]), "empty-folder");
  assert.equal(classifyMany([{ type: "video" }, { type: "video" }]), "video-batch");
  assert.equal(classifyMany([{ type: "image" }, { type: "sprite-sheet" }]), "image-set");
  assert.equal(classifyMany([{ type: "image" }, { type: "video" }]), "mixed");
});

test("detectFile trusts content over extension and warns about the mismatch", async () => {
  const fake = await write("really-png.jpg", await png());
  const result = await detectFile(fake);
  assert.equal(result.format, "png"); assert.equal(result.type, "image");
  assert.match(result.warning, /не совпадает/);
  assert.equal(extensionMismatch("a.mov", "mp4"), null);
  const pdfNamedPng = await detectFile(await write("doc.png", Buffer.from("%PDF-1.4\n")));
  assert.equal(pdfNamedPng.type, "pdf");
});

test("detectInput finds a sprite sheet by alpha islands and by sibling JSON", async () => {
  const cells = [];
  for (let i = 0; i < 6; i++) cells.push({ input: { create: { width: 40, height: 40, channels: 4, background: { r: 20, g: 60, b: 220, alpha: 1 } } }, left: 16 + (i % 3) * 80, top: 16 + Math.floor(i / 3) * 80 });
  const sheet = await sharp({ create: { width: 256, height: 176, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(cells).png().toBuffer();
  const r = await detectInput([await write("hero.png", sheet)], { sharp });
  assert.equal(r.type, "sprite-sheet"); assert.ok(r.facts.islands >= 6);
  const single = await detectInput([await write("photo.png", await png(300, 200))], { sharp });
  assert.equal(single.type, "image");
  await write("walk.png", await png(64, 64)); await write("walk.json", "{}");
  assert.equal((await detectInput([path.join(tmp, "walk.png")], { sharp })).type, "sprite-sheet");
});

test("detectInput handles folders, batches, mixtures and unsupported files", async () => {
  for (let i = 0; i < 3; i++) await write(`frames/f${i}.png`, await png());
  await write("frames/notes.txt", "hello");
  const folder = await detectInput([path.join(tmp, "frames")]);
  assert.equal(folder.type, "frames-folder"); assert.equal(folder.files.length, 3);
  const v1 = await write("a.mp4", ftyp("isom")), v2 = await write("b.webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm")]));
  assert.equal((await detectInput([v1, v2])).type, "video-batch");
  assert.equal((await detectInput([v1, path.join(tmp, "frames/f0.png")])).type, "mixed");
  assert.equal((await detectInput([await write("x.svg", "<svg></svg>")])).type, "svg");
  assert.equal((await detectInput([await write("x.psd", Buffer.concat([Buffer.from("8BPS"), Buffer.alloc(40)]))])).type, "psd");
  assert.equal((await detectInput([await write("x.bin", Buffer.from([0, 0, 0, 1, 2, 3, 0, 9]))])).type, "unknown");
  await fs.mkdir(path.join(tmp, "empty"));
  assert.equal((await detectInput([path.join(tmp, "empty")])).type, "empty-folder");
});
