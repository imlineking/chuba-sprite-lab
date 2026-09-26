const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktopCompanion", {
  action: (request) => ipcRenderer.invoke("companion:action", request),
  onState: (callback) => ipcRenderer.on("companion:state", (_event, state) => callback(state)),
});
