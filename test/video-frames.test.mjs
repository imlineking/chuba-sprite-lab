import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import * as vf from "../src/video-frames.mjs";

const ffmpeg = process.env.FFMPEG || (spawnSync("ffmpeg", ["-version"]).status === 0 ? "ffmpeg" : null);
const vendor = path.resolve("vendor", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const bin = ffmpeg || (spawnSync(vendor, ["-version"]).status === 0 ? vendor : null);

test("stream info parser keeps codec, size, fps, audio and pixel format", () => {
  const info = vf.parseStreamInfo("Duration: 00:00:02.00, start\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 160x120, 20 kb/s, 12 fps, 12 tbr\n  Stream #0:1[0x2](und): Audio: aac (LC)");
  assert.deepEqual(info, { codec: "h264", width: 160, height: 120, fps: 12, audio: "aac", pixFmt: "yuv420p", duration: 2 });
});

test("bake keeps fps and copies audio; unknown codecs fall back honestly", () => {
  const { args, enc } = vf.bakeArgs({ video: "in.mp4", framePng: "f.png", index: 7, info: { codec: "h264", width: 64, height: 32, fps: 24, pixFmt: "yuv420p" }, outPath: "out.mp4" });
  assert.ok(enc.sameCodec); assert.ok(args.join(" ").includes("eq(n\\,7)"));
  assert.deepEqual(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2), ["-c:a", "copy"]);
  assert.ok(args.includes("0:a?")); assert.equal(args[args.indexOf("-r") + 1], "24");
  assert.equal(vf.encoderFor({ codec: "weird" }, "x.webm").args[0], "libvpx-vp9");
  assert.equal(vf.bakedName(path.join("d", "movie.mp4")), path.join("d", "movie-edited.mp4"));
});

test("external editors are launched through an injected spawner (never a real app in tests)", async () => {
  const calls = [];
  const fake = (command, args, options) => { calls.push({ command, args, options }); return { unref() {} }; };
  const opened = await vf.openInEditor({ editor: "photoshop", exePath: "C:/PS/Photoshop.exe", file: "/tmp/f.png" }, { spawnFn: fake });
  assert.deepEqual(calls[0].args, ["/tmp/f.png"]); assert.equal(calls[0].command, "C:/PS/Photoshop.exe"); assert.ok(opened.opened);
  const figma = await vf.openInEditor({ editor: "figma", exePath: "Figma.exe", file: "/tmp/f.png" }, { spawnFn: fake });
  assert.match(figma.note, /Figma/);
  let shellPath = null; await vf.openInEditor({ editor: "system", file: "/tmp/f.png" }, { openPath: async (p) => { shellPath = p; return ""; } });
  assert.equal(shellPath, "/tmp/f.png");
  assert.throws(() => vf.editorLaunch({ editor: "photoshop", file: "x" }), /Photoshop/);
  assert.throws(() => vf.editorLaunch({ editor: "evil", file: "x" }), /Неизвестный/);
  assert.throws(() => vf.editorLaunch({ editor: "sprite-lab", file: "x" }), /Встроенный/);
  assert.ok(vf.externalEditors["sprite-lab"].builtin, "built-in editor is one of the choices");
});

test("save watcher fires once per completed write", async () => {
  let stat = { mtimeMs: 1, size: 10 }; const saves = [];
  const w = vf.watchSaves("f.png", (s) => saves.push(s), { autoStart: false, stat: async () => stat });
  await w.tick(); stat = { mtimeMs: 2, size: 5 }; await w.tick(); assert.equal(saves.length, 0);
  stat = { mtimeMs: 2, size: 5 }; await w.tick(); assert.equal(saves.length, 1); await w.tick(); assert.equal(saves.length, 1);
  w.stop();
});

test("video -> pick frame -> edit (mock editor) -> bake back -> frame replaced, fps and audio kept", { skip: !bin && "ffmpeg not available" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spritelab-vf-"));
  try {
    const video = path.join(dir, "movie.mp4");
    const made = spawnSync(bin, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=96x64:rate=12", "-f", "lavfi", "-i", "sine=f=440", "-t", "1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
    if (made.status !== 0) return; // build without libx264/aac: nothing to test here
    const info = await vf.probe(bin, video);
    assert.equal(info.fps, 12); assert.equal(info.audio, "aac");
    const frame = await vf.extractFrame({ ffmpeg: bin, video, index: 5, fps: info.fps, outPath: path.join(dir, "f5.png") });
    // "External editor" = this test painting the frame red and saving over the same file.
    await sharp({ create: { width: 96, height: 64, channels: 4, background: "#ff0000" } }).png().toFile(path.join(dir, "red.png"));
    await fs.copyFile(path.join(dir, "red.png"), frame.path);
    const baked = await vf.bakeFrame({ ffmpeg: bin, video, framePng: frame.path, index: 5, outPath: vf.bakedName(video) });
    const after = await vf.probe(bin, baked.path);
    assert.equal(after.fps, 12); assert.equal(after.audio, "aac"); assert.equal(after.width, 96);
    const mean = async (i) => { const f = await vf.extractFrame({ ffmpeg: bin, video: baked.path, index: i, fps: 12, outPath: path.join(dir, `o${i}.png`) }); return (await sharp(f.path).stats()).channels.map((c) => c.mean); };
    const [r5, g5] = await mean(5); assert.ok(r5 > 200 && g5 < 40, "edited frame is in the video");
    const [r4, g4] = await mean(4); assert.ok(!(r4 > 200 && g4 < 40), "neighbour untouched");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("video -> single frame with the character, background removed, PNG in a project folder", { skip: !bin && "ffmpeg not available" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spritelab-vf-"));
  try {
    const video = path.join(dir, "hero.mp4");
    const made = spawnSync(bin, ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:size=64x64:rate=10", "-vf", "drawbox=x=20:y=16:w=24:h=32:color=black@1:t=fill", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv444p", video]);
    if (made.status !== 0) return;
    const { keyFrame } = await import("../src/processor.mjs");
    const out = await vf.saveCutout({ ffmpeg: bin, video, index: 3, fps: 10, folder: path.join(dir, "project"), tmpDir: dir, keyFrame: (p) => keyFrame(p, "auto", 32, 3, 0, {}) });
    assert.match(path.basename(out.path), /hero-sprite-0004\.png/);
    const meta = await sharp(out.path).metadata(); assert.equal(meta.hasAlpha, true);
    const { data } = await sharp(out.path).raw().toBuffer({ resolveWithObject: true });
    assert.equal(data[3], 0, "corner (background) is transparent"); assert.equal(out.empty, false);
    const raw = await vf.saveCutout({ ffmpeg: bin, video, index: 3, fps: 10, folder: path.join(dir, "project"), tmpDir: dir, raw: true, keyFrame: () => { throw new Error("not used"); } });
    assert.match(path.basename(raw.path), /hero-frame-0004\.png/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
