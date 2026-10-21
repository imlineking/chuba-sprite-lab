import test from 'node:test';
import assert from 'node:assert/strict';
import { planWithCopilot } from '../src/copilot-planner.mjs';
import { validatePreset, builtinPresets } from '../src/conveyor.mjs';

test('legacy planner settings migrate without reading paths or calling a model', async () => {
  const trap = new Proxy({}, { get() { throw new Error('Model runtime must not be used'); } });
  for (const planner of ['rules', 'qwen', 'gemma', 'unknown']) {
    const result = await planWithCopilot({ planner, paths: ['/missing/private.png'], snapshot: { source: { kind: 'frames', frameCount: 2 }, ui: { goal: 'combine' } } }, trap);
    assert.equal(result.planner, 'rules'); assert.equal(result.scenarios[0].task, 'combine');
    assert.equal(result.fallback, planner !== 'rules');
  }
});

test('explicit job remains first without a model', async () => {
  for (const goal of ['edit', 'combine', 'background', 'readyAtlas', 'readySheet']) {
    const result = await planWithCopilot({ snapshot: { source: { kind: 'frames', frameCount: 1 }, ui: { goal } } });
    assert.equal(result.scenarios[0].task, goal);
  }
});

test('legacy conveyor model option is accepted but is discarded on save', () => {
  const result = validatePreset({ ...builtinPresets[0], useModel: true });
  assert.equal(Object.hasOwn(result, 'useModel'), false);
});
