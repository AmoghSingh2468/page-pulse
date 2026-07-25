import { MemoryStore } from './memoryStore.js';
import { MongoStore } from './mongoStore.js';

/**
 * Choose the cache store implementation.
 * Mongo when a URI is configured; otherwise the in-memory store.
 * Both share the same async interface: get, set, healthy, close.
 *
 * @param {import('../config.js').config} config
 * @param {import('pino').Logger} logger
 */
export function createStore(config, logger) {
  if (config.mongoUri) {
    logger.info('Using MongoDB cache store');
    return new MongoStore({ uri: config.mongoUri, ttlMs: config.cache.ttlMs });
  }
  logger.warn('MONGODB_URI not set — using in-memory cache store (not shared across instances)');
  return new MemoryStore({ ttlMs: config.cache.ttlMs, maxEntries: config.cache.maxEntries });
}
