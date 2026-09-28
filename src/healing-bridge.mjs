import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./healing-python/healing_tool.py", import.meta.url));
const sourceRuntime = fileURLToPath(new URL("../vendor/healing-runtime/python.exe", import.meta.url));
const launch = "import pathlib,runpy,sys; script=sys.argv[1]; sys.path.insert(0,str(pathlib.Path(script).parent)); sys.argv=sys.argv[1:]; runpy.run_path(script,run_name='__main__')";

function execute(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errorText = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
    child.stderr.on("data", chunk => { errorText = (errorText + chunk).slice(-8192); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(errorText.trim() || `Подорожник завершился с кодом ${code}.`)));
  });
}

// The source workflow uses the tested Python implementation verbatim. A future
// portable package must supply its own Python + NumPy + Pillow runtime beside
// the application; the source checkout may use the local interpreter.
export async function healImage(inputPath, outputRoot, { signal, runtime } = {}) {
  const bundled = process.resourcesPath && path.join(process.resourcesPath, "vendor", "healing-runtime", "python.exe");
  const candidates = runtime ? [[runtime, []]] : [
    ...(bundled ? [[bundled, []]] : []), [sourceRuntime, []], ["python", []], ["py", ["-3"]],
  ];
  let unavailable;
  for (const [command, prefix] of candidates) {
    try {
      if (path.isAbsolute(command)) await fs.access(command);
      await execute(command, [...prefix, "-B", "-c", launch, script, inputPath, outputRoot, "--profile", "light-safe"], signal);
      const folder = path.join(outputRoot, path.basename(inputPath));
      const full = JSON.parse(await fs.readFile(path.join(folder, "report.json"), "utf8"));
      return { imagePath: path.join(folder, "result.png"), report: {
        profile: full.profile, sourceUnchanged: full.sourceUnchanged,
        recovery: { restoredPixels: full.recovery?.restoredPixels, removedPreviouslyVisible: full.recovery?.removedPreviouslyVisible, repairedAlphaSeams: full.recovery?.alphaSeamRepair?.repaired },
        structure: { found: full.structure?.found, cell: full.structure?.cell, removedVisible: full.structure?.removedVisible },
        lightDetailGuard: full.lightDetailGuard,
      } };
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw error;
      if (error.code === "ENOENT" || error.code === "EACCES" || /No module named ['"](?:numpy|PIL)/i.test(error.message)) { unavailable = error; continue; }
      throw error;
    }
  }
  throw new Error(`Для «Подорожника» нужен локальный Python с NumPy и Pillow. ${unavailable?.message || "Среда не найдена."}`);
}
