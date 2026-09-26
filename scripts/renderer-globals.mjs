import { readFileSync } from "node:fs";

// The renderer is a group of classic scripts that share one global scope, so ESLint
// cannot resolve their cross-file names from imports. Their top-level declarations are
// collected here and declared as known globals: "no-undef" then still reports a
// mistyped or forgotten name. A name declared by two scripts is reported as an error,
// because the second declaration silently replaces the first at load time.
const DECLARATION = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

// Keep lint coverage in sync with every script actually loaded by the app.
const rendererMarkup = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
export const rendererFiles = [...rendererMarkup.matchAll(/<script src="\.\/([^"]+)"/g)].map(match => `src/${match[1]}`);

// Name -> files that declare it, in file order.
export function collectRendererDeclarations(files = rendererFiles) {
  const owners = new Map();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(DECLARATION)) {
      const name = match[1] || match[2];
      const list = owners.get(name) || [];
      if (!list.includes(file)) list.push(file);
      owners.set(name, list);
    }
  }
  return owners;
}

export function findDuplicateDeclarations(files = rendererFiles) {
  return [...collectRendererDeclarations(files)]
    .filter(([, declaredIn]) => declaredIn.length > 1)
    .map(([name, declaredIn]) => `${name} (${declaredIn.join(", ")})`);
}

export function collectRendererGlobals(files = rendererFiles) {
  const duplicates = findDuplicateDeclarations(files);
  if (duplicates.length) {
    throw new Error(`Renderer scripts declare the same global more than once: ${duplicates.join("; ")}`);
  }
  return Object.fromEntries([...collectRendererDeclarations(files).keys()].sort().map((name) => [name, "writable"]));
}
