import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export function assertProject(project) {
  if (project?.format !== "chuba-sprite-lab-project" || !project.source) throw new Error("Файл не является проектом Chuba Sprite Lab.");
}
export function mapProjectPaths(project, map) {
  const result = structuredClone(project);
  // A caller may share objects between the active document and animation snapshots.
  // Break those aliases before mapping: each path must be rewritten exactly once.
  for (const animation of result.animations || []) if (animation.document) animation.document = structuredClone(animation.document);
  const documents = [result, ...(result.animations || []).map(item => item.document).filter(Boolean)];
  for (const doc of documents) {
    if (doc.source) {
      doc.source.paths = (doc.source.paths || []).map(map);
      if (doc.source.sheetPath) doc.source.sheetPath = map(doc.source.sheetPath);
      if(doc.source.frameDocuments)doc.source.frameDocuments=Object.fromEntries(Object.entries(doc.source.frameDocuments).map(([index,item])=>[index,{path:map(item.path),imagePath:map(item.imagePath)}]));
    }
    doc.frameOverrides = Object.fromEntries(Object.entries(doc.frameOverrides || {}).map(([index, file]) => [index, map(file)]));
    if (doc.frameDocuments) doc.frameDocuments = Object.fromEntries(Object.entries(doc.frameDocuments).map(([index, item]) => [index, { path: map(item.path), imagePath: map(item.imagePath) }]));
    for (const record of Object.values(doc.preparedCleanup || {})) if (record.imagePath) record.imagePath = map(record.imagePath);
    doc.attachments = (doc.attachments || []).map(item => {
      if (!item.path) return item;
      const file = map(item.path);
      return { ...item, path: file, url: path.isAbsolute(file) ? pathToFileURL(file).href : undefined };
    });
    if (doc.controls?.auxMaskPath) doc.controls.auxMaskPath = map(doc.controls.auxMaskPath);
  }
  return result;
}
export async function missingProjectFiles(project) {
  const files = new Set(); mapProjectPaths(project, file => { files.add(file); return file; });
  const missing = [];
  for (const file of files) if (!await fs.stat(file).then(item => item.isFile(), () => false)) missing.push(file);
  return missing;
}
export async function fileRevision(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function loadPortableProject(projectPath, { backup = false } = {}) {
  const file = backup ? `${projectPath}.bak` : projectPath;
  const project = JSON.parse(await fs.readFile(file, "utf8")); assertProject(project);
  const base = path.dirname(projectPath);
  const resolved = mapProjectPaths(project, name => path.resolve(base, name));
  // Output is a preference, never a prerequisite for opening a project.
  for (const doc of [resolved, ...(resolved.animations || []).map(item => item.document).filter(Boolean)]) {
    if (doc.outputFolder && !path.isAbsolute(doc.outputFolder)) doc.outputFolder = path.resolve(base, doc.outputFolder);
  }
  return { project: resolved, revision: await fileRevision(projectPath).catch(() => null), recovered: backup };
}
export async function savePortableProject(projectPath, project, { expectedRevision } = {}) {
  assertProject(project); projectPath = path.resolve(projectPath);
  const base = path.dirname(projectPath); await fs.mkdir(base, { recursive: true });
  const lockPath = `${projectPath}.lock`;
  let lock;
  try { lock = await fs.open(lockPath, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try { owner = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch { owner = {}; }
    let alive = true;
    if (Number.isInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (failure) { alive = failure.code !== "ESRCH"; } }
    else alive = Date.now() - (await fs.stat(lockPath)).mtimeMs < 30_000;
    if (alive) throw new Error("Проект сохраняется в другом окне. Дождитесь завершения или сохраните копию.");
    await fs.unlink(lockPath); lock = await fs.open(lockPath, "wx");
  }
  const tempPath = `${projectPath}.${crypto.randomUUID()}.tmp`;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
    const currentRevision = await fileRevision(projectPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) throw new Error("Проект изменён в другом окне. Откройте свежую версию или используйте «Сохранить как», чтобы сохранить свою копию.");
    const assetDir = path.join(base, `${path.basename(projectPath, ".cslab")}.assets`);
    await fs.mkdir(assetDir, { recursive: true });
    const mapping = new Map();
    mapProjectPaths(project, file => { mapping.set(path.resolve(file), null); return file; });
    // Content-addressed assets are immutable: an interrupted save cannot damage
    // the previous project or its backup. Streaming hashes also handle videos.
    for (const file of mapping.keys()) {
      const hash = await fileRevision(file);
      const name = path.basename(file).replace(/^[a-f0-9]{64}-/, "");
      const target = path.join(assetDir, `${hash}-${name}`);
      if (path.resolve(file) !== target) {
        try {
          await fs.copyFile(file, target, 1);
          if (await fileRevision(target) !== hash) {
            await fs.unlink(target);
            throw new Error(`Исходник изменился во время сохранения: ${name}. Повторите сохранение.`);
          }
        }
        catch (error) { if (error.code !== "EEXIST") throw error; if (await fileRevision(target) !== hash) throw new Error(`Повреждён файл проекта: ${name}`); }
      }
      mapping.set(file, path.relative(base, target).split(path.sep).join("/"));
    }
    const saved = mapProjectPaths(project, file => mapping.get(path.resolve(file)));
    saved.savedAt = new Date().toISOString(); saved.storageVersion = 2;
    for (const doc of [saved, ...(saved.animations || []).map(item => item.document).filter(Boolean)]) {
      doc.outputFolder = `${path.basename(projectPath, ".cslab")}-exports`;
    }
    const temp = await fs.open(tempPath, "wx");
    try { await temp.writeFile(`${JSON.stringify(saved, null, 2)}\n`, "utf8"); await temp.sync(); } finally { await temp.close(); }
    if (await fileRevision(projectPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;}) !== currentRevision) throw new Error('Проект изменён во время сохранения. Используйте «Сохранить как».');
    if (currentRevision) {
      // Do not replace the good recovery copy with a corrupt project.
      try { assertProject(JSON.parse(await fs.readFile(projectPath, "utf8"))); await fs.copyFile(projectPath, `${projectPath}.bak`); }
      catch (error) { if (!(error instanceof SyntaxError) && !/Файл не является/.test(error.message)) throw error; }
    }
    await fs.rename(tempPath, projectPath);
    return { projectPath, ...(await loadPortableProject(projectPath)) };
  } finally {
    await fs.unlink(tempPath).catch(() => {}); await lock.close(); await fs.unlink(lockPath);
  }
}
