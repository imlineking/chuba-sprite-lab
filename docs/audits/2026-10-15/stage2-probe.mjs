import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { describePaths, describeSpriteSheet } from "../../../src/source-describe.mjs";
import * as processor from "../../../src/processor.mjs";
import { buildAtlas } from "../../../src/pipeline/build.mjs";
import { reviewAtlas } from "../../../src/critic/critic.mjs";
import { createConveyorStages } from "../../../src/conveyor-main.mjs";
import { runConveyor, builtinPresets } from "../../../src/conveyor.mjs";

const here = import.meta.dirname, appRoot = path.resolve(here, "../../..");
const stages = createConveyorStages({ appRoot, sharp,
  describePaths: (kind, paths) => describePaths(appRoot, kind, paths),
  describeSpriteSheet: (file, options) => describeSpriteSheet(appRoot, file, options),
  executeProcessing: (op, payload) => processor[op](payload), buildAtlas, reviewAtlas,
  runtime: null, modelsDirectory: () => path.join(appRoot, "models"),
});
const hash = async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const results = [];
for (const name of ["timing", "timing-shaped"]) {
  const input = path.join(here, `${name}.gif`), before = await hash(input);
  const result = await runConveyor({ paths: [input],
    preset: { ...builtinPresets[0], background: "none", edgeCleanup: false, review: false, useModel: false },
    outputDir: path.join(here, "stage2-output"), deps: stages,
  });
  if (!result.ok) throw new Error(result.error);
  const atlasDir = path.join(result.outputDir, "atlas");
  const atlas = JSON.parse(await fs.readFile(path.join(atlasDir, `${name}.json`), "utf8"));
  const phaser = JSON.parse(await fs.readFile(path.join(atlasDir, `${name}.phaser-anims.json`), "utf8"));
  results.push({ name, sourceUnchanged: before === await hash(input), outputDir: result.outputDir,
    frames: Object.values(atlas.frames).map((frame) => ({ durationMs: frame.durationMs, sourceSize: frame.sourceSize, spriteSourceSize: frame.spriteSourceSize })),
    animations: atlas.meta.animations, phaser,
  });
}
await fs.writeFile(path.join(here, "stage2-probe.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results));
