import 'dotenv/config';

/**
 * Central, validated configuration.
 * Every tunable is an environment variable with a sane production default,
 * so behaviour is explicit and reproducible across environments.
 */
function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Config ${name} must be an integer, got "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 8080),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Persistence: if MONGODB_URI is set we use Mongo, otherwise an in-memory store.
  mongoUri: process.env.MONGODB_URI || '',

  // Audit behaviour
  audit: {
    timeoutMs: int('AUDIT_TIMEOUT_MS', 8000), // per outbound request hop
    maxRedirects: int('AUDIT_MAX_REDIRECTS', 5),
    maxResponseBytes: int('AUDIT_MAX_RESPONSE_BYTES', 2_000_000), // cap body we read
    maxConcurrency: int('AUDIT_MAX_CONCURRENCY', 20), // simultaneous outbound audits
    acquireTimeoutMs: int('AUDIT_ACQUIRE_TIMEOUT_MS', 4000), // wait for a concurrency slot
    userAgent: process.env.AUDIT_USER_AGENT || 'PagePulse/1.0 (+https://digitalheroesco.com)',
    allowPrivateIps: bool('AUDIT_ALLOW_PRIVATE_IPS', false), // SSRF guard toggle
  },

  // Cache: repeat audits of the same URL within this window are served without refetching.
  cache: {
    ttlMs: int('CACHE_TTL_MS', 60_000),
    maxEntries: int('CACHE_MAX_ENTRIES', 5000), // in-memory store bound
  },

  // Per-client rate limiting
  rateLimit: {
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    max: int('RATE_LIMIT_MAX', 60),
  },
};

export default config;
