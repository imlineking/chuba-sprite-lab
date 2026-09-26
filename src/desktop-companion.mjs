import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { petSize, clampPet, bubbleBounds, greeting } from "./companion-layout.mjs";

const runFile = promisify(execFile);
export async function windowsLoginName() {
  if (process.platform === "win32") {
    try {
      const command = "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $account=Get-CimInstance Win32_UserAccount -Filter ('SID=' + [char]39 + $sid + [char]39); if ($account.FullName) { $account.FullName } else { [System.Security.Principal.WindowsIdentity]::GetCurrent().Name.Split([char]92)[-1] }";
      const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + command], { windowsHide: true, timeout: 3500, encoding: "utf8" });
      if (stdout.trim()) return stdout.trim();
    } catch { /* The OS may not permit reading the full account name. */ }
  }
  try { return os.userInfo().username || ""; } catch { return ""; }
}

export class DesktopCompanion {
  constructor({ app, BrowserWindow, screen, ipcMain, appRoot, mainWindow }) {
    Object.assign(this, { app, BrowserWindow, screen, ipcMain, appRoot, mainWindow });
    this.state = { loading: true, greeting: greeting(""), suggestions: [], scenarios: [], tasks: [], theme: "dark", busy: false };
    this.panelOpen = false; this.speechVisible = true; this.hidden = false; this.drag = null;
    this.preferencesPath = path.join(app.getPath("userData"), "desktop-companion.json");
    this.handlers();
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
    this.pet.setAlwaysOnTop(true, "floating"); this.bubble.setAlwaysOnTop(true, "floating");
    this.pet.on("move", () => this.positionBubble());
    for (const window of [this.pet, this.bubble]) {
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
    }
    await Promise.all([this.pet.loadFile(path.join(this.appRoot, "src", "companion.html"), { query: { surface: "pet" } }), this.bubble.loadFile(path.join(this.appRoot, "src", "companion.html"), { query: { surface: "bubble" } })]);
    this.positionBubble(); this.send(); this.pet.showInactive(); this.bubble.showInactive();
    void windowsLoginName().then((name) => { this.state.greeting = greeting(name); this.send(); });
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
    this.state = { ...this.state, ...state, loading: false };
    if (wasLoading) { this.speechVisible = true; if (!this.hidden) this.bubble?.showInactive(); }
    this.send();
  }
  show(open = true) {
    this.hidden = false; this.panelOpen = Boolean(open); this.speechVisible = true;
    this.pet?.showInactive(); this.positionBubble(); this.send(); this.bubble?.showInactive();
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
        if (["quick", "task", "suggestion", "refresh", "models"].includes(command.kind) && typeof command.id === "string" && command.id.length <= 100) this.command(command);
      }
      return true;
    });
  }
  destroy() {
    if (this.displayListener) { this.screen.removeListener("display-removed", this.displayListener); this.screen.removeListener("display-metrics-changed", this.displayListener); }
    this.pet?.destroy(); this.bubble?.destroy(); this.pet = null; this.bubble = null;
  }
}
