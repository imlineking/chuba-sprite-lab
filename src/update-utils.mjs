export function compareVersions(left, right) {
  const parse = (value) => String(value || "0").replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

export function assertGitHubDownloadUrl(value) {
  const parsed = new URL(value);
  const allowed = parsed.protocol === "https:"
    && (parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com"));
  if (!allowed) throw new Error("GitHub вернул недопустимый адрес файла обновления.");
  return parsed.href;
}

export function parseSha256(value) {
  const hash = String(value || "").match(/\b[a-f\d]{64}\b/i)?.[0]?.toLowerCase();
  if (!hash) throw new Error("Файл SHA-256 релиза имеет неверный формат.");
  return hash;
}
