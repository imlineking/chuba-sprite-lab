import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { EmbeddedRuntime, runtimePaths, serverArgs, criticModels, readLock, stopLockedServer } from "../src/critic/llm-runtime.mjs";
import { applyFix, sanitizeFix, validateCriticConfig } from "../src/critic/critic.mjs";
import { buildAtlas, listImages } from "../src/pipeline/build.mjs";
import { packMaxRects } from "../src/pipeline/maxrects.mjs";
import { planWithCopilot, plannerStatus } from "../src/copilot-planner.mjs";
import { main as atlasMain } from "../scripts/atlas.mjs";

const tmp = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), `spritelab-p0-${prefix}-`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const paths = (extra = {}) => ({ model: criticModels[0], servers: [{ backend: "vulkan", file: "/x/vulkan/llama-server" }], weights: "/w.gguf", mmproj: "/m.gguf", mmprojOffload: false, skills: null, ...extra });

let nextPid = 900000;
function fakeChild() {
  const child = new EventEmitter();
  child.pid = nextPid++; child.stderr = new EventEmitter(); child.killed = false;
  child.kill = () => { if (!child.killed) { child.killed = true; setImmediate(() => child.emit("exit", 0)); } };
  child.unref = () => {};
  return child;
}
const okJson = (content = "{\"ok\":true}") => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }), text: async () => "" });

// 1. Cold start: VRAM flags, Q8_0 projector preference, warm-up, restart of a dead server, stderr.
test("server args: flash attention, q8_0 KV cache, BF16 projector kept on the CPU", () => {
  const gpu = serverArgs(paths(), { backend: "vulkan" }, 1234);
  assert.equal(gpu[gpu.indexOf("-fa") + 1], "on");
  assert.equal(gpu[gpu.indexOf("--cache-type-k") + 1], "q8_0"); assert.equal(gpu[gpu.indexOf("--cache-type-v") + 1], "q8_0");
  assert.ok(gpu.includes("--no-mmproj-offload"));
  assert.ok(!serverArgs(paths({ mmprojOffload: true }), { backend: "vulkan" }, 1).includes("--no-mmproj-offload"));
  assert.equal(gpu[gpu.indexOf("-ngl") + 1], "99");
});

test("runtimePaths prefers an official Q8_0 projector when present, else BF16 without offload", async () => {
  const root = await tmp("paths");
  try {
    const dir = path.join(root, "models", "qwen3.5-9b");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Qwen3.5-9B-Q4_K_M.gguf"), "");
    await fs.writeFile(path.join(dir, "mmproj-Qwen3.5-9B-BF16.gguf"), "");
    let resolved = runtimePaths(root, { resourcesPath: null });
    assert.equal(resolved.model.id, "qwen3.5-9b"); assert.match(resolved.mmproj, /BF16/); assert.equal(resolved.mmprojOffload, false);
    await fs.writeFile(path.join(dir, "mmproj-Qwen3.5-9B-Q8_0.gguf"), "");
    resolved = runtimePaths(root, { resourcesPath: null });
    assert.match(resolved.mmproj, /Q8_0/); assert.equal(resolved.mmprojOffload, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a warm-up image request runs right after /health, before the first real request", async () => {
  const requests = [];
  const runtime = new EmbeddedRuntime({ paths: paths(), spawnImpl: () => fakeChild(),
    fetchImpl: async (url, init = {}) => { if (url.endsWith("/health")) return { ok: true }; requests.push(JSON.parse(init.body)); return okJson(); } });
  await runtime.completeJson({ system: "s", user: "u", schema: { type: "object" } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, 1);
  assert.match(requests[0].messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
  assert.ok(requests[1].response_format);
  assert.ok(runtime.stats.warmupMs !== null);
  runtime.stop();
});

test("ensure() notices a dead server, restarts it and retries the request", async () => {
  const children = [];
  let chatCalls = 0;
  const runtime = new EmbeddedRuntime({ paths: paths(), spawnImpl: () => { const c = fakeChild(); children.push(c); return c; },
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/health")) return { ok: true };
      if (JSON.parse(init.body).max_tokens === 1) return okJson("");
      chatCalls += 1;
      if (chatCalls === 1) { children.at(-1).stderr.emit("data", "ggml_vulkan: Device memory allocation failed\n"); children.at(-1).emit("exit", 1); throw new TypeError("fetch failed"); }
      return okJson();
    } });
  const reply = await runtime.completeJson({ system: "s", user: "u", schema: {} });
  assert.equal(reply.text, "{\"ok\":true}");
  assert.equal(children.length, 2); assert.equal(runtime.stats.restarts, 1);
  // A server that died between requests is also restarted by ensure().
  children.at(-1).emit("exit", 1);
  await sleep(5);
  assert.equal(runtime.status().running, false);
  await runtime.ensure();
  assert.equal(children.length, 3);
  runtime.stop();
});

test("when the restarted server dies again, the error carries the llama-server stderr", async () => {
  const children = [];
  const runtime = new EmbeddedRuntime({ paths: paths(), spawnImpl: () => { const c = fakeChild(); children.push(c); return c; },
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/health")) return { ok: true };
      if (JSON.parse(init.body).max_tokens === 1) return okJson("");
      const c = children.at(-1); c.stderr.emit("data", "ErrorOutOfDeviceMemory\n"); c.emit("exit", 3); throw new TypeError("fetch failed");
    } });
  await assert.rejects(runtime.completeJson({ system: "s", user: "u", schema: {} }), (error) => /fetch failed/.test(error.message) && /ErrorOutOfDeviceMemory/.test(error.message) && /код 3/.test(error.message));
});

test("a start failure reports the backend, the exit code and stderr", async () => {
  const runtime = new EmbeddedRuntime({ paths: paths(), startTimeoutMs: 2000,
    spawnImpl: () => { const c = fakeChild(); setTimeout(() => { c.stderr.emit("data", "failed to load model\n"); c.emit("exit", 1); }, 5); return c; },
    fetchImpl: async () => { throw new Error("down"); } });
  await assert.rejects(runtime.ensure(), (error) => /vulkan/.test(error.message) && /failed to load model/.test(error.message));
});

// 2. Idle timer.
test("the idle timer never fires while a request is in flight and is armed after the reply", async () => {
  const children = [];
  const runtime = new EmbeddedRuntime({ idleMs: 30, paths: paths(), spawnImpl: () => { const c = fakeChild(); children.push(c); return c; },
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/health")) return { ok: true };
      if (url.endsWith("/slots")) return { ok: true, json: async () => [] };
      if (JSON.parse(init.body).max_tokens === 1) return okJson("");
      await sleep(150); return okJson();
    } });
  const reply = await runtime.completeJson({ system: "s", user: "u", schema: {} });
  assert.equal(reply.text, "{\"ok\":true}");
  assert.equal(children[0].killed, false, "killed during the request");
  assert.equal(runtime.status().running, true);
  await sleep(90);
  assert.equal(children[0].killed, true); assert.equal(runtime.status().running, false);
});

test("the idle stop is postponed while another process uses the shared server", async () => {
  let busy = true;
  const child = fakeChild();
  const runtime = new EmbeddedRuntime({ idleMs: 20, paths: paths(), spawnImpl: () => child,
    fetchImpl: async (url) => url.endsWith("/health") ? { ok: true } : url.endsWith("/slots") ? { ok: true, json: async () => [{ is_processing: busy }] } : okJson() });
  await runtime.completeJson({ system: "s", user: "u", schema: {} });
  await sleep(70); assert.equal(child.killed, false);
  busy = false; await sleep(70); assert.equal(child.killed, true);
});

// 3. Shared server through the lock file.
test("a live locked server is reused and never killed by a client that did not start it", async () => {
  const dir = await tmp("lock");
  try {
    const lockFile = path.join(dir, "llm.json");
    await fs.writeFile(lockFile, JSON.stringify({ pid: 4242, port: 5555, model: "qwen3.5-9b", backend: "vulkan" }));
    let spawned = 0; const urls = [];
    const runtime = new EmbeddedRuntime({ paths: paths(), lockFile, pidAliveImpl: (pid) => pid === 4242, spawnImpl: () => { spawned += 1; return fakeChild(); },
      fetchImpl: async (url) => { urls.push(url); return url.endsWith("/health") ? { ok: true } : okJson(); } });
    await runtime.completeJson({ system: "s", user: "u", schema: {} });
    assert.equal(spawned, 0); assert.ok(urls.some((u) => u.startsWith("http://127.0.0.1:5555/v1/chat")));
    assert.equal(runtime.status().attached, true);
    runtime.stop();
    assert.ok(existsSync(lockFile), "attached client removed the owner's lock");
    // A stale lock (dead pid) is ignored: the runtime starts its own server and records it.
    const own = new EmbeddedRuntime({ paths: paths(), lockFile, pidAliveImpl: () => false, spawnImpl: () => { spawned += 1; return fakeChild(); },
      fetchImpl: async (url) => url.endsWith("/health") ? { ok: true } : okJson() });
    await own.ensure();
    assert.equal(spawned, 1);
    const lock = readLock(lockFile); assert.equal(lock.pid, own.pid); assert.equal(lock.ownerPid, process.pid);
    own.stop();
    assert.equal(existsSync(lockFile), false, "owner did not clean up its lock");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("keepAlive leaves the started server running for the next CLI run", async () => {
  const dir = await tmp("keep");
  try {
    const lockFile = path.join(dir, "llm.json");
    const child = fakeChild();
    const runtime = new EmbeddedRuntime({ paths: paths(), lockFile, keepAlive: true, spawnImpl: (file, args, options) => { assert.equal(options.detached, true); return child; },
      fetchImpl: async (url) => url.endsWith("/health") ? { ok: true } : okJson() });
    await runtime.ensure();
    runtime.stop();
    assert.equal(child.killed, false); assert.equal(readLock(lockFile).keepAlive, true);
    // `atlas model stop` refuses to kill when the recorded port does not answer (recycled pid).
    const killed = [];
    assert.equal(await stopLockedServer(lockFile, { kill: (pid) => killed.push(pid), fetchImpl: async () => { throw new Error("refused"); } }), null);
    assert.deepEqual(killed, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("CLI model status works without a server", async () => {
  const dir = await tmp("cli");
  const saved = process.env.LOCALAPPDATA; const log = console.log; const lines = [];
  try {
    process.env.LOCALAPPDATA = dir; console.log = (line) => lines.push(String(line));
    assert.equal(await atlasMain(["model", "status", "--json"]), 0);
    assert.equal(JSON.parse(lines[0]).running, false);
  } finally { console.log = log; if (saved === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved; await fs.rm(dir, { recursive: true, force: true }); }
});

// 4. applyFix whitelist and IPC config validation.
test("applyFix only applies whitelisted, valid keys", () => {
  const config = { name: "hero", input: ["/in"], output: "/out", padding: 0, background: "none", formats: ["phaser-hash"] };
  const next = applyFix(config, { output: "C:/Windows", input: ["/etc"], name: "evil", formats: ["godot"], padding: 2, extrude: 1, background: { mode: "auto", tolerance: 32 }, maxSize: 4096, rotate: true, sortBy: "similarity" });
  assert.equal(next.output, "/out"); assert.deepEqual(next.input, ["/in"]); assert.equal(next.name, "hero"); assert.deepEqual(next.formats, ["phaser-hash"]);
  assert.equal(next.rotate, undefined);
  assert.equal(next.padding, 2); assert.equal(next.extrude, 1); assert.deepEqual(next.background, { mode: "auto", tolerance: 32 }); assert.equal(next.maxSize, 4096);
  const { rejected } = sanitizeFix({ padding: -1, fps: 1000, pivot: { x: 2 }, background: { mode: "key", color: "red" }, slice: { mode: "grid", cols: "4" }, trim: "yes", output: "/x" });
  assert.deepEqual(rejected.sort(), ["background", "fps", "output", "padding", "pivot", "slice", "trim"].sort());
  assert.deepEqual(applyFix(config, null), config);
  assert.deepEqual(applyFix(config, { slice: { mode: "grid", cols: 4, rows: 2 } }).slice, { mode: "grid", cols: 4, rows: 2 });
});

test("critic IPC config: known keys, absolute paths, output not a root or the input itself", () => {
  const root = path.parse(process.cwd()).root;
  const input = path.join(root, "sprites", "hero");
  const ok = validateCriticConfig({ name: "hero", input: [input], output: `${input}-atlas`, formats: ["phaser-hash"], padding: 2 });
  assert.deepEqual(ok.input, [input]);
  assert.throws(() => validateCriticConfig({ input: [input], output: `${input}-atlas`, shell: "calc" }), /ключи/);
  assert.throws(() => validateCriticConfig({ input: ["relative"], output: `${input}-atlas` }), /input/);
  assert.throws(() => validateCriticConfig({ input: [input], output: "out" }), /output/);
  assert.throws(() => validateCriticConfig({ input: [input], output: root }), /корнем/);
  assert.throws(() => validateCriticConfig({ input: [input], output: input }), /совпадать/);
  assert.throws(() => validateCriticConfig({ input: [input], output: `${input}-atlas`, name: "../x" }), /name/);
  assert.throws(() => validateCriticConfig(null), /объектом/);
  const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
  assert.match(main, /validateCriticConfig\(request\.config\)/);
  assert.match(main, /reviewedOutputs\.has/);
});

// 5, 6, 8. Build: output inside input, POT within maxSize, stale pages, atomic writes.
async function frames(dir, count, size = 24) {
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 40 + i * 20, g: 90, b: 200 - i * 10, alpha: 1 } } }).png().toFile(path.join(dir, `walk_${String(i).padStart(2, "0")}.png`));
  }
}

test("an output folder inside the input folder is skipped, so rebuilding is stable", async () => {
  const dir = await tmp("nested");
  try {
    await frames(dir, 6);
    const config = { input: [dir], output: path.join(dir, "out"), name: "atlas" };
    const first = await buildAtlas(config);
    const second = await buildAtlas(config);
    assert.equal(first.stats.frames, 6); assert.equal(second.stats.frames, 6);
    assert.ok(!second.atlas.frames.some((f) => f.name === "atlas"));
    const listed = await listImages([dir], { output: path.join(dir, "out") });
    assert.equal(listed.length, 6);
    await assert.rejects(buildAtlas({ input: [dir], output: dir, name: "atlas" }), /must not be the input folder/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("--pot keeps pages within --max-size: largest power of two <= max-size, error if a frame does not fit", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, w: 100, h: 100 }));
  const { pages } = packMaxRects(items, { maxSize: 1000, powerOfTwo: true });
  for (const page of pages) { assert.ok(page.width <= 512 && page.height <= 512, `${page.width}x${page.height}`); assert.equal(page.width & (page.width - 1), 0); }
  assert.ok(pages.length > 1);
  assert.throws(() => packMaxRects([{ id: "big", w: 600, h: 600 }], { maxSize: 1000, powerOfTwo: true }), /largest page 512x512/);
  assert.equal(packMaxRects([{ id: "big", w: 600, h: 600 }], { maxSize: 1000 }).pages[0].width, 600);
  assert.equal(packMaxRects([{ id: "a", w: 600, h: 600 }], { maxSize: 1024, powerOfTwo: true }).pages[0].width, 1024);
});

test("stale page files are removed when the page count drops; writes leave no temp files", async () => {
  const dir = await tmp("pages");
  try {
    const input = path.join(dir, "in"), output = path.join(dir, "out");
    await frames(input, 8, 40);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "notes.txt"), "keep");
    await fs.writeFile(path.join(output, "atlas.preset.json"), "{}");
    const base = { input: [input], output, name: "atlas", formats: ["texturepacker-hash", "phaser-hash"], powerOfTwo: false };
    const many = await buildAtlas({ ...base, maxSize: 90 });
    assert.ok(many.stats.pages > 1);
    let names = await fs.readdir(output);
    assert.ok(names.includes("atlas-0.png") && names.includes("atlas-1.png"));
    const one = await buildAtlas({ ...base, maxSize: 2048 });
    assert.equal(one.stats.pages, 1);
    names = await fs.readdir(output);
    assert.ok(names.includes("atlas.png"));
    assert.ok(!names.some((n) => /^atlas-\d+\./.test(n)), names.join(","));
    assert.ok(names.includes("notes.txt") && names.includes("atlas.preset.json"));
    assert.ok(!names.some((n) => n.endsWith(".tmp")));
    assert.ok(one.removedStale.includes("atlas-0.png"));
    // And back to several pages: the single-page files go.
    await buildAtlas({ ...base, maxSize: 90 });
    names = await fs.readdir(output);
    assert.ok(!names.includes("atlas.png") && !names.includes("atlas.json"), names.join(","));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("watch snapshot ignores the output folder (no rebuild loop)", async () => {
  const source = readFileSync(new URL("../scripts/atlas.mjs", import.meta.url), "utf8");
  assert.match(source, /listImages\(sources, \{ output: outputs \}\)/);
  assert.match(source, /shared: true/);
  assert.doesNotMatch(source, /idleMs: 5000/);
});

// 7. Model labels come from the runtime.
test("copilot model labels come from the runtime, not a hard-coded 4B name", async () => {
  const runtime = { status: () => ({ available: true, missing: [], model: "qwen3.5-9b", modelLabel: "Qwen3.5 9B" }),
    completeJson: async () => ({ text: JSON.stringify({ scenarios: [{ task: "edit", why: "ok" }], advice: [] }), elapsedMs: 1 }) };
  const status = await plannerStatus(runtime);
  assert.equal(status.models[0].name, "qwen3.5-9b"); assert.equal(status.models[0].label, "Qwen3.5 9B");
  const plan = await planWithCopilot({ planner: "qwen", snapshot: { source: { kind: "frames", frameCount: 2 } } }, runtime);
  assert.equal(plan.model, "qwen3.5-9b");
  for (const file of ["../src/copilot-planner.mjs", "../src/companion.js", "../src/main.mjs"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /qwen3-vl:4b|Qwen 3 VL · 4B|models\/qwen3-vl-4b\)/, file);
  }
});
