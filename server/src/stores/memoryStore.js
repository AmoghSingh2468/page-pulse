/**
 * In-memory cache store.
 *
 * Used for local development and tests (keeps CI hermetic — no database needed).
 * Bounded by maxEntries with simple LRU eviction, and entries expire after ttlMs.
 * Implements the same async interface as the Mongo store so they're interchangeable.
 */
export class MemoryStore {
  /**
   * @param {object} opts
   * @param {number} opts.ttlMs
   * @param {number} opts.maxEntries
   */
  constructor({ ttlMs, maxEntries }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    /** @type {Map<string, {value:any, expiresAt:number}>} */
    this.map = new Map();
  }

  async connect() {
    return this;
  }

  async get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Refresh recency for LRU.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  async set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    // Evict least-recently-used entries beyond the bound.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }

  async healthy() {
    return true;
  }

  async close() {
    this.map.clear();
  }
}
