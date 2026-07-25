import { describe, it, expect } from 'vitest';
import { auditUrl } from '../src/services/auditor.js';

const publicLookup = async () => [{ address: '93.184.216.34' }];

const baseOpts = {
  timeoutMs: 2000,
  maxRedirects: 5,
  maxResponseBytes: 1_000_000,
  userAgent: 'test-agent',
  allowPrivateIps: false,
  lookup: publicLookup,
};

const htmlResponse = (html, headers = {}) =>
  new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });

describe('auditUrl', () => {
  it('audits a simple HTML page and extracts signals', async () => {
    const html = `
      <html><head>
        <title>  Example  Domain </title>
        <meta name="description" content="A description here.">
      </head><body><h1>Hello</h1><h1>Again</h1></body></html>`;
    const fetchImpl = async () =>
      htmlResponse(html, { 'strict-transport-security': 'max-age=63072000', server: 'nginx' });

    const result = await auditUrl('https://example.com', { ...baseOpts, fetchImpl });

    expect(result.statusCode).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.transport.https).toBe(true);
    expect(result.redirectCount).toBe(0);
    expect(result.seo.title).toBe('Example Domain');
    expect(result.seo.metaDescription).toBe('A description here.');
    expect(result.seo.h1Count).toBe(2);
    expect(result.securityHeaders.hsts).toBe(true);
    expect(result.securityHeaders.csp).toBe(false);
    expect(result.response.server).toBe('nginx');
    expect(typeof result.timing.totalMs).toBe('number');
    expect(result.finalUrl).toBe('https://example.com/');
  });

  it('follows redirects and records the chain', async () => {
    const fetchImpl = async (url) => {
      if (url === 'https://example.com/') {
        return new Response('', { status: 301, headers: { location: 'https://example.com/final' } });
      }
      return htmlResponse('<html><title>Final</title></html>');
    };
    const result = await auditUrl('https://example.com', { ...baseOpts, fetchImpl });
    expect(result.redirectCount).toBe(1);
    expect(result.redirectChain[0]).toMatchObject({ status: 301 });
    expect(result.finalUrl).toBe('https://example.com/final');
    expect(result.seo.title).toBe('Final');
  });

  it('blocks a redirect that points at a private address (SSRF)', async () => {
    const lookup = async (host) =>
      host === 'internal.example' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }];
    const fetchImpl = async (url) => {
      if (url === 'https://example.com/') {
        return new Response('', {
          status: 302,
          headers: { location: 'http://internal.example/admin' },
        });
      }
      return htmlResponse('<html></html>');
    };
    await expect(
      auditUrl('https://example.com', { ...baseOpts, lookup, fetchImpl }),
    ).rejects.toMatchObject({ code: 'BLOCKED_TARGET' });
  });

  it('times out slow responses', async () => {
    const fetchImpl = (url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    await expect(
      auditUrl('https://slow.example', { ...baseOpts, timeoutMs: 20, fetchImpl }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT', status: 504 });
  });

  it('fails when the redirect limit is exceeded', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      return new Response('', {
        status: 301,
        headers: { location: `https://example.com/hop${n}` },
      });
    };
    await expect(
      auditUrl('https://example.com', { ...baseOpts, maxRedirects: 2, fetchImpl }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  it('caps the body it reads and flags truncation', async () => {
    const big = 'x'.repeat(5000);
    const fetchImpl = async () =>
      new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } });
    const result = await auditUrl('https://big.example', {
      ...baseOpts,
      maxResponseBytes: 1000,
      fetchImpl,
    });
    expect(result.response.bodyTruncated).toBe(true);
    expect(result.response.contentLengthBytes).toBeGreaterThan(1000);
  });

  it('propagates INVALID_URL for bad input', async () => {
    await expect(auditUrl('not-a-url', baseOpts)).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
});
