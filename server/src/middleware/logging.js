import { randomUUID } from 'node:crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { config } from '../config.js';

/** Base structured logger. JSON lines in production; pretty in dev if available. */
export const logger = pino({
  level: config.logLevel,
  base: { service: 'page-pulse' },
  redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
});

/**
 * HTTP logging middleware.
 * - Assigns / honours a request ID (X-Request-Id) for correlation.
 * - Emits one structured log line per request with the request ID attached.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customProps(req) {
    return { requestId: req.id };
  },
});
