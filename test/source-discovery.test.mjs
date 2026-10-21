import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverJavaScript, checkSyntax } from '../scripts/check-syntax.mjs';
const run = promisify(execFile);

test('syntax checking discovers new nested modules and rejects a syntax error without a manually maintained list', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syntax-discovery-'));
  try {
    for (const dir of ['src/nested', 'scripts', 'test']) await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(path.join(root, 'src/nested/new.cjs'), 'const x = ;');
    await fs.writeFile(path.join(root, 'src/nested/readme.txt'), 'not JavaScript');
    assert.equal((await discoverJavaScript(root)).length, 1);
    const report = await checkSyntax(root); assert.equal(report.errors.length, 1); assert.match(report.errors[0].file, /new\.cjs$/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('renderer globals resolve project-relative source paths even when ESLint is imported from a different working directory', async () => {
  const moduleUrl = new URL('../scripts/renderer-globals.mjs', import.meta.url).href;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(moduleUrl)});console.log(Object.keys(m.collectRendererGlobals()).length)`], { cwd: os.tmpdir(), windowsHide: true });
  assert.ok(Number(stdout.trim()) > 100);
});
