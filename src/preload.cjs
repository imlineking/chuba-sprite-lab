const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("spriteLab", {
  chooseSource: () => ipcRenderer.invoke("source:any"),
  addImages: (paths) => ipcRenderer.invoke("source:add-images", paths),
  useImageObject: (filePath) => ipcRenderer.invoke("source:use-image-object", filePath),
  chooseSheet: () => ipcRenderer.invoke("source:sheet"),
  resliceSheet: (request) => ipcRenderer.invoke("source:reslice-sheet", request),
  analyzeFrames: (request) => ipcRenderer.invoke("source:analyze-frames", request),
  chooseFolder: () => ipcRenderer.invoke("source:folder"),
  chooseOutput: () => ipcRenderer.invoke("output:folder"),
  chooseOverlay: () => ipcRenderer.invoke("overlay:choose"),
  chooseAIMask: () => ipcRenderer.invoke("ai:choose-mask"),
  prepareFrameEdit: (request) => ipcRenderer.invoke("frame-edit:prepare", request),
  openFrameEdit: (request) => ipcRenderer.invoke("frame-edit:open", request),
  openOnlineFrameEditor: (request) => ipcRenderer.invoke("frame-edit:online", request),
  replaceFrameEdit: (request) => ipcRenderer.invoke("frame-edit:replace", request),
  replaceFrameEditDropped: (request) => ipcRenderer.invoke("frame-edit:replace-dropped", {
    path: request.path,
    incomingPath: webUtils.getPathForFile(request.file),
  }),
  snapshotFrameEdit: (filePath) => ipcRenderer.invoke("frame-edit:snapshot", filePath),
  statFrameEdit: (filePath) => ipcRenderer.invoke("frame-edit:stat", filePath),
  saveProject: (request) => ipcRenderer.invoke("project:save", request),
  loadProject: () => ipcRenderer.invoke("project:load"),
  restoreProject: (request) => ipcRenderer.invoke("project:restore", request),
  inspectDropped: (files) => {
    const paths = Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke("source:dropped", { paths });
  },
  build: (request) => ipcRenderer.invoke("sprites:build", request),
  cancelBuild: () => ipcRenderer.invoke("sprites:cancel"),
  stopBatchAfterCurrent: () => ipcRenderer.invoke("sprites:stop-after-current"),
  previewFrame: (request) => ipcRenderer.invoke("preview:frame", request),
  previewPoster: (request) => ipcRenderer.invoke("source:poster", request),
  revealOutput: (outputPath) => ipcRenderer.invoke("output:reveal", outputPath),
  copyOutputPath: (outputPath) => ipcRenderer.invoke("output:copy-path", outputPath),
  copyFeedback: (request) => ipcRenderer.invoke("feedback:copy", request),
  saveProfile: (request) => ipcRenderer.invoke("profile:save", request),
  // The built-in pixel editor keeps the document in the main process; the window sends operations
  // and receives one state object back.
  openPixelEditor: (request) => ipcRenderer.invoke("editor:open", request),
  pixelEditorOp: (request) => ipcRenderer.invoke("editor:op", request),
  savePixelEditor: (request) => ipcRenderer.invoke("editor:save", request),
  // Local AI models: what is installed, what can be downloaded, and the auto-mode plan.
  modelsStatus: () => ipcRenderer.invoke("models:status"),
  downloadModel: (request) => ipcRenderer.invoke("models:download", request),
  validateModel: (request) => ipcRenderer.invoke("models:validate", request),
  removeModel: (request) => ipcRenderer.invoke("models:remove", request),
  openModelsFolder: () => ipcRenderer.invoke("models:open-folder"),
  openModelPage: (request) => ipcRenderer.invoke("models:open-page", request),
  onModelsProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("models:progress", listener);
    return () => ipcRenderer.removeListener("models:progress", listener);
  },
  planAutoPilot: (request) => ipcRenderer.invoke("autopilot:plan", request),
  suggest: (snapshot) => ipcRenderer.invoke("copilot:suggest", snapshot),
  suggestScenarios: (snapshot) => ipcRenderer.invoke("copilot:scenarios", snapshot),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-updates"),
  installUpdate: () => ipcRenderer.invoke("app:install-update"),
  openRepository: () => ipcRenderer.invoke("app:open-repository"),
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:update-progress", listener);
    return () => ipcRenderer.removeListener("app:update-progress", listener);
  },
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("sprites:progress", listener);
    return () => ipcRenderer.removeListener("sprites:progress", listener);
  },
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
});
