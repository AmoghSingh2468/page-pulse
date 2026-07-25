import { config } from './config.js';
import { logger } from './middleware/logging.js';
import { createStore } from './stores/index.js';
import { Semaphore } from './services/concurrency.js';
import { buildApp } from './app.js';

async function main() {
  const store = createStore(config, logger);
  await store.connect();

  const semaphore = new Semaphore(config.audit.maxConcurrency, config.audit.acquireTimeoutMs);
  const app = buildApp({ store, semaphore, config });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'Page Pulse API listening');
  });

  // Graceful shutdown: stop accepting connections, then close the store.
  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await store.close().catch((err) => logger.error({ err }, 'store close failed'));
      process.exit(0);
    });
    // Force-exit if graceful close hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
