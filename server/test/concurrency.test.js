import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/services/concurrency.js';

const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('Semaphore', () => {
  it('runs up to max tasks concurrently', async () => {
    const sem = new Semaphore(2, 1000);
    let active = 0;
    let peak = 0;
    const gates = [defer(), defer(), defer()];

    const task = (i) =>
      sem.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gates[i].promise;
        active -= 1;
      });

    const p0 = task(0);
    const p1 = task(1);
    const p2 = task(2); // must wait for a slot

    // Let the first two acquire.
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(2);
    expect(sem.waiting).toBe(1);

    gates[0].resolve();
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all([p0, p1, p2]);
    expect(peak).toBe(2);
    expect(sem.active).toBe(0);
  });

  it('rejects with CAPACITY_EXCEEDED when no slot frees in time', async () => {
    const sem = new Semaphore(1, 20);
    const gate = defer();
    const held = sem.run(async () => {
      await gate.promise;
    });

    await expect(sem.run(async () => 'never')).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
      status: 503,
    });

    gate.resolve();
    await held;
  });

  it('hands a freed slot to a waiter', async () => {
    const sem = new Semaphore(1, 1000);
    const gate = defer();
    const first = sem.run(async () => {
      await gate.promise;
    });
    let secondRan = false;
    const second = sem.run(async () => {
      secondRan = true;
    });

    expect(secondRan).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    expect(secondRan).toBe(true);
    expect(sem.active).toBe(0);
  });
});
