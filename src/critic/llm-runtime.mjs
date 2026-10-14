import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Embedded vision runtime: the official llama.cpp llama-server (multimodal, mtmd) shipped
// in vendor/llm, weights in models/<model directory>. Started lazily on 127.0.0.1 with a
// random free port. No Ollama, no network access beyond the loopback port.
//
// One server per machine: when `shared` is set (GUI and CLI), the server is recorded in a
// lock file (%LOCALAPPDATA%\ChubaSpriteLab\llm.json: pid, port, model) and other processes
// attach to it instead of loading the weights again. A process only ever stops a server it
// started itself; an attached client just disconnects.

// Primary acceptance critic: Qwen3.5-9B Q4_K_M, context 4096 (8192 overflows the 8 GB card).
// There is no official Q8_0 mmproj for it, so the BF16 projector stays on the CPU
// (--no-mmproj-offload) to keep VRAM headroom for the first image request; a Q8_0 file
// dropped next to the weights is preferred and offloaded. Qwen3-VL-4B is the fallback.
export const criticModels = Object.freeze([
  Object.freeze({ id: "qwen3.5-9b", label: "Qwen3.5 9B", directory: "qwen3.5-9b", weights: "Qwen3.5-9B-Q4_K_M.gguf", mmproj: "mmproj-Qwen3.5-9B-BF16.gguf",
    mmprojCandidates: Object.freeze([{ file: "mmproj-Qwen3.5-9B-Q8_0.gguf", offload: true }, { file: "mmproj-Qwen3.5-9B-BF16.gguf", offload: false }]), contextSize: 4096, noThinking: true }),
  Object.freeze({ id: "qwen3-vl-4b-instruct", label: "Qwen3-VL 4B", directory: "qwen3-vl-4b", weights: "Qwen3VL-4B-Instruct-Q4_K_M.gguf", mmproj: "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
    mmprojCandidates: Object.freeze([{ file: "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf", offload: true }]), contextSize: 8192, noThinking: false }),
]);
export const embeddedModel = criticModels[0];
export const fallbackModel = criticModels[1];
const backends = ["vulkan", "cpu"]; // GPU first, CPU fallback.
export const defaultIdleMs = 600000; // 10 min, well above the 120 s request timeout.
const sleepIdleSeconds = 600; // safety net for orphaned servers: llama-server unloads itself.
// 64x64 grey PNG with a blue square: allocates the vision buffers right after /health.
const warmupPng = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAA2ElEQVR4nO2awQ3DMAzEuEwn65g3UodQx2CD8sE/YSS2pBPb7p/BFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFnj8AbzeH5UOYH0B1y+w7oDrElyvwPUMrjrgKoRWJXiVwqsXuJqh1Q1e7fCaB1wDkTURukZiayZ4DUXXVPgai69c4ApGVjJ0RWMrG7zC0ZUOX/H4WpC4NkT2A2sqj16R2cPBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrDBFrD5ArnwCtF79J9lAAAAAElFTkSuQmCC";

export function defaultLockFile() { return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "ChubaSpriteLab", "llm.json"); }

export function runtimePaths(appRoot, { resourcesPath = process.resourcesPath } = {}) {
  const roots = [resourcesPath, appRoot].filter(Boolean);
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const find = (...parts) => roots.map((root) => path.join(root, ...parts)).find((file) => fs.existsSync(file)) || null;
  const servers = backends.map((backend) => ({ backend, file: find("vendor", "llm", backend, exe) })).filter((entry) => entry.file);
  const resolve = (model) => {
    const projector = (model.mmprojCandidates || [{ file: model.mmproj, offload: true }]).map((c) => ({ ...c, path: find("models", model.directory, c.file) })).find((c) => c.path);
    return { model, weights: find("models", model.directory, model.weights), mmproj: projector?.path || null, mmprojOffload: projector ? projector.offload : true,
      skills: find("models", model.directory, "skills") };
  };
  const candidates = criticModels.map(resolve);
  const chosen = candidates.find((entry) => entry.weights && entry.mmproj) || candidates[0];
  return { servers, ...chosen };
}

/** llama-server arguments: flash attention and a q8_0 KV cache to stay inside 8 GB VRAM. */
export function serverArgs(paths, server, port) {
  const model = paths.model || embeddedModel;
  const gpu = server.backend !== "cpu";
  return ["-m", paths.weights, "--mmproj", paths.mmproj, "--host", "127.0.0.1", "--port", String(port),
    "-c", String(model.contextSize || 4096), "-ngl", gpu ? "99" : "0", "--no-webui", "-np", "1",
    "-fa", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0",
    ...(!gpu || paths.mmprojOffload === false ? ["--no-mmproj-offload"] : []),
    "--sleep-idle-seconds", String(sleepIdleSeconds)];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function readLock(file) {
  try { const lock = JSON.parse(fs.readFileSync(file, "utf8")); return lock && Number.isInteger(lock.port) && Number.isInteger(lock.pid) ? lock : null; } catch { return null; }
}

function writeLock(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function removeLock(file, pid) {
  if (!file) return;
  const lock = readLock(file);
  if (lock && lock.pid === pid) try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

const tail = (text, lines = 3) => String(text || "").trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(" | ").slice(-600);

export class EmbeddedRuntime {
  constructor({ appRoot, resourcesPath, idleMs = defaultIdleMs, startTimeoutMs = 120000, warmupTimeoutMs = 90000, spawnImpl = spawn, fetchImpl = fetch, paths = null,
    shared = false, lockFile, keepAlive = false, pidAliveImpl = pidAlive } = {}) {
    this.paths = paths || runtimePaths(appRoot, { resourcesPath });
    this.idleMs = idleMs; this.startTimeoutMs = startTimeoutMs; this.warmupTimeoutMs = warmupTimeoutMs;
    this.spawn = spawnImpl; this.fetch = fetchImpl; this.pidAlive = pidAliveImpl;
    this.lockFile = lockFile !== undefined ? lockFile : shared ? defaultLockFile() : null;
    this.keepAlive = keepAlive;
    this.child = null; this.childAlive = false; this.pid = null; this.port = null; this.backend = null; this.attached = false;
    this.starting = null; this.idleTimer = null; this.inflight = 0; this.stderr = ""; this.lastExit = null;
    this.stats = { coldStartMs: null, warmupMs: null, starts: 0, restarts: 0, attached: 0 };
  }

  status() {
    const ready = Boolean(this.paths.weights && this.paths.mmproj && this.paths.servers.length);
    const model = this.paths.model || embeddedModel;
    return { available: ready, running: Boolean(this.port), attached: this.attached, backend: this.backend, model: model.id, modelLabel: model.label || model.id, contextSize: model.contextSize,
      mmprojOffload: this.paths.mmprojOffload !== false,
      missing: [!this.paths.servers.length && "vendor/llm", !this.paths.weights && model.weights, !this.paths.mmproj && model.mmproj].filter(Boolean) };
  }

  url() { return `http://127.0.0.1:${this.port}`; }

  async healthy(port, timeoutMs = 1500) {
    try { const response = await this.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) }); return Boolean(response.ok); } catch { return false; }
  }

  /** True when the server we use is still there (own child alive, or locked pid alive and healthy). */
  async isUp() {
    if (!this.port) return false;
    if (this.attached) return this.pidAlive(this.pid) && await this.healthy(this.port);
    return this.childAlive;
  }

  forget(reason) {
    if (reason) this.lastExit = reason;
    this.child = null; this.childAlive = false; this.port = null; this.pid = null; this.attached = false; this.backend = null;
  }

  async ensure() {
    if (this.port) {
      if (await this.isUp()) return this.url();
      this.forget(this.lastExit || "сервер модели перестал отвечать");
      this.stats.restarts += 1;
    }
    if (!this.starting) this.starting = this.connectOrStart().finally(() => { this.starting = null; });
    await this.starting;
    return this.url();
  }

  async connectOrStart() {
    const status = this.status();
    if (!status.available) throw new Error(`Встроенная модель недоступна: нет ${status.missing.join(", ")}.`);
    if (this.lockFile) {
      const lock = readLock(this.lockFile);
      if (lock && lock.model === status.model && this.pidAlive(lock.pid) && await this.healthy(lock.port, 2000)) {
        this.port = lock.port; this.pid = lock.pid; this.backend = lock.backend || null; this.attached = true; this.stats.attached += 1;
        return;
      }
    }
    await this.start();
  }

  async start() {
    const started = performance.now();
    let lastError = null;
    for (const server of this.paths.servers) {
      const port = await freePort();
      const args = serverArgs(this.paths, server, port);
      let logFd = null, logFile = null;
      if (this.keepAlive && this.lockFile) {
        logFile = path.join(path.dirname(this.lockFile), "llm-server.log");
        fs.mkdirSync(path.dirname(logFile), { recursive: true }); logFd = fs.openSync(logFile, "w");
      }
      const child = this.spawn(server.file, args, { cwd: path.dirname(server.file), windowsHide: true, detached: Boolean(logFd !== null), stdio: ["ignore", "ignore", logFd ?? "pipe"] });
      if (logFd !== null) fs.closeSync(logFd);
      this.stderr = "";
      const readStderr = () => (logFile ? (() => { try { return fs.readFileSync(logFile, "utf8").slice(-4000); } catch { return ""; } })() : this.stderr);
      child.stderr?.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
      let exitCode = null;
      const exited = new Promise((resolve) => child.once("exit", (code) => { exitCode = code; resolve(code); }));
      this.readStderr = readStderr;
      try {
        await this.waitHealthy(port, exited);
        const warmStarted = performance.now();
        await this.warmUp(port, exited);
        this.stats.warmupMs = Math.round(performance.now() - warmStarted);
        this.child = child; this.childAlive = true; this.pid = child.pid ?? null; this.port = port; this.backend = server.backend; this.attached = false;
        exited.then((code) => {
          if (this.child !== child) return;
          this.forget(`llama-server завершился (код ${code})${tail(readStderr()) ? `: ${tail(readStderr())}` : ""}`);
          removeLock(this.lockFile, child.pid);
        });
        if (this.lockFile && child.pid) writeLock(this.lockFile, { pid: child.pid, port, model: this.status().model, backend: server.backend, ownerPid: process.pid, keepAlive: this.keepAlive, startedAt: new Date().toISOString() });
        this.stats.coldStartMs = Math.round(performance.now() - started); this.stats.starts += 1;
        return;
      } catch (error) {
        const why = tail(readStderr());
        lastError = new Error(`${server.backend}: ${error.message}${exitCode !== null ? ` (код ${exitCode})` : ""}${why ? ` · llama-server: ${why}` : ""}`);
        try { child.kill(); } catch { /* already gone */ }
      }
    }
    throw lastError || new Error("llama-server не запустился.");
  }

  async waitHealthy(port, exited) {
    const deadline = Date.now() + this.startTimeoutMs;
    let gone = false; exited.then(() => { gone = true; });
    while (Date.now() < deadline) {
      if (gone) throw new Error("процесс завершился при запуске");
      if (await this.healthy(port, 2000)) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("таймаут проверки готовности");
  }

  /** One tiny image request so the vision buffers are allocated before the real review. */
  async warmUp(port, exited) {
    let gone = false; exited.then(() => { gone = true; });
    let response;
    try {
      response = await this.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(this.warmupTimeoutMs),
        body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${warmupPng}` } }, { type: "text", text: "OK" }] }], max_tokens: 1, temperature: 0,
          ...((this.paths.model || embeddedModel).noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}) }),
      });
    } catch (error) { throw new Error(`прогрев не прошёл: ${error.message}`); }
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (gone) throw new Error("процесс завершился на прогреве");
    if (!response.ok) throw new Error(`прогрев: HTTP ${response.status}`);
  }

  diagnostics() {
    const why = tail(this.readStderr?.() ?? this.stderr);
    return `${this.lastExit ? ` · ${this.lastExit}` : why ? ` · llama-server: ${why}` : ""}`;
  }

  /** Arms the idle timer; never while a request is in flight, never for an attached server. */
  touch() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    if (this.inflight > 0 || this.attached || !this.child || this.keepAlive) return;
    this.idleTimer = setTimeout(() => { void this.idleStop(); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  async idleStop() {
    if (this.inflight > 0) return;
    // Another process may be using our server through the lock file.
    try {
      const response = await this.fetch(`${this.url()}/slots`, { signal: AbortSignal.timeout(1500) });
      const slots = response.ok ? await response.json() : [];
      if (Array.isArray(slots) && slots.some((slot) => slot.is_processing)) { this.touch(); return; }
    } catch { /* treat as idle */ }
    if (this.inflight > 0) return;
    this.stop();
  }

  /** Disconnects; kills the server only when this process started it and keepAlive is off. */
  stop() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    const child = this.child, owned = Boolean(child) && !this.attached;
    this.forget(null);
    if (!owned) return;
    if (this.keepAlive) { try { child.unref?.(); } catch { /* ignore */ } return; }
    removeLock(this.lockFile, child.pid);
    try { child.kill(); } catch { /* already gone */ }
  }

  /** One chat completion with images and a JSON schema; restarts a crashed server once. */
  async completeJson({ system, user, images = [], schema, temperature = 0, seed = 42, maxTokens = 800, timeoutMs = 120000 }) {
    this.inflight += 1; clearTimeout(this.idleTimer); this.idleTimer = null;
    try {
      const content = [...images.map((png) => ({ type: "image_url", image_url: { url: `data:${Buffer.from(png)[0] === 0xff ? "image/jpeg" : "image/png"};base64,${Buffer.from(png).toString("base64")}` } })), { type: "text", text: user }];
      const body = JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content }], temperature, seed, max_tokens: maxTokens,
        ...((this.paths.model || embeddedModel).noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true, schema } } });
      let response, started;
      for (let attempt = 1; ; attempt += 1) {
        const url = await this.ensure();
        started = performance.now();
        try {
          response = await this.fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs), body });
          break;
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const up = await this.isUp();
          if (!up && attempt < 2) { this.forget(this.lastExit || "сервер модели упал во время запроса"); this.stats.restarts += 1; continue; }
          throw new Error(`${error.message}${this.diagnostics()}`);
        }
      }
      if (!response.ok) throw new Error(`llama-server HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
      const parsed = await response.json();
      const text = parsed.choices?.[0]?.message?.content ?? "";
      return { text, elapsedMs: Math.round(performance.now() - started), usage: parsed.usage || null, timings: parsed.timings || null };
    } finally {
      this.inflight -= 1;
      this.touch();
    }
  }
}

/** Stops the server recorded in the lock file (`atlas model stop`) after confirming it answers
 * on the recorded port, so a recycled pid is never killed. Returns the pid or null. */
export async function stopLockedServer(lockFile = defaultLockFile(), { kill = (pid) => process.kill(pid), fetchImpl = fetch } = {}) {
  const lock = readLock(lockFile);
  if (!lock) return null;
  let ours = false;
  try { ours = (await fetchImpl(`http://127.0.0.1:${lock.port}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { ours = false; }
  if (ours && pidAlive(lock.pid)) try { kill(lock.pid); } catch { /* gone */ }
  try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
  return ours ? lock.pid : null;
}

let shared = null;
export function sharedRuntime(options) { if (!shared) shared = new EmbeddedRuntime({ shared: true, ...options }); return shared; }
export function stopSharedRuntime() { shared?.stop(); }
