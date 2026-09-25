const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("spriteLab", {
  chooseSource: () => ipcRenderer.invoke("source:any"),
  chooseVideo: () => ipcRenderer.invoke("source:video"),
  chooseFrames: () => ipcRenderer.invoke("source:frames"),
  chooseFolder: () => ipcRenderer.invoke("source:folder"),
  chooseOutput: () => ipcRenderer.invoke("output:folder"),
  inspectDropped: (files) => {
    const paths = Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke("source:dropped", { paths });
  },
  build: (request) => ipcRenderer.invoke("sprites:build", request),
  cancelBuild: () => ipcRenderer.invoke("sprites:cancel"),
  previewFrame: (request) => ipcRenderer.invoke("preview:frame", request),
  previewPoster: (request) => ipcRenderer.invoke("source:poster", request),
  revealOutput: (outputPath) => ipcRenderer.invoke("output:reveal", outputPath),
  copyOutputPath: (outputPath) => ipcRenderer.invoke("output:copy-path", outputPath),
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
