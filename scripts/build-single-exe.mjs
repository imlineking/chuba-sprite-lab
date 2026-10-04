// Build a single offline Windows executable without NSIS' large-archive limit.
// Always archive the freshly built portable directory; never reuse an old bundle.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { getPath7za } from "app-builder-lib/out/toolsets/7zip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const version = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8")).version;
const archive = path.join(root, ".build", "one-file", `chuba-sprite-lab-${version}-x64.nsis.7z`);
const portable = path.join(root, "portable");
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const stub = path.join(root, ".build", "one-file", "single-exe-launcher.exe");
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, `.build/one-file/Chuba-Sprite-Lab-${version}-offline.exe`);
const partial = `${output}.partial`;
const license = path.join(here, "7zip-LICENSE.txt");
if (path.dirname(output) === path.parse(output).root) throw new Error("Output must not be a filesystem root");
await fsp.access(path.join(portable, "Chuba Sprite Lab.exe"));
await fsp.access(license);
await fsp.access(path.join(root, "assets", "app.ico"));
await fsp.mkdir(path.dirname(archive), { recursive: true });
await fsp.mkdir(path.dirname(output), { recursive: true });
if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
if (fs.existsSync(partial)) throw new Error(`Unfinished output exists: ${partial}`);
const extractor = await getPath7za();
await fsp.rm(archive, { force: true });
const packed = spawnSync(extractor, ["a", "-t7z", "-mx=1", "-bd", archive, "*"], { cwd: portable, stdio: "inherit", windowsHide: true });
if (packed.status !== 0) throw new Error(`Portable archiving failed: ${packed.status ?? "unknown"}`);
const verified = spawnSync(extractor, ["t", "-bd", archive], { stdio: "inherit", windowsHide: true });
if (verified.status !== 0) throw new Error(`Portable archive verification failed: ${verified.status ?? "unknown"}`);
const compile = spawnSync(csc, ["/nologo", "/target:winexe", "/platform:x64", "/r:System.Windows.Forms.dll", `/win32icon:${path.join(root, "assets", "app.ico")}`, `/out:${stub}`, path.join(here, "single-exe-launcher.cs")], { stdio: "inherit", windowsHide: true });
if (compile.status !== 0) throw new Error(`C# launcher compilation failed: ${compile.status}`);
const writer = fs.createWriteStream(partial, { flags: "wx" });
let offset = 0n;
const hash = crypto.createHash("sha256");
async function append(file, updateHash = false) {
  const start = offset;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    if (updateHash) hash.update(chunk);
    if (!writer.write(chunk)) await once(writer, "drain");
    offset += BigInt(chunk.length);
  }
  return [start, offset - start];
}
try {
  await append(stub);
  const ext = await append(extractor);
  const lic = await append(license);
  const arc = await append(archive, true);
  const footer = Buffer.alloc(88);
  footer.write("CHUBASFX", 0, "ascii");
  [ext[0], ext[1], lic[0], lic[1], arc[0], arc[1]].forEach((n, i) => footer.writeBigInt64LE(n, 8 + i * 8));
  hash.digest().copy(footer, 56);
  writer.end(footer);
  await once(writer, "finish");
  await fsp.rename(partial, output);
  console.log(JSON.stringify({ output, bytes: (offset + BigInt(footer.length)).toString(), archiveBytes: arc[1].toString() }));
} catch (error) {
  writer.destroy();
  await fsp.rm(partial, { force: true });
  throw error;
}
