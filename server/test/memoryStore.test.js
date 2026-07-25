import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/stores/memoryStore.js';

describe('MemoryStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores and retrieves values within the TTL', async () => {
    const store = new MemoryStore({ ttlMs: 1000, maxEntries: 10 });
    await store.set('a', { v: 1 });
    expect(await store.get('a')).toEqual({ v: 1 });
  });

  it('expires values after the TTL', async () => {
    const store = new MemoryStore({ ttlMs: 1000, maxEntries: 10 });
    await store.set('a', { v: 1 });
    vi.advanceTimersByTime(1001);
    expect(await store.get('a')).toBeNull();
  });

  it('evicts least-recently-used entries beyond maxEntries', async () => {
    const store = new MemoryStore({ ttlMs: 10_000, maxEntries: 2 });
    await store.set('a', 1);
    await store.set('b', 2);
    await store.get('a'); // 'a' becomes most-recently-used
    await store.set('c', 3); // should evict 'b'
    expect(await store.get('a')).toBe(1);
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).toBe(3);
  });

  it('returns null for missing keys', async () => {
    const store = new MemoryStore({ ttlMs: 1000, maxEntries: 10 });
    expect(await store.get('missing')).toBeNull();
  });
});
