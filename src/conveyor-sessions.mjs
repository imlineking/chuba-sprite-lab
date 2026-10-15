import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CheckpointStore, checkpointRoots, hydrateCheckpoint, relocateCheckpoint } from "./conveyor-checkpoints.mjs";
import { runConveyor } from "./conveyor.mjs";

async function filesUnder(root) {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) return [path.resolve(root)];
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Продолжение недоступно для папки с символьными ссылками.");
    files.push(...await filesUnder(path.join(root, entry.name)));
  }
  return files;
}
async function fingerprint(roots, signal) {
  const files = [...new Set((await Promise.all(roots.filter(Boolean).map(filesUnder))).flat())].sort();
  const result = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal: signal || undefined })) hash.update(chunk);
    result.push([file, hash.digest("hex")]);
  }
  return JSON.stringify(result);
}

// Opaque checkpoints are owned by the main process; disk records contain no raw atlas buffers.
export class ConveyorSessions {
  constructor(deps, { ttlMs, directory = null } = {}) {
    this.deps = deps; this.ttlMs = ttlMs ?? (directory ? 7 * 24 * 60 * 60 * 1000 : 20 * 60 * 1000);
    this.store = directory ? new CheckpointStore(directory) : null; this.last = null; this.records = new Map(); this.ready = this.store?.prune(this.ttlMs) || Promise.resolve();
  }
  clear() { clearTimeout(this.timer); this.last = null; }
  async discard(slot = "direct") {
    const session = this.records.get(slot) || await this.store?.read(slot);
    this.records.delete(slot); if (slot === "direct") this.clear();
    await this.store?.remove(slot, session);
  }
  async pending(slot = "direct") {
    await this.ready;
    const s = this.records.get(slot) || await this.store?.read(slot) || (slot === "direct" ? this.last : null);
    if (!s) return null;
    if (Date.now() - s.at > this.ttlMs) { await this.discard(slot); return null; }
    this.records.set(slot, s); if (slot === "direct") this.last = s;
    return { resumeId: s.id, stage: s.stage, error: s.error, at: s.at, request: s.args, hasCheckpoint: Boolean(s.checkpoint?.source) };
  }
  async resumeSaved({ resumeId, outputDir, slot = "direct", ...callbacks }) {
    const saved = await this.pending(slot);
    if (!saved || saved.resumeId !== resumeId) return { ok: false, resumeInvalid: true, error: "Сохранённая задача недоступна. Запустите обработку заново." };
    return this.run({ ...saved.request, ...(outputDir !== undefined ? { outputDir, quick: !outputDir } : {}), ...callbacks, resumeId, slot });
  }
  async run(request) {
    await this.ready;
    const { resumeId, slot = "direct", onSaved = async () => {}, ...args } = request;
    // Moving output is allowed; all processing choices still have to match.
    const signature = JSON.stringify([args.paths, args.preset, args.intent, args.name]);
    let session;
    if (resumeId) {
      session = this.records.get(slot) || (slot === "direct" ? this.last : null) || await this.store?.read(slot);
      try {
        if (!session || session.id !== resumeId || session.signature !== signature || Date.now() - session.at > this.ttlMs) throw new Error("Сеанс продолжения устарел или настройки изменены.");
        if (await fingerprint(session.inputRoots, args.signal) !== session.inputHash || await fingerprint(session.outputRoots, args.signal) !== session.outputHash) throw new Error("Исходники или готовые файлы изменены.");
        const detection = await this.deps.detect(args.paths);
        if (JSON.stringify(detection.files || args.paths) !== session.detectedFiles) throw new Error("Состав исходной папки изменён.");
      } catch (error) { await this.discard(slot); return { ok: false, error: `${error.message} Запустите обработку заново.`, resumeInvalid: true }; }
      if (args.outputDir !== session.args.outputDir || args.quick !== session.args.quick) {
        session.checkpoint = await relocateCheckpoint(session.checkpoint, args, JSON.parse(session.outputHash).map(([file]) => file), args.signal);
        session.outputRoots = checkpointRoots(session.checkpoint);
        session.outputHash = await fingerprint(session.outputRoots, args.signal);
      }
    } else {
      await this.discard(slot);
      const detection = await this.deps.detect(args.paths);
      if (["image-set", "frames-folder"].includes(detection.type) && !["images", "atlas", "animation"].includes(args.intent)) return runConveyor({ ...args, deps: this.deps });
      const inputRoots = detection.files || args.paths;
      session = { id: randomUUID(), signature, paths: args.paths, inputRoots, inputHash: await fingerprint(inputRoots, args.signal), outputRoots: [], outputHash: "[]", at: Date.now(), checkpoint: null, detectedFiles: JSON.stringify(inputRoots) };
    }
    session.args = { paths: args.paths, preset: args.preset, intent: args.intent, outputDir: args.outputDir, quick: args.quick, ...(args.name ? { name: args.name } : {}) };
    clearTimeout(this.timer);
    const save = async () => { this.records.set(slot, session); if (slot === "direct") this.last = session; await this.store?.write(slot, session); await onSaved({ resumeId: session.id, stage: session.stage }); };
    await save();
    const restored = await hydrateCheckpoint(session.checkpoint);
    const result = await runConveyor({ ...args, deps: this.deps, resume: restored, onCheckpoint: async checkpoint => {
      const durable = this.store ? await this.store.durable(session, checkpoint, args.signal) : checkpoint;
      const roots = checkpointRoots(durable), outputHash = await fingerprint(roots, args.signal);
      session.checkpoint = durable; session.outputRoots = roots; session.outputHash = outputHash;
      session.at = Date.now(); session.stage = durable.completed.at(-1); session.error = null;
      await save();
    } });
    if (!result.ok && session.checkpoint && !args.signal?.aborted) {
      session.stage = result.failedStage; session.error = result.error; await save();
      if (!this.store && slot === "direct") { this.timer = setTimeout(() => { this.records.delete(slot); this.clear(); }, this.ttlMs); this.timer.unref(); }
      return { ...result, resumeId: session.id };
    }
    await this.discard(slot);
    return result;
  }
}
