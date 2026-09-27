import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { savePortableProject, loadPortableProject, missingProjectFiles } from "../src/project-storage.mjs";

const document = file => ({ format: "chuba-sprite-lab-project", source: { kind: "frames", paths: [file, file] }, frameOverrides: { 1: file }, attachments: [{ path: file }], controls: { auxMaskPath: file }, timeline: [{ src: 1 }] });
test("portable project carries original sources, edits, masks and other animations when moved", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cslab-project-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "original.png"); await fs.writeFile(input, "fixture");
  const project = document(input); project.animations = [{ id: "b", document: document(input) }];
  const old = path.join(root, "drive-a", "sample.cslab"); const saved = await savePortableProject(old, project);
  assert.ok(path.isAbsolute(saved.project.source.paths[0]));
  const disk = JSON.parse(await fs.readFile(old, "utf8")); assert.ok(!path.isAbsolute(disk.source.paths[0]));
  await fs.rename(path.dirname(old), path.join(root, "drive-b")); await fs.unlink(input);
  const loaded = await loadPortableProject(path.join(root, "drive-b", "sample.cslab"));
  assert.deepEqual(await missingProjectFiles(loaded.project), []);
  assert.equal(loaded.project.source.paths.length, 2); assert.equal(loaded.project.timeline[0].src, 1);
  assert.equal(await fs.readFile(loaded.project.animations[0].document.frameOverrides[1], "utf8"), "fixture");
});
test("concurrent revision conflicts and interrupted saves preserve the last good project", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cslab-project-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "original.png"), target = path.join(root, "test.cslab"); await fs.writeFile(input, "first");
  const first = await savePortableProject(target, document(input));
  await fs.writeFile(input, "second"); const second = await savePortableProject(target, document(input), { expectedRevision: first.revision });
  await assert.rejects(savePortableProject(target, document(input), { expectedRevision: first.revision }), /другом окне/);
  assert.equal((await loadPortableProject(target)).revision, second.revision);
  await fs.unlink(input); await assert.rejects(savePortableProject(target, document(input), { expectedRevision: second.revision }));
  assert.equal((await loadPortableProject(target)).revision, second.revision);
  await fs.writeFile(target, "{broken");
  const recovered = await loadPortableProject(target, { backup: true });
  assert.equal(await fs.readFile(recovered.project.source.paths[0], "utf8"), "first");
  assert.deepEqual(await missingProjectFiles(recovered.project), []);
});
test("missing sources are reported without dropping or reordering frames", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cslab-project-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "missing.png"), doc = document(file);
  assert.deepEqual(await missingProjectFiles(doc), [file]); assert.deepEqual(doc.source.paths, [file, file]);
});
test("save locks reject active writers and recover abandoned incomplete locks", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cslab-lock-")); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input=path.join(root,'original.png'), target=path.join(root,'locked.cslab');await fs.writeFile(input,'asset');
  await fs.writeFile(target+'.lock',JSON.stringify({pid:process.pid}));
  await assert.rejects(savePortableProject(target,document(input)),/другом окне/);
  await fs.writeFile(target+'.lock','{partial');
  await assert.rejects(savePortableProject(target,document(input)),/другом окне/);
  const old=new Date(Date.now()-60_000);await fs.utimes(target+'.lock',old,old);
  const result=await savePortableProject(target,document(input));
  assert.deepEqual(await missingProjectFiles(result.project),[]);
  assert.equal(await fs.stat(target+'.lock').then(()=>true,()=>false),false);
});
