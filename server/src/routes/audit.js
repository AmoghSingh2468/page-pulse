import express from 'express';
import { parseAndValidateUrl } from '../services/ssrf.js';
import { auditUrl } from '../services/auditor.js';
import { Errors } from '../errors.js';

/**
 * Build the /v1/audit router.
 *
 * Dependencies are injected so the route is unit-testable in isolation:
 *  - store      : cache (get/set)
 *  - semaphore  : outbound concurrency limiter
 *  - config     : audit tunables
 *  - auditFn    : the auditor (overridable in tests to avoid real network)
 *
 * Flow: validate -> cache lookup -> acquire slot -> audit -> cache store -> respond.
 */
export function buildAuditRouter({ store, semaphore, config, auditFn = auditUrl }) {
  const router = express.Router();

  async function handle(req, res, next) {
    try {
      const rawUrl = req.method === 'GET' ? req.query.url : req.body?.url;
      // Early validation gives a normalised cache key and a fast 400 on bad input.
      const parsed = parseAndValidateUrl(rawUrl);
      const cacheKey = parsed.toString();

      const bypassCache = truthy(req.query.refresh);

      if (!bypassCache) {
        const cached = await store.get(cacheKey);
        if (cached) {
          res.setHeader('x-cache', 'HIT');
          return res.status(200).json({
            data: { ...cached, cached: true },
            meta: { requestId: req.id, cache: { hit: true, ttlMs: config.cache.ttlMs } },
          });
        }
      }

      // Bound outbound concurrency; rejects with CAPACITY_EXCEEDED if none free.
      const result = await semaphore.run(() =>
        auditFn(cacheKey, {
          timeoutMs: config.audit.timeoutMs,
          maxRedirects: config.audit.maxRedirects,
          maxResponseBytes: config.audit.maxResponseBytes,
          userAgent: config.audit.userAgent,
          allowPrivateIps: config.audit.allowPrivateIps,
        }),
      );

      await store.set(cacheKey, result);
      res.setHeader('x-cache', bypassCache ? 'BYPASS' : 'MISS');
      return res.status(200).json({
        data: { ...result, cached: false },
        meta: { requestId: req.id, cache: { hit: false, ttlMs: config.cache.ttlMs } },
      });
    } catch (err) {
      return next(err);
    }
  }

  router.get('/', handle);
  router.post('/', express.json({ limit: '16kb' }), (req, res, next) => {
    if (req.body === undefined || req.body === null) {
      return next(Errors.invalidUrl('Request body must be JSON with a "url" field.'));
    }
    return handle(req, res, next);
  });

  return router;
}

function truthy(v) {
  return v === '1' || v === 'true' || v === true;
}
