import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function discoverJavaScript(root, directories = ['src', 'scripts', 'test']) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(file);
    }
  }
  for (const directory of directories) await walk(path.join(root, directory));
  return files.sort();
}

export async function checkSyntax(root = projectRoot) {
  const files = await discoverJavaScript(root), errors = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (index < files.length) {
      const file = files[index++];
      try { await run(process.execPath, ['--check', file], { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2 }); }
      catch (error) { errors.push({ file: path.relative(root, file), error: error.stderr || error.message }); }
    }
  }));
  return { files: files.length, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkSyntax();
  for (const error of report.errors) console.error(`${error.file}\n${error.error}`);
  console.log(`Проверен синтаксис ${report.files} файлов; ошибок: ${report.errors.length}.`);
  process.exitCode = report.errors.length ? 1 : 0;
}
