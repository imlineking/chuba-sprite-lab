// Selection/viewport changes are not artwork edits. Everything consumed by a build is.
export function workingSignature(options) {
  const { previewFrameIndex: _frame, attachmentPlacements: _placements, ...content } = options;
  return JSON.stringify(content);
}

export function independentOptions(options, index) {
  const local = { ...options, timeline: null, excludedFrames: [], animationName: undefined };
  for (const key of ["frameOverrides", "frameMetadata", "frameTransforms", "preparedCleanup"])
    local[key] = options[key]?.[index] != null ? { 0: options[key][index] } : {};
  local.aiEdits = (options.aiEdits || []).filter(e => e.applyAll || Number(e.frameIndex) === index).map(e => ({ ...e, frameIndex: 0 }));
  return local;
}

// Pure clock: pausing excludes wall time; long stalls skip directly to the right frame.
export class FrameClock {
  constructor(frames = []) { this.setFrames(frames); }
  setFrames(frames) {
    this.frames = frames; this.total = frames.reduce((n, f) => n + Math.max(10, Number(f.durationMs) || 100), 0);
    this.index = 0; this.elapsed = 0; this.playing = false; this.last = null;
  }
  seek(index) {
    this.index = Math.max(0, Math.min(this.frames.length - 1, index));
    this.elapsed = this.frames.slice(0, this.index).reduce((n, f) => n + Math.max(10, Number(f.durationMs) || 100), 0);
    this.last = null;
  }
  pause() { this.playing = false; this.last = null; }
  play(now) { if (this.frames.length > 1) { this.playing = true; this.last = now; } }
  tick(now) {
    if (!this.playing || !this.total) return this.index;
    if (this.last != null) this.elapsed = (this.elapsed + Math.max(0, now - this.last)) % this.total;
    this.last = now;
    let time = this.elapsed; this.index = 0;
    while (this.index < this.frames.length - 1 && time >= Math.max(10, Number(this.frames[this.index].durationMs) || 100)) {
      time -= Math.max(10, Number(this.frames[this.index].durationMs) || 100); this.index++;
    }
    return this.index;
  }
}
