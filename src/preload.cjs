const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("spriteLab", {
  setLocale:(locale)=>ipcRenderer.invoke("interface:locale",locale),
  getUserProfile:()=>ipcRenderer.invoke("user:profile"),
  saveUserProfile:(name)=>ipcRenderer.invoke("user:save-profile",name),
  chooseSource: () => ipcRenderer.invoke("source:any"),
  addImages: (paths) => ipcRenderer.invoke("source:add-images", paths),
  useImageObject: (filePath) => ipcRenderer.invoke("source:use-image-object", filePath),
  chooseSheet: () => ipcRenderer.invoke("source:sheet"),
  resliceSheet: (request) => ipcRenderer.invoke("source:reslice-sheet", request),
  analyzeFrames: (request) => ipcRenderer.invoke("source:analyze-frames", request),
  chooseFolder: () => ipcRenderer.invoke("source:folder"),
  chooseOutput: () => ipcRenderer.invoke("output:folder"),
  automaticOutput: (filePath) => ipcRenderer.invoke("output:automatic", filePath),
  retainPreviews: references => ipcRenderer.invoke("preview:retain", references),
  imageBatch: (request) => ipcRenderer.invoke("sprites:image-batch", request),
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
  loadProjectPath: (projectPath) => ipcRenderer.invoke("project:load-path", projectPath),
  restoreProject: (request) => ipcRenderer.invoke("project:restore", request),
  inspectDropped: (files) => {
    const paths = Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke("source:dropped", { paths });
  },
  build: (request) => ipcRenderer.invoke("sprites:build", request),
  cancelBuild: () => ipcRenderer.invoke("sprites:cancel"),
  stopBatchAfterCurrent: () => ipcRenderer.invoke("sprites:stop-after-current"),
  previewFrame: (request) => ipcRenderer.invoke("preview:frame", request),
  copyFrame: (sourceIndex) => ipcRenderer.invoke("frame:copy", sourceIndex),
  previewPoster: (request) => ipcRenderer.invoke("source:poster", request),
  revealOutput: (outputPath) => ipcRenderer.invoke("output:reveal", outputPath),
  copyOutputPath: (outputPath) => ipcRenderer.invoke("output:copy-path", outputPath),
  copyFeedback: (request) => ipcRenderer.invoke("feedback:copy", request),
  logError: (message) => ipcRenderer.invoke("app:log-error", message),
  openErrorLog: () => ipcRenderer.invoke("app:open-error-log"),
  saveProfile: (request) => ipcRenderer.invoke("profile:save", request),
  // The built-in pixel editor keeps the document in the main process; the window sends operations
  // and receives one state object back.
  openPixelEditor: (request) => ipcRenderer.invoke("editor:open", request),
  installedFonts: () => ipcRenderer.invoke('fonts:list'),
  recognizeText: request => ipcRenderer.invoke('editor:ocr', request),
  repairLettering: request => ipcRenderer.invoke('editor:repair-text', request),
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
  planCopilot: (request) => ipcRenderer.invoke("copilot:plan", request),
  compareCopilots: (request) => ipcRenderer.invoke("copilot:compare", request),
  copilotPlannerStatus: () => ipcRenderer.invoke("copilot:status"),
  criticPickFolder: () => ipcRenderer.invoke("critic:pick-folder"),
  criticReview: (request) => ipcRenderer.invoke("critic:review", request),
  criticApplyFix: (request) => ipcRenderer.invoke("critic:apply-fix", request),
  criticAcceptAnyway: (request) => ipcRenderer.invoke("critic:accept-anyway", request),
  updateCompanion: (state) => ipcRenderer.invoke("companion:update", state),
  showCompanion: (request) => ipcRenderer.invoke("companion:show", request),
  onCompanionCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("companion:command", listener);
    return () => ipcRenderer.removeListener("companion:command", listener);
  },
  videoFrame: {
    info: (video) => ipcRenderer.invoke("video-frame:info", { video }),
    extract: (request) => ipcRenderer.invoke("video-frame:extract", request),
    editors: () => ipcRenderer.invoke("video-frame:editors"),
    chooseEditor: (editor) => ipcRenderer.invoke("video-frame:choose-editor", { editor }),
    openExternal: (request) => ipcRenderer.invoke("video-frame:open-external", request),
    unwatch: (file) => ipcRenderer.invoke("video-frame:unwatch", { path: file }),
    bake: (request) => ipcRenderer.invoke("video-frame:bake", request),
    saveCutout: (request) => ipcRenderer.invoke("video-frame:save-cutout", request),
    onSaved: (callback) => { const l = (_e, p) => callback(p); ipcRenderer.on("video-frame:saved", l); return () => ipcRenderer.removeListener("video-frame:saved", l); },
  },
  conveyor: {
    detectDropped: (files) => ipcRenderer.invoke("conveyor:detect", { paths: Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean) }),
    detect: (paths) => ipcRenderer.invoke("conveyor:detect", { paths }),
    presets: () => ipcRenderer.invoke("conveyor:presets"),
    savePreset: (preset) => ipcRenderer.invoke("conveyor:save-preset", preset),
    removePreset: (id) => ipcRenderer.invoke("conveyor:remove-preset", id),
    run: (request) => ipcRenderer.invoke("conveyor:run", request),
    cancel: () => ipcRenderer.invoke("conveyor:cancel"),
    quickTarget: (file) => ipcRenderer.invoke("conveyor:quick-target", file),
    pickOutput: () => ipcRenderer.invoke("conveyor:pick-output"),
    pickInput: (folder) => ipcRenderer.invoke("conveyor:pick-input", { folder }),
    openInAdvanced: (paths) => ipcRenderer.invoke("source:dropped", { paths }),
    queue: () => ipcRenderer.invoke("conveyor:queue"),
    queueAdd: (request) => ipcRenderer.invoke("conveyor:queue-add", request),
    queueRemove: (id) => ipcRenderer.invoke("conveyor:queue-remove", id),
    queueCancel: (id) => ipcRenderer.invoke("conveyor:queue-cancel", id),
    queuePause: () => ipcRenderer.invoke("conveyor:queue-pause"),
    queueResume: () => ipcRenderer.invoke("conveyor:queue-resume"),
    queueClear: () => ipcRenderer.invoke("conveyor:queue-clear"),
    queueSummary: () => ipcRenderer.invoke("conveyor:queue-summary"),
    watchGet: () => ipcRenderer.invoke("conveyor:watch-get"),
    watchSet: (config) => ipcRenderer.invoke("conveyor:watch-set", config),
    watchStop: () => ipcRenderer.invoke("conveyor:watch-stop"),
    onProgress: (callback) => { const l = (_e, p) => callback(p); ipcRenderer.on("conveyor:progress", l); return () => ipcRenderer.removeListener("conveyor:progress", l); },
    onQueue: (callback) => { const l = (_e, p) => callback(p); ipcRenderer.on("conveyor:queue", l); return () => ipcRenderer.removeListener("conveyor:queue", l); },
  },
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
  setTaskbarProgress: (value) => ipcRenderer.send("window:progress", value),
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
});
