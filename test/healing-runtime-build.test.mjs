import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHealingRuntime } from '../scripts/prepare-healing-runtime.mjs';

test('pack reuses a working bundled Python without a system interpreter or self-deletion', async t => {
  if (process.platform !== 'win32') return t.skip('Windows runtime');
  const root = fileURLToPath(new URL('../', import.meta.url)), runtime = path.join(root, 'vendor', 'healing-runtime', 'python.exe');
  try { await fs.access(runtime); } catch { return t.skip('Bundled runtime is prepared during packaging'); }
  const original = await fs.readFile(runtime), previous = process.env.HEALING_PYTHON;
  try {
    delete process.env.HEALING_PYTHON;
    const implicit = await prepareHealingRuntime(root);
    assert.equal(implicit.reused, true); assert.ok(implicit.packages);
    process.env.HEALING_PYTHON = runtime;
    assert.equal((await prepareHealingRuntime(root)).reused, true);
    assert.deepEqual(await fs.readFile(runtime), original);
  } finally { if (previous === undefined) delete process.env.HEALING_PYTHON; else process.env.HEALING_PYTHON = previous; }
});
