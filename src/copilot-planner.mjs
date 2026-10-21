import { planTaskScenarios, planSuggestions } from "./copilot-rules.mjs";

// Legacy saved planner choices migrate to rules without loading any model.
export async function planWithCopilot({ planner = "rules", snapshot = {} } = {}) {
  const started = performance.now();
  return { scenarios: planTaskScenarios(snapshot), suggestions: planSuggestions(snapshot), planner: "rules",
    ...(planner !== "rules" ? { requestedPlanner: planner } : {}), elapsedMs: Math.round(performance.now() - started), fallback: planner !== "rules" };
}
