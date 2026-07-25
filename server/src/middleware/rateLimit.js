import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

/**
 * Per-client rate limiting.
 *
 * Clients are keyed by API key (X-Api-Key) when present, else by IP. This means
 * authenticated clients get their own budget rather than sharing an IP bucket.
 * Responses use a structured error envelope consistent with the rest of the API.
 *
 * NOTE: the default store is in-process. For multi-instance deployments this
 * should be backed by Redis (documented in ARCHITECTURE.md) so limits are global.
 */
export const rateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true, // RateLimit-* headers
  legacyHeaders: false,
  keyGenerator(req) {
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) return `key:${apiKey}`;
    return `ip:${req.ip}`;
  },
  handler(req, res) {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded. Slow down and retry after the window resets.',
        requestId: req.id,
      },
    });
  },
});
