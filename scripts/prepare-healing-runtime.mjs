import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pythonInfo(command) {
  const probe = spawnSync(command, ["-c", "import json, pathlib, sys, sysconfig, numpy, PIL; print(json.dumps({'executable':sys.executable,'stdlib':sysconfig.get_path('stdlib'),'numpy':str(pathlib.Path(numpy.__file__).parent),'pillow':str(pathlib.Path(PIL.__file__).parent),'version':sys.version_info[:2]}))"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  if (probe.status !== 0) throw new Error(probe.error?.message || probe.stderr?.trim() || "Python, NumPy и Pillow не найдены.");
  return JSON.parse(probe.stdout.trim());
}

async function copyDirectory(source, target, filter = () => true) {
  await fs.cp(source, target, { recursive: true, filter: item => filter(path.relative(source, item)) });
}

export async function prepareHealingRuntime(root = projectRoot) {
  if (process.platform !== "win32") throw new Error("Автономный runtime Подорожника собирается для Windows.");
  const target = path.resolve(root, "vendor", "healing-runtime");
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("Папка runtime вне проекта.");
  const resolvedTarget = await fs.realpath(target).catch(() => target);
  if (!resolvedTarget.startsWith(path.resolve(root) + path.sep)) throw new Error("Папка runtime ведёт за пределы проекта.");
  const command = process.env.HEALING_PYTHON || "python";
  const info = pythonInfo(command);
  const sourceRoot = path.dirname(info.executable);
  const [major, minor] = info.version;
  if (major !== 3 || minor < 10) throw new Error("Подорожнику нужен Python 3.10 или новее.");
  const site = path.join(info.stdlib, "site-packages");
  if (path.dirname(info.numpy).toLowerCase() !== site.toLowerCase() || path.dirname(info.pillow).toLowerCase() !== site.toLowerCase()) throw new Error("NumPy и Pillow должны быть установлены в site-packages выбранного Python.");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.join(target, "Lib", "site-packages"), { recursive: true });
  for (const file of await fs.readdir(sourceRoot)) {
    if (/^(python(?:3|\d{2,3})?\.dll|vcruntime.*\.dll|LICENSE\.txt)$/i.test(file)) await fs.copyFile(path.join(sourceRoot, file), path.join(target, file));
  }
  await fs.copyFile(info.executable, path.join(target, "python.exe"));
  await copyDirectory(path.join(sourceRoot, "DLLs"), path.join(target, "DLLs"), relative => !relative.split(path.sep).some(part => part === "__pycache__"));
  await copyDirectory(info.stdlib, path.join(target, "Lib"), relative => {
    if (!relative) return true;
    const first = relative.split(path.sep)[0].toLowerCase();
    return !["site-packages", "test", "tests", "ensurepip", "idlelib", "tkinter", "venv", "__pycache__"].includes(first) && !relative.split(path.sep).includes("__pycache__");
  });
  for (const name of ["numpy", "numpy.libs", "PIL"]) await copyDirectory(path.join(site, name), path.join(target, "Lib", "site-packages", name), relative => !relative.split(path.sep).includes("__pycache__"));
  for (const name of await fs.readdir(site)) {
    if (/^(numpy|pillow)-[^\\/]+\.dist-info$/i.test(name)) await copyDirectory(path.join(site, name), path.join(target, "Lib", "site-packages", name));
  }
  await fs.writeFile(path.join(target, `python${major}${minor}._pth`), "Lib\nDLLs\nLib\\site-packages\nimport site\n");
  const runtime = path.join(target, "python.exe");
  const check = spawnSync(runtime, ["-B", "-c", "import numpy, PIL; print(numpy.__version__, PIL.__version__)"], { encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...process.env, PYTHONHOME: "", PYTHONPATH: "" } });
  if (check.status !== 0) throw new Error(`Скопированный Python не запускается: ${check.error?.message || check.stderr}`);
  return { path: target, python: `${major}.${minor}`, packages: check.stdout.trim() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareHealingRuntime();
  console.log(`Runtime Подорожника готов: ${result.path} · Python ${result.python} · NumPy/Pillow ${result.packages}`);
}
