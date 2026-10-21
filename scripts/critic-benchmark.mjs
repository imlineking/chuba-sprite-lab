import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateReviews, labelledReviews } from '../src/critic/review-data.mjs';

// Existing files are never overwritten. No inference, downloads or pseudo-label generation.
const [mode, input, output] = process.argv.slice(2);
if (!['evaluate', 'export'].includes(mode) || !input || !output) throw new Error('node scripts/critic-benchmark.mjs evaluate DATASET.jsonl NEW_REPORT.json | export critic.sqlite NEW_DATASET.jsonl');
const rows = mode === 'export' ? await labelledReviews(path.resolve(input)) : (await fs.readFile(input, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
const data = mode === 'export' ? rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
  : JSON.stringify({ generatedAt: new Date().toISOString(), humanLabelledArtifacts: new Set(rows.map(row => row.artifactId)).size, groups: evaluateReviews(rows), note: 'Needs-fix counts as reject. Undefined metrics are null. Labels are explicit human decisions, never inferred from model scores.' }, null, 2) + '\n';
await fs.writeFile(path.resolve(output), data, { flag: 'wx' });
console.log(`Сохранено строк: ${rows.length}. ${path.resolve(output)}`);
