import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAtlas } from '../src/pipeline/build.mjs';
import { makeGoldenCases } from './critic-golden.mjs';
import { reviewAtlas } from '../src/critic/critic.mjs';
import { artifactFingerprint, evaluateReviews, recordHumanLabel, labelledReviews, registerReviewedReport, feedbackReview } from '../src/critic/review-data.mjs';

const id = n => String(n).padStart(64, '0');
const sample = (n, humanVerdict, prediction) => ({ artifactId: id(n), humanVerdict, prediction, model: 'test-model', skillsRevision: 'v1', category: 'halo' });

test('human feedback is tied to the displayed review token, not just a reused output directory', () => {
  const registry = new Map(), output = path.resolve('test-output'), first = { artifactId: id(1), verdict: 'accepted' };
  const token = registerReviewedReport(registry, output, first);
  assert.equal(feedbackReview(registry, output, token).artifactId, id(1));
  registerReviewedReport(registry, output, { artifactId: id(2), verdict: 'rejected' });
  assert.throws(() => feedbackReview(registry, output, token), /уже изменился/);
  assert.throws(() => feedbackReview(registry, output, 'forged'), /уже изменился/);
});

test('evaluation reports reject precision/recall, kappa and error categories without treating duplicates or undefined metrics as success', () => {
  const [metrics] = evaluateReviews([sample(1, 'rejected', 'needs_fix'), sample(2, 'accepted', 'rejected'), sample(3, 'accepted', 'accepted'), sample(4, 'rejected', 'accepted')]);
  assert.equal(metrics.precisionReject, .5); assert.equal(metrics.recallReject, .5); assert.equal(metrics.accuracy, .5); assert.equal(metrics.kappa, 0); assert.equal(metrics.categories.halo, 2);
  const [clean] = evaluateReviews([sample(1, 'accepted', 'accepted')]); assert.equal(clean.precisionReject, null); assert.equal(clean.recallReject, null); assert.equal(clean.kappa, null);
  assert.throws(() => evaluateReviews([sample(1, 'accepted', 'accepted'), sample(1, 'accepted', 'accepted')]), /Повтор/);
  assert.throws(() => evaluateReviews([{ ...sample(1, 'accepted', 'accepted'), humanVerdict: 'auto' }]), /Повреждена/);
});

test('local SQLite stores explicit human labels idempotently; model verdicts alone do not become labels', async t => {
  try { await import('node:sqlite'); } catch { return t.skip('SQLite requires a current Node runtime'); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'critic-data-')), file = path.join(root, 'critic.sqlite');
  try {
    const review = { artifactId: id(1), mode: 'light', verdict: 'accepted', score: 90, issues: [], criticRevision: 'algorithm-v1' };
    assert.deepEqual(await labelledReviews(file), [], 'No human label exists until explicitly supplied');
    await assert.rejects(recordHumanLabel(file, { review, verdict: 'accepted', reason: '' }), /причину/);
    await recordHumanLabel(file, { review, verdict: 'rejected', reason: 'Кайма', category: 'halo' });
    await recordHumanLabel(file, { review, verdict: 'accepted', reason: 'После просмотра пригодно', category: 'other' });
    const rows = await labelledReviews(file); assert.equal(rows.length, 1); assert.equal(rows[0].humanVerdict, 'accepted'); assert.equal(rows[0].prediction, 'accepted');
    assert.equal(rows[0].reason, 'После просмотра пригодно');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('actual pixels and atlas metadata determine the fingerprint; algorithm review never starts a runtime', async () => {
  const { dir, cases } = await makeGoldenCases();
  try {
    const built = await buildAtlas(cases.find(item => item.id === 'clean-walk').config, { write: false });
    const runtime = new Proxy({}, { get() { throw new Error('Retired runtime called'); } });
    const first = await reviewAtlas(built, { runtime }); assert.equal(first.mode, 'light');
    const id = artifactFingerprint(built); built.pages[0].image.rgba[0] ^= 1;
    assert.notEqual(artifactFingerprint(built), id);
    assert.equal(first.criticRevision.length, 64);
    const changed = await reviewAtlas(built, { runtime, buildError: 'Fixture build failed' }); assert.equal(changed.verdict, 'rejected');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
