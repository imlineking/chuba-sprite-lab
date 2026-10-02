export class StageCache {
  constructor({ maxEntries = 128, maxBytes = 256 * 1024 * 1024 } = {}) { this.entries = new Map(); this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.bytes = 0; this.hits = 0; this.misses = 0; }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) { this.misses++; return null; }
    this.entries.delete(key); this.entries.set(key, entry); this.hits++; return entry.value;
  }
  set(key, value) {
    const seen = new Set();
    const size = item => { if (!item || typeof item !== "object" || seen.has(item)) return 0; seen.add(item); return ArrayBuffer.isView(item) ? item.byteLength : Object.values(item).reduce((sum, child) => sum + size(child), 0); };
    const bytes = size(value);
    if (this.entries.has(key)) { this.bytes -= this.entries.get(key).bytes; this.entries.delete(key); }
    if (bytes > this.maxBytes) return value;
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) { const oldest = this.entries.keys().next().value; this.bytes -= this.entries.get(oldest).bytes; this.entries.delete(oldest); }
    return value;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  stats() { return { entries: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses }; }
}
