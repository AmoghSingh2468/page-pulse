import mongoose from 'mongoose';

/**
 * MongoDB cache store (the "M" in MERN).
 *
 * Audit results are persisted keyed by normalised URL. A TTL index on
 * `expiresAt` lets MongoDB expire stale cache entries automatically, so the
 * cache window is enforced by the database rather than application timers.
 * This gives a DURABLE cache SHARED across all API instances — important once
 * the service is horizontally scaled (see ARCHITECTURE.md).
 */
const auditCacheSchema = new mongoose.Schema(
  {
    _id: { type: String }, // normalised cache key (the URL)
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, timestamps: true },
);

// MongoDB removes documents shortly after `expiresAt`.
auditCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export class MongoStore {
  /**
   * @param {object} opts
   * @param {string} opts.uri
   * @param {number} opts.ttlMs
   */
  constructor({ uri, ttlMs }) {
    this.uri = uri;
    this.ttlMs = ttlMs;
    this.conn = null;
    this.model = null;
  }

  async connect() {
    this.conn = await mongoose.createConnection(this.uri, {
      serverSelectionTimeoutMS: 5000,
    }).asPromise();
    this.model = this.conn.model('AuditCache', auditCacheSchema);
    await this.model.init(); // ensure indexes (incl. TTL) are built
    return this;
  }

  async get(key) {
    const doc = await this.model.findById(key).lean();
    if (!doc) return null;
    // Defensive: TTL removal is eventual, so honour expiresAt in-app too.
    if (new Date(doc.expiresAt).getTime() <= Date.now()) return null;
    return doc.value;
  }

  async set(key, value) {
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.model.findByIdAndUpdate(
      key,
      { value, expiresAt },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return value;
  }

  async healthy() {
    // 1 === connected
    return this.conn?.readyState === 1;
  }

  async close() {
    if (this.conn) await this.conn.close();
  }
}
