// Real inference benchmark. Never applies plans or writes to original assets.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measureSource } from "../src/auto-pilot.mjs";
import { comparePlanners } from "../src/copilot-planner.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const output = path.resolve(process.argv[3] || path.join(root, ".diagnostics/copilot-comparison.json"));
const report = { generatedAt: new Date().toISOString(), runtime: "Ollama local only", models: ["qwen3-vl:4b-instruct", "gemma3:4b"], cases: [] };
for (const entry of cases) {
  for (const file of entry.paths) await fs.access(file);
  const measurements = await measureSource(entry.paths);
  const snapshot = { ...entry.snapshot, aiPlan: { measurements } };
  const results = await comparePlanners({ snapshot, paths: entry.paths });
  const scored = results.map(result => ({ ...result, firstTaskAccepted: entry.expected.includes(result.scenarios[0]?.task), expectedOffered: result.scenarios.some(scenario => entry.expected.includes(scenario.task)), validModelPlan: !result.fallback }));
  report.cases.push({ id: entry.id, expected: entry.expected, results: scored });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ id: entry.id, results: scored.map(({ planner, model, requestedPlanner, elapsedMs, firstTaskAccepted, expectedOffered, error, scenarios }) => ({ planner, model, requestedPlanner, elapsedMs, firstTaskAccepted, expectedOffered, error, tasks: scenarios.map(item => item.task) })) }));
}
