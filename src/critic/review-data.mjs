import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export const feedbackCategories = Object.freeze(['background', 'halo', 'grid', 'missing_detail', 'shape', 'other']);

export function artifactFingerprint(result) {
  if (!result.atlas || !result.pages?.length) return null;
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ frames: result.atlas.frames, animations: result.atlas.animations, pages: result.pages.map(page => [page.image.width, page.image.height]) }));
  for (const page of result.pages) hash.update(page.image.rgba);
  return hash.digest('hex');
}

export async function algorithmRevisionFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of ['./checks.mjs', './critic.mjs']) hash.update(await fs.readFile(new URL(file, import.meta.url)));
  return hash.digest('hex');
}

async function database(file, callback) {
  if (!file) return null;
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Lazy import keeps algorithm-only mode usable on older Node hosts without SQLite.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS predictions (artifact_id TEXT NOT NULL, model TEXT NOT NULL, skills_revision TEXT NOT NULL, verdict TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(artifact_id, model, skills_revision));
      CREATE TABLE IF NOT EXISTS human_labels (artifact_id TEXT PRIMARY KEY, verdict TEXT NOT NULL, reason TEXT NOT NULL, category TEXT NOT NULL, recorded_at TEXT NOT NULL);`);
    return callback(db);
  } finally { db.close(); }
}

export async function recordHumanLabel(file, { review, verdict, reason, category = 'other' }) {
  if (!review || !validId(review.artifactId) || !['accepted', 'needs_fix', 'rejected'].includes(review.verdict)) throw new Error('Нет проверенного изображения для оценки.');
  if (!['accepted', 'rejected'].includes(verdict)) throw new Error('Выберите: пригодно или нужны правки.');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 400) throw new Error('Укажите причину оценки, до 400 символов.');
  if (!feedbackCategories.includes(category)) throw new Error('Неизвестная категория ошибки.');
  const model = 'algorithms';
  const revision = String(review.criticRevision || 'algorithm-v1').slice(0, 128), now = new Date().toISOString();
  return database(file, db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR REPLACE INTO predictions VALUES (?, ?, ?, ?, ?)').run(review.artifactId, model, revision, review.verdict, now);
      db.prepare('INSERT OR REPLACE INTO human_labels VALUES (?, ?, ?, ?, ?)').run(review.artifactId, verdict, reason.trim(), category, now);
      db.exec('COMMIT'); return { saved: true, artifactId: review.artifactId };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

export async function labelledReviews(file) {
  return database(file, db => db.prepare(`SELECT p.artifact_id AS artifactId, p.model, p.skills_revision AS skillsRevision, p.skills_revision AS criticRevision, p.verdict AS prediction,
    h.verdict AS humanVerdict, h.reason, h.category FROM predictions p JOIN human_labels h ON p.artifact_id=h.artifact_id ORDER BY p.artifact_id, p.model, p.skills_revision`).all());
}

export function evaluateReviews(rows) {
  const groups = new Map(), seen = new Set();
  for (const row of rows) {
    if (!validId(row.artifactId) || !['accepted', 'rejected'].includes(row.humanVerdict) || !['accepted', 'needs_fix', 'rejected'].includes(row.prediction) || typeof row.model !== 'string' || !row.model || typeof row.skillsRevision !== 'string' || !row.skillsRevision) throw new Error('Повреждена строка размеченного набора.');
    const revision = row.criticRevision || row.skillsRevision;
    const key = JSON.stringify([row.model, revision]), identity = JSON.stringify([key, row.artifactId]);
    if (seen.has(identity)) throw new Error('Повтор одного изображения и версии критика: метрики нельзя завышать дублями.');
    seen.add(identity);
    const group = groups.get(key) || { model: row.model, criticRevision: revision, tp: 0, fp: 0, tn: 0, fn: 0, categories: {} };
    const bad = row.humanVerdict === 'rejected', predictedBad = row.prediction !== 'accepted';
    group[bad ? predictedBad ? 'tp' : 'fn' : predictedBad ? 'fp' : 'tn']++;
    if (bad !== predictedBad) { const category = row.category || 'other'; group.categories[category] = (group.categories[category] || 0) + 1; }
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const { tp, fp, tn, fn } = group, count = tp + fp + tn + fn, accuracy = (tp + tn) / count;
    const expected = ((tp + fp) * (tp + fn) + (tn + fn) * (tn + fp)) / count ** 2;
    return { ...group, samples: count, accuracy, precisionReject: tp + fp ? tp / (tp + fp) : null, recallReject: tp + fn ? tp / (tp + fn) : null,
      kappa: expected < 1 ? (accuracy - expected) / (1 - expected) : null };
  });
}


export function registerReviewedReport(registry, output, review) {
  if (!path.isAbsolute(output)) throw new Error('Папка результата должна иметь абсолютный путь.');
  const token = crypto.randomUUID(); review.feedbackToken = token;
  while (registry.size >= 100 && !registry.has(path.resolve(output))) registry.delete(registry.keys().next().value);
  registry.set(path.resolve(output), { token, review: structuredClone(review) });
  return token;
}

export function feedbackReview(registry, output, token) {
  if (typeof output !== 'string' || !path.isAbsolute(output)) throw new Error('Нет результата приёмки.');
  const entry = registry.get(path.resolve(output));
  if (!entry || typeof token !== 'string' || token !== entry.token) throw new Error('Результат уже изменился или не проверен в этом сеансе. Откройте актуальную приёмку.');
  return entry.review;
}
