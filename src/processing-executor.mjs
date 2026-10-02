import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// One persistent isolated process owns Sharp, ONNX and the stage caches. Main only
// receives paths/metadata; no RGBA frames cross IPC. Killing inference on cancellation
// cannot leave the UI blocked. Export publication remains atomic in the processor.
export class ProcessingExecutor {
  constructor({ workerPath = fileURLToPath(new URL("./processing-worker.mjs", import.meta.url)), maxQueue = 8 } = {}) {
    this.workerPath = workerPath; this.maxQueue = maxQueue; this.queue = []; this.sequence = 0; this.current = null; this.child = null;
  }
  run(operation, payload, { signal, onProgress } = {}) {
    if (signal?.aborted) return Promise.reject(new Error("Обработка отменена."));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new Error("Слишком много ожидающих заданий."));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.sequence, operation, payload, resolve, reject, onProgress, signal };
      job.abort = () => {
        if (this.current === job) {
          const child = this.child;
          this.finish(job, new Error("Обработка отменена."));
          // Stop inference immediately: most native ONNX calls cannot poll AbortSignal.
          this.child = null; child?.kill(); this.pump();
        } else { this.queue = this.queue.filter(item => item !== job); job.signal?.removeEventListener("abort", job.abort); reject(new Error("Обработка отменена.")); }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job); this.pump();
    });
  }
  start() {
    if (this.child) return;
    const child = fork(this.workerPath, [], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
    this.child = child;
    child.on("message", message => {
      if (this.child !== child || this.current?.id !== message.id) return;
      const job = this.current;
      if (message.type === "progress") job.onProgress?.(message.progress);
      else if (message.type === "result") { this.finish(job, null, message.result); this.pump(); }
      else if (message.type === "error") { this.finish(job, new Error(message.message)); this.pump(); }
    });
    const failed = error => {
      if (this.child !== child) return;
      this.child = null;
      if (this.current) this.finish(this.current, error instanceof Error ? error : new Error("Исполнитель остановился. Повторите обработку."));
      this.pump();
    };
    child.on("error", failed); child.on("exit", failed);
  }
  finish(job, error, result) {
    job.signal?.removeEventListener("abort", job.abort); this.current = null;
    if (error) job.reject(error); else job.resolve(result);
  }
  pump() {
    if (this.current || !this.queue.length) return;
    this.start(); this.current = this.queue.shift();
    this.child.send({ type: "run", id: this.current.id, operation: this.current.operation, payload: this.current.payload });
  }
  stopAfterCurrent() { this.child?.send({ type: "stop" }); }
  close() {
    const child = this.child; this.child = null;
    if (this.current) this.finish(this.current, new Error("Исполнитель закрыт."));
    for (const job of this.queue.splice(0)) { job.signal?.removeEventListener("abort", job.abort); job.reject(new Error("Исполнитель закрыт.")); }
    child?.kill();
  }
}
