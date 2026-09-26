import globals from "globals";
import { collectRendererGlobals, rendererFiles } from "./scripts/renderer-globals.mjs";

export default [
  { files: ["src/companion.js"], languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: globals.browser }, rules: { "no-undef": "error" } },
  { ignores: ["dist/**", "node_modules/**", "release/**", "vendor/**", "models/**"] },
  {
    files: ["src/**/*.mjs", "scripts/**/*.mjs", "test/**/*.mjs", "eslint.config.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: { "no-undef": "error", "no-redeclare": "error" },
  },
  {
    files: ["src/**/*.cjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "no-undef": "error", "no-redeclare": "error" },
  },
  {
    files: rendererFiles,
    languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: { ...globals.browser, ...collectRendererGlobals() } },
    // "no-redeclare" would fire for every top-level declaration, because the app's own
    // cross-file names are declared as globals on purpose. Duplicates between renderer
    // scripts are reported by collectRendererGlobals() instead.
    rules: { "no-undef": "error" },
  },
];
