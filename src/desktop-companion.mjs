import fs from "node:fs/promises";
import path from "node:path";
import { petSize, clampPet, bubbleBounds, greeting } from "./companion-layout.mjs";
import { readUserProfile, effectiveUserName } from "./user-profile.mjs";
import { windowsLoginName } from "./windows-user-name.mjs";
export { windowsLoginName } from "./windows-user-name.mjs";

export class DesktopCompanion {
  constructor({ app, BrowserWindow, screen, ipcMain, appRoot, mainWindow }) {
    Object.assign(this, { app, BrowserWindow, screen, ipcMain, appRoot, mainWindow });
    this.state = { loading: true, greeting: greeting(""), suggestions: [], scenarios: [], tasks: [], theme: "dark", busy: false };
    this.panelOpen = false; this.speechVisible = true; this.hidden = false; this.drag = null;
    this.preferencesPath = path.join(app.getPath("userData"), "desktop-companion.json");
    this.handlers();
  }
  raise() {
    for (const window of [this.pet, this.bubble]) if (window && !window.isDestroyed()) window.setAlwaysOnTop(true, "screen-saver");
  }
  areas() { return this.screen.getAllDisplays().map((display) => display.workArea); }
  send() {
    for (const window of [this.pet, this.bubble]) if (window && !window.isDestroyed()) window.webContents.send("companion:state", { ...this.state, panelOpen: this.panelOpen });
  }
  async create() {
    let saved = null;
    try { saved = JSON.parse(await fs.readFile(this.preferencesPath, "utf8")); } catch { /* First launch. */ }
    const area = this.screen.getPrimaryDisplay().workArea;
    const point = Number.isFinite(saved?.x) && Number.isFinite(saved?.y) ? saved : { x: area.x + area.width - 150, y: area.y + area.height - 190 };
    const position = clampPet(point, this.areas());
    const options = { frame: false, thickFrame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, webPreferences: { preload: path.join(this.appRoot, "src", "companion-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } };
    this.pet = new this.BrowserWindow({ ...options, ...position, ...petSize });
    this.bubble = new this.BrowserWindow({ ...options, width: 360, height: 180, focusable: true });
    this.raise();
    this.topmostTimer = setInterval(() => this.raise(), 3000); this.topmostTimer.unref();
    this.pet.on("move", () => this.positionBubble());
    for (const window of [this.pet, this.bubble]) {
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
    }
    await Promise.all([this.pet.loadFile(path.join(this.appRoot, "src", "companion.html"), { query: { surface: "pet" } }), this.bubble.loadFile(path.join(this.appRoot, "src", "companion.html"), { query: { surface: "bubble" } })]);
    this.positionBubble(); this.send(); this.pet.showInactive(); this.bubble.showInactive();
    void windowsLoginName().then(async (name) => { this.accountName=name; const profile=await readUserProfile(path.join(this.app.getPath("userData"),"user-profile.json")); this.setUserName(effectiveUserName(profile,name)); });
    this.displayListener = () => { if (!this.pet?.isDestroyed()) { const bounds = this.pet.getBounds(); const point = clampPet(bounds, this.areas(), bounds); this.pet.setPosition(point.x, point.y); this.positionBubble(); void this.save().catch(() => {}); } };
    this.screen.on("display-removed", this.displayListener);
    this.screen.on("display-metrics-changed", this.displayListener);
  }
  positionBubble() {
    if (!this.pet || this.pet.isDestroyed() || !this.bubble || this.bubble.isDestroyed()) return;
    const pet = this.pet.getBounds();
    const area = this.screen.getDisplayMatching(pet).workArea;
    const size = this.bubble.getBounds();
    this.bubble.setBounds(bubbleBounds(pet, { width: 360, height: size.height }, area));
  }
  setUserName(name) { this.state.greeting=greeting(name); this.send(); }
  async save() {
    if (!this.pet || this.pet.isDestroyed()) return;
    const { x, y } = this.pet.getBounds();
    await fs.mkdir(path.dirname(this.preferencesPath), { recursive: true });
    // Serialize writes: the last released position must survive rapid subsequent drags.
    this.saveQueue = (this.saveQueue || Promise.resolve()).catch(() => {}).then(() => fs.writeFile(this.preferencesPath, JSON.stringify({ x, y }), "utf8"));
    await this.saveQueue;
  }
  update(state) {
    const wasLoading = this.state.loading;
    const newSource = state.sourceKey && state.sourceKey !== this.state.sourceKey;
    this.state = { ...this.state, ...state, loading: state.loading === true };
    if (wasLoading || newSource) { this.speechVisible = true; this.panelOpen = false; this.raise(); if (!this.hidden) this.bubble?.showInactive(); }
    this.send();
  }
  show(open = true) {
    this.hidden = false; this.panelOpen = Boolean(open); this.speechVisible = true;
    this.raise(); this.pet?.showInactive(); this.positionBubble(); this.send(); this.bubble?.showInactive();
  }
  command(command) {
    const window = this.mainWindow();
    if (!window || window.isDestroyed()) return;
    window.show(); if (window.isMinimized()) window.restore(); window.focus();
    window.webContents.send("companion:command", command);
  }
  handlers() {
    const valid = (event) => [this.pet, this.bubble].some((window) => window && !window.isDestroyed() && event.sender === window.webContents);
    this.ipcMain.handle("companion:action", async (event, request = {}) => {
      if (!valid(event)) throw new Error("Недопустимый отправитель помощника.");
      const action = request.action;
      if (action === "drag-start" && event.sender === this.pet.webContents && Number.isFinite(request.x) && Number.isFinite(request.y)) this.drag = { x: request.x, y: request.y, bounds: this.pet.getBounds() };
      if (action === "drag-move" && event.sender === this.pet.webContents && this.drag && Number.isFinite(request.x) && Number.isFinite(request.y)) {
        const point = clampPet({ x: this.drag.bounds.x + request.x - this.drag.x, y: this.drag.bounds.y + request.y - this.drag.y }, this.areas(), this.drag.bounds);
        this.pet.setPosition(point.x, point.y); this.positionBubble();
      }
      if (action === "drag-end") { this.drag = null; await this.save(); }
      if (action === "toggle") { if (this.panelOpen && this.bubble.isVisible()) { this.panelOpen = false; this.speechVisible = false; this.bubble.hide(); this.send(); } else this.show(true); }
      if (action === "dismiss") { this.panelOpen = false; this.speechVisible = false; this.bubble.hide(); this.send(); }
      if (action === "hide") { this.hidden = true; this.pet.hide(); this.bubble.hide(); }
      if (action === "resize" && event.sender === this.bubble.webContents && Number.isFinite(request.height)) { this.bubble.setSize(360, Math.max(110, Math.min(600, Math.ceil(request.height)))); this.positionBubble(); }
      if (action === "command") {
        const command = request.command || {};
        if (["quick", "task", "suggestion", "refresh", "models", "undo-advice", "planner", "compare-planners"].includes(command.kind) && typeof command.id === "string" && command.id.length <= 100) this.command(command);
      }
      return true;
    });
  }
  destroy() {
    clearInterval(this.topmostTimer);
    if (this.displayListener) { this.screen.removeListener("display-removed", this.displayListener); this.screen.removeListener("display-metrics-changed", this.displayListener); }
    this.pet?.destroy(); this.bubble?.destroy(); this.pet = null; this.bubble = null;
  }
}
