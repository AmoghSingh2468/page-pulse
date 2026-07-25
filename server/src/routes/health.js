import express from 'express';

/**
 * Liveness and readiness.
 *  - /healthz : process is up (liveness). Cheap, never touches dependencies.
 *  - /readyz  : dependencies are usable (readiness). Checks the store.
 * Load balancers / orchestrators use these to route traffic and gate deploys.
 */
export function buildHealthRouter({ store, semaphore }) {
  const router = express.Router();

  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', uptimeSec: Math.round(process.uptime()) });
  });

  router.get('/readyz', async (_req, res) => {
    const storeHealthy = await store.healthy().catch(() => false);
    const status = storeHealthy ? 200 : 503;
    res.status(status).json({
      status: storeHealthy ? 'ready' : 'degraded',
      checks: {
        store: storeHealthy,
        concurrency: { active: semaphore.active, waiting: semaphore.waiting, max: semaphore.max },
      },
    });
  });

  return router;
}
