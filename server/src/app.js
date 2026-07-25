import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { httpLogger } from './middleware/logging.js';
import { rateLimiter } from './middleware/rateLimit.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { buildAuditRouter } from './routes/audit.js';
import { buildHealthRouter } from './routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the Express application.
 * All external dependencies are injected so the app can be exercised end-to-end
 * in tests via supertest without a real network or database.
 *
 * @param {object} deps
 * @param {object} deps.store      cache store (get/set/healthy)
 * @param {object} deps.semaphore  concurrency limiter
 * @param {object} deps.config     config object
 * @param {Function} [deps.auditFn] auditor override for tests
 */
export function buildApp({ store, semaphore, config, auditFn }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // correct client IPs behind a proxy/load balancer

  app.use(httpLogger);
  app.use(helmet());
  app.use(cors());

  // Health checks are unauthenticated and un-rate-limited.
  app.use('/', buildHealthRouter({ store, semaphore }));

  // Rate limit the API surface.
  app.use('/v1', rateLimiter);
  app.use('/v1/audit', buildAuditRouter({ store, semaphore, config, auditFn }));

  // Public landing page (satisfies the live-build requirement in dev/standalone).
  // In the deployed MERN app this is served by the React client instead.
  app.use('/', express.static(path.join(__dirname, 'public')));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
