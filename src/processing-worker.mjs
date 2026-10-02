import { processSprites, processAnimationSet, processVideoBatch, processFramePreview } from "./processor.mjs";
import { processImageBatch } from "./image-batch.mjs";

const operations = { processSprites, processAnimationSet, processVideoBatch, processFramePreview, processImageBatch };
let current;
process.on("message", async message => {
  if (message.type === "cancel") { current?.controller.abort(); return; }
  if (message.type === "stop") { if (current) current.stop = true; return; }
  if (message.type !== "run") return;
  const operation = operations[message.operation];
  if (!operation || current) { process.send?.({ type: "error", id: message.id, message: "Исполнитель занят или операция неизвестна." }); return; }
  current = { controller: new AbortController(), stop: false };
  try {
    const result = await operation({ ...message.payload, signal: current.controller.signal, shouldStop: () => current?.stop === true, onProgress: progress => process.send?.({ type: "progress", id: message.id, progress }) });
    process.send?.({ type: "result", id: message.id, result });
  } catch (error) { process.send?.({ type: "error", id: message.id, message: error.message, name: error.name }); }
  finally { current = null; }
});
process.on("disconnect", () => process.exit(0));
