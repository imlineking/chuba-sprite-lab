// Routes refer to existing controls; opening one never starts a destructive edit.
const routes = {
  "split-frames": { tab: "source", focus: "sourceCard", original: true },
  "trim-time": { tab: "source", focus: "trimStart", original: true },
  "slice-sheet": { tab: "source", focus: "sheetControls", original: true },
  "import-atlas": { tab: "source", focus: "sourceCard", original: true },
  "import-aseprite": { tab: "source", focus: "sourceCard", original: true },
  "remove-background": { tab: "process", focus: "keyMode" },
  "ai-mask": { tab: "process", focus: "keyMode", keyMode: "ai" },
  "edge-cleanup": { tab: "process", action: "mask" },
  "align-frames": { tab: "process", focus: "consistencyPanel", details: true },
  "pixelate": { tab: "process", focus: "pixelatePanel", details: true },
  "color-style": { tab: "process", focus: "colorStyle" },
  "upscale": { tab: "process", focus: "auxEsrgan", details: "auxAITools" },
  "interpolate": { tab: "process", focus: "auxRife", details: "auxAITools" },
  "depth": { tab: "process", focus: "auxDepth", details: "auxAITools" },
  "inpaint": { tab: "process", focus: "chooseLamaMask", details: "auxAITools" },
  "pixel-editor": { tab: "process", action: "editor" },
  "ocr": { tab: "process", action: "editor", focus: "pixelOCRDetails", details: true },
  "pack-atlas": { tab: "export", focus: "atlasPacking" },
  "review": { tab: "export", action: "review" },
  "export-png": { tab: "export", focus: "exportFrames" },
  "export-engines": { tab: "export", focus: "exportPreset" },
  "export-animated": { tab: "export", focus: "exportGIF" },
};

export function conveyorToolRoute(id) { return routes[id] ? { ...routes[id] } : null; }

export function companionActionAllowed(busy, id) {
  return !busy || id === "cancel" || Boolean(id?.startsWith("queue-cancel:"));
}
