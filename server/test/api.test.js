import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// A canned auditor so the API layer is tested without real network I/O.
const fakeAudit = async (url) => ({
  requestedUrl: url,
  finalUrl: url,
  reachable: true,
  statusCode: 200,
  ok: true,
  redirectCount: 0,
  redirectChain: [],
  timing: { totalMs: 1 },
  transport: { https: url.startsWith('https') },
  response: { contentType: 'text/html', contentLengthBytes: 10, bodyTruncated: false, server: null },
  securityHeaders: { hsts: true, csp: false },
  seo: { isHtml: true, title: 'X', titleLength: 1, metaDescription: null, h1Count: 1 },
  auditedAt: new Date().toISOString(),
});

let app;

beforeAll(async () => {
  // Set env BEFORE the first import of config (dynamic imports below).
  process.env.RATE_LIMIT_MAX = '5';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';

  const [{ buildApp }, { MemoryStore }, { Semaphore }, { config }] = await Promise.all([
    import('../src/app.js'),
    import('../src/stores/memoryStore.js'),
    import('../src/services/concurrency.js'),
    import('../src/config.js'),
  ]);

  const store = new MemoryStore({ ttlMs: 60_000, maxEntries: 100 });
  const semaphore = new Semaphore(10, 1000);
  app = buildApp({ store, semaphore, config, auditFn: fakeAudit });
});

describe('health', () => {
  it('GET /healthz returns ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /readyz reports store readiness', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.checks.store).toBe(true);
  });
});

describe('POST /v1/audit', () => {
  it('audits a URL and returns a MISS, then a HIT on repeat', async () => {
    const key = 'k-cache';
    const first = await request(app)
      .post('/v1/audit')
      .set('x-api-key', key)
      .send({ url: 'https://example.com' });

    expect(first.status).toBe(200);
    expect(first.body.data.cached).toBe(false);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.body.meta.requestId).toBeTruthy();
    expect(first.headers['x-request-id']).toBeTruthy();

    const second = await request(app)
      .post('/v1/audit')
      .set('x-api-key', key)
      .send({ url: 'https://example.com' });

    expect(second.status).toBe(200);
    expect(second.body.data.cached).toBe(true);
    expect(second.headers['x-cache']).toBe('HIT');
  });

  it('supports GET with a query parameter', async () => {
    const res = await request(app)
      .get('/v1/audit')
      .set('x-api-key', 'k-get')
      .query({ url: 'https://get.example' });
    expect(res.status).toBe(200);
    expect(res.body.data.statusCode).toBe(200);
  });

  it('returns a structured 400 for an invalid URL', async () => {
    const res = await request(app)
      .post('/v1/audit')
      .set('x-api-key', 'k-bad')
      .send({ url: 'ftp://nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_URL');
    expect(res.body.error.requestId).toBeTruthy();
  });
});

describe('errors and limits', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('enforces per-client rate limits', async () => {
    const key = 'k-rl';
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app)
        .post('/v1/audit')
        .set('x-api-key', key)
        .send({ url: `https://rl-${i}.example` });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 200)).toHaveLength(5);
    expect(results[results.length - 1]).toBe(429);
  });
});
