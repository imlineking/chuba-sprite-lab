import fs from "node:fs/promises";
import path from "node:path";
import { petSize, clampPet, bubbleBounds, moveCompanionPair, greeting } from "./companion-layout.mjs";
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
    // Keep the helper available without repeatedly reordering native windows.
    for (const window of [this.pet, this.bubble]) if (window && !window.isDestroyed() && !window.isAlwaysOnTop()) window.setAlwaysOnTop(true, "floating");
  }
  areas() { return this.screen.getAllDisplays().map((display) => display.workArea); }
  moveDrag(fallback) {
    if (!this.drag) return false;
    const cursor = this.screen.getCursorScreenPoint?.() || fallback;
    if (!cursor) return false;
    const delta = { x: cursor.x - this.drag.x, y: cursor.y - this.drag.y };
    if (!this.drag.moved && Math.hypot(delta.x, delta.y) < 5) return false;
    this.drag.moved = true;
    const pair = moveCompanionPair(this.drag.pet, this.drag.bubble, delta, this.areas(), this.drag.bubbleVisible);
    this.bubbleOffset = { x: pair.bubble.x - pair.pet.x, y: pair.bubble.y - pair.pet.y };
    this.pet.setBounds({ ...pair.pet, ...petSize }); this.bubble.setBounds(pair.bubble);
    return true;
  }
  updateMousePassthrough() {
    const cursor = this.screen.getCursorScreenPoint();
    for (const window of [this.pet, this.bubble]) {
      if (!window || window.isDestroyed()) continue;
      const bounds = window.getBounds(), inset = window === this.bubble ? 7 : 0;
      const inside = window.isVisible() && cursor.x >= bounds.x + inset && cursor.x < bounds.x + bounds.width - inset && cursor.y >= bounds.y + inset && cursor.y < bounds.y + bounds.height - inset;
      const ignore = !inside && this.drag?.sender !== window.webContents;
      if (this.mousePassthrough.get(window) !== ignore) { window.setIgnoreMouseEvents(ignore, { forward: true }); this.mousePassthrough.set(window, ignore); }
    }
  }
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
    this.pet = new this.BrowserWindow({ ...options, ...position, ...petSize, minWidth: petSize.width, maxWidth: petSize.width, minHeight: petSize.height, maxHeight: petSize.height, fullscreenable: false, focusable: false });
    this.bubble = new this.BrowserWindow({ ...options, width: 360, height: 180, focusable: true });
    this.bubbleHeight = 180;
    this.bubbleOffset = null;
    this.raise();
    this.pet.on("move", () => { if (!this.drag) this.positionBubble(); });
    for (const window of [this.pet, this.bubble]) {
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
    }
    await Promise.all([this.pet.loadFile(path.join(this.appRoot, "src", "companion.html"), { query: { surface: "pet" } }), this.bubble.loadFile(path.join(this.appRoot, "src", "companion.html"), { query: { surface: "bubble" } })]);
    this.pet.setBounds({ ...position, ...petSize });
    this.positionBubble(); this.send(); this.pet.showInactive(); this.bubble.showInactive();
    this.mousePassthrough = new Map(); this.updateMousePassthrough();
    this.mouseTimer = setInterval(() => { this.moveDrag(); this.updateMousePassthrough(); }, 16); this.mouseTimer.unref();
    void windowsLoginName().then(async (name) => { this.accountName=name; const profile=await readUserProfile(path.join(this.app.getPath("userData"),"user-profile.json")); this.setUserName(effectiveUserName(profile,name)); });
    this.displayListener = () => { if (!this.pet?.isDestroyed()) { const bounds = this.pet.getBounds(); const point = clampPet(bounds, this.areas(), petSize); this.pet.setBounds({ ...point, ...petSize }); this.positionBubble(); void this.save().catch(() => {}); } };
    this.screen.on("display-removed", this.displayListener);
    this.screen.on("display-metrics-changed", this.displayListener);
  }
  positionBubble(reset = false) {
    if (!this.pet || this.pet.isDestroyed() || !this.bubble || this.bubble.isDestroyed()) return;
    const pet = this.pet.getBounds();
    const area = this.screen.getDisplayMatching(pet).workArea;
    const size = { width: 360, height: this.bubbleHeight || this.bubble.getBounds().height };
    const bounds = reset || !this.bubbleOffset
      ? bubbleBounds(pet, { width: 360, height: size.height }, area)
      : { width: Math.min(360, area.width), height: Math.min(size.height, area.height), x: pet.x + this.bubbleOffset.x, y: pet.y + this.bubbleOffset.y };
    bounds.x = Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)));
    bounds.y = Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)));
    this.bubbleOffset = { x: bounds.x - pet.x, y: bounds.y - pet.y };
    this.bubble.setBounds(bounds);
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
      if (action === "drag-start" && Number.isFinite(request.x) && Number.isFinite(request.y)) {
        // Native bounds and cursor coordinates share Electron's DIP space. DOM screenX
        // differs at fractional Windows scaling and changes as the window moves.
        const cursor = this.screen.getCursorScreenPoint?.() || request;
        this.drag = { sender: event.sender, x: cursor.x, y: cursor.y, pet: { ...this.pet.getBounds(), ...petSize }, bubble: { ...this.bubble.getBounds(), width: 360, height: this.bubbleHeight || this.bubble.getBounds().height }, bubbleVisible: this.bubble.isVisible() };
      }
      if (action === "drag-move" && this.drag?.sender === event.sender && Number.isFinite(request.x) && Number.isFinite(request.y)) {
        this.moveDrag(request);
      }
      if (action === "drag-end" && this.drag?.sender === event.sender) { this.drag = null; await this.save(); }
      if (action === "toggle") { if (this.panelOpen && this.bubble.isVisible()) { this.panelOpen = false; this.speechVisible = false; this.bubble.hide(); this.send(); } else this.show(true); }
      if (action === "dismiss") { this.panelOpen = false; this.speechVisible = false; this.bubble.hide(); this.send(); }
      if (action === "hide") { this.hidden = true; this.pet.hide(); this.bubble.hide(); }
      if (action === "resize" && event.sender === this.bubble.webContents && Number.isFinite(request.height)) { this.bubbleHeight = Math.max(110, Math.min(600, Math.ceil(request.height))); this.positionBubble(true); }
      if (action === "command") {
        const command = request.command || {};
        if (["quick", "task", "suggestion", "refresh", "models", "undo-advice", "planner", "compare-planners"].includes(command.kind) && typeof command.id === "string" && command.id.length <= 100) this.command(command);
      }
      return true;
    });
  }
  destroy() {
    clearInterval(this.mouseTimer); this.drag = null;
    if (this.displayListener) { this.screen.removeListener("display-removed", this.displayListener); this.screen.removeListener("display-metrics-changed", this.displayListener); }
    this.pet?.destroy(); this.bubble?.destroy(); this.pet = null; this.bubble = null;
  }
}
