// Stable codes are consumed by tools; translated messages are only presentation.
export function summarizeIssues(entries = []) {
  const unique = new Map();
  for (const entry of entries) {
    if (!entry?.code || !entry.message) continue;
    const key = JSON.stringify([entry.code, entry.animation || null, entry.frameIndex ?? null, entry.detail || null]);
    if (!unique.has(key)) unique.set(key, { severity: "warning", ...entry });
  }
  const issues = [...unique.values()];
  const groups = new Map();
  for (const issue of issues) {
    const key = `${issue.animation || ""}:${issue.code}:${issue.detail || ""}`;
    if (!groups.has(key)) groups.set(key, { code: issue.code, severity: issue.severity, animation: issue.animation, message: issue.message, frameIndexes: [], count: 0 });
    const group = groups.get(key);
    group.count += 1;
    if (issue.frameIndex != null && !group.frameIndexes.includes(issue.frameIndex)) group.frameIndexes.push(issue.frameIndex);
  }
  const warningGroups = [...groups.values()].map(group => ({ ...group, message: group.count > 1 ? `${group.message} Всего: ${group.frameIndexes.length || group.count}.` : group.message }));
  return { issues, warningGroups, warnings: warningGroups.map(group => group.message), frameIssues: issues.filter(issue => issue.frameIndex != null) };
}

export function hasIssue(built, ...codes) {
  return [...(built?.issues || []), ...(built?.frameIssues || []), ...(built?.atlasIssues || [])].some(issue => codes.includes(issue.code));
}
