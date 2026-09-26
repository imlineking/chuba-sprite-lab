import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { aiModelCatalog, assertDownloadUrl } from "../src/ai-models.mjs";
import { prepareAIModel } from "./prepare-ai-model.mjs";

export async function verifiedModel(filePath, model) {
  try {
    if ((await fs.stat(filePath)).size !== model.sizeBytes) return false;
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex") === model.sha256;
  } catch { return false; }
}

export async function preparePortableModels(appRoot) {
  await prepareAIModel(appRoot);
  const directory = path.join(appRoot, "models");
  const models = aiModelCatalog.filter((model) => model.bundled && model.id !== "u2netp");
  for (const model of models) {
    if (!model.sha256 || !model.url) throw new Error(`Нет закреплённой контрольной суммы для ${model.id}.`);
    const target = path.join(directory, model.file);
    if (await verifiedModel(target, model)) { console.log(`${model.name}: verified local copy`); continue; }
    const temporary = `${target}.download`;
    try {
      const cached = process.env.APPDATA && path.join(process.env.APPDATA, "chuba-sprite-lab", "models", model.file);
      if (cached && await verifiedModel(cached, model)) {
        await fs.copyFile(cached, temporary);
      } else {
        console.log(`${model.name}: downloading ${Math.round(model.sizeBytes / 1024 ** 2)} MB`);
        const response = await fetch(assertDownloadUrl(model.url), { redirect: "follow", signal: AbortSignal.timeout(600000) });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        if (response.url) assertDownloadUrl(response.url, { redirect: true });
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      }
      if (!await verifiedModel(temporary, model)) throw new Error("Размер или SHA-256 не совпадает с каталогом.");
      await fs.rename(temporary, target);
      console.log(`${model.name}: ready`);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw new Error(`${model.name}: ${error.message}`);
    }
  }
  const entries = [];
  for (const model of aiModelCatalog.filter((entry) => entry.bundled)) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(path.join(directory, model.file))) hash.update(chunk);
    entries.push({ id: model.id, file: model.file, sizeBytes: model.sizeBytes, sha256: hash.digest("hex"), source: model.url || "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx", licence: model.licence.name });
  }
  await fs.writeFile(path.join(directory, "bundled-models.json"), `${JSON.stringify({ models: entries }, null, 2)}\n`);
  return entries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePortableModels(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
