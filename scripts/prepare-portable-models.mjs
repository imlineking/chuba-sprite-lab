import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { aiModelCatalog, assertDownloadUrl } from "../src/ai-models.mjs";


export async function verifiedModel(filePath, model) {
  try {
    if ((await fs.stat(filePath)).size !== model.sizeBytes) return false;
    const recorded = !model.sha256 && !model.md5 ? (await fs.readFile(`${filePath}.sha256`, "utf8")).trim() : null;
    const hash = crypto.createHash(model.md5 && !model.sha256 ? "md5" : "sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex") === (model.sha256 || model.md5 || recorded);
  } catch { return false; }
}

export async function preparePortableModels(appRoot) {
  await fs.mkdir(path.join(appRoot, "models"), { recursive: true });
  const directory = path.join(appRoot, "models");
  const models = aiModelCatalog.filter(model => model.bundled);
  for (const model of models) {
    const target = path.join(directory, model.file);
    if (await verifiedModel(target, model)) { console.log(`${model.name}: verified local copy`); continue; }
    if (!model.url) throw new Error(`${model.name}: нет проверенного локального ONNX-export. См. docs/TOONOUT.md; сборка остановлена без скачивания подмены.`);
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
      if ((await fs.stat(temporary)).size !== model.sizeBytes) throw new Error("Размер не совпадает с официальным выпуском.");
      if ((model.sha256 || model.md5) && !await verifiedModel(temporary, model)) throw new Error("Контрольная сумма не совпадает с источником.");
      const hash = crypto.createHash("sha256");
      for await (const chunk of createReadStream(temporary)) hash.update(chunk);
      await fs.writeFile(`${target}.sha256`, hash.digest("hex"));
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
    entries.push({ id: model.id, file: model.file, sizeBytes: model.sizeBytes, sha256: hash.digest("hex"), source: model.source || model.url, licence: model.licence.name });
  }
  await fs.writeFile(path.join(directory, "bundled-models.json"), `${JSON.stringify({ models: entries }, null, 2)}\n`);
  return entries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePortableModels(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
