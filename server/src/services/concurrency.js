import { Errors } from '../errors.js';

/**
 * A counting semaphore with a bounded acquire timeout.
 *
 * The auditor performs outbound network I/O; without a cap, a burst of requests
 * would open unbounded sockets and exhaust file descriptors / memory. This limits
 * how many audits run concurrently. Callers that cannot get a slot within
 * `acquireTimeoutMs` are rejected with CAPACITY_EXCEEDED (503) rather than queued
 * forever — fail fast beats a growing backlog under load.
 */
export class Semaphore {
  /**
   * @param {number} max maximum concurrent holders
   * @param {number} acquireTimeoutMs max time to wait for a slot
   */
  constructor(max, acquireTimeoutMs) {
    this.max = max;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.active = 0;
    /** @type {Array<{resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
    this.queue = [];
  }

  get waiting() {
    return this.queue.length;
  }

  acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(Errors.capacityExceeded());
      }, this.acquireTimeoutMs);
      // Do not keep the event loop alive solely for a queued waiter.
      if (typeof timer.unref === 'function') timer.unref();
      this.queue.push({ resolve, reject, timer });
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(); // active count stays the same: slot handed to the next waiter
    } else if (this.active > 0) {
      this.active -= 1;
    }
  }

  /**
   * Run a function while holding a slot, always releasing afterwards.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
