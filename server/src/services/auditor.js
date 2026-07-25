import { parseAndValidateUrl, assertHostAllowed } from './ssrf.js';
import { Errors } from '../errors.js';

/**
 * Core auditor. Given a URL, it performs a resilient fetch and extracts a set of
 * "page pulse" health signals: reachability, status, redirect chain, timing,
 * transport security, response metadata, security headers and a few lightweight
 * SEO signals.
 *
 * Design notes:
 *  - Redirects are followed MANUALLY so we can (a) build the redirect chain,
 *    (b) enforce a hard hop limit, and (c) re-run the SSRF host check on every
 *    hop (a public URL can redirect to an internal address).
 *  - A single AbortController with a per-hop timeout bounds each request.
 *  - The response body is read up to a byte cap; we never buffer unbounded input.
 *  - `fetchImpl` is injectable so the whole module is testable without network.
 */

const SECURITY_HEADERS = {
  hsts: 'strict-transport-security',
  csp: 'content-security-policy',
  xContentTypeOptions: 'x-content-type-options',
  xFrameOptions: 'x-frame-options',
  referrerPolicy: 'referrer-policy',
  permissionsPolicy: 'permissions-policy',
};

/**
 * @param {string} rawUrl
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {number} opts.maxRedirects
 * @param {number} opts.maxResponseBytes
 * @param {string} opts.userAgent
 * @param {boolean} opts.allowPrivateIps
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {Function} [opts.lookup] DNS lookup override (for tests)
 */
export async function auditUrl(rawUrl, opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const startedAt = Date.now();

  const initialUrl = parseAndValidateUrl(rawUrl);

  /** @type {Array<{url:string,status:number,location:string|null}>} */
  const redirectChain = [];
  let current = initialUrl;
  let response = null;

  for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
    await assertHostAllowed(current.hostname, {
      allowPrivate: opts.allowPrivateIps,
      lookup: opts.lookup,
    });

    response = await fetchOnce(current, fetchImpl, opts);

    if (isRedirect(response.status) && response.headers.get('location')) {
      const location = response.headers.get('location');
      redirectChain.push({ url: current.toString(), status: response.status, location });
      let nextUrl;
      try {
        nextUrl = new URL(location, current); // resolve relative redirects
      } catch {
        throw Errors.fetchFailed(`Target returned an invalid redirect location: "${location}".`);
      }
      if (!['http:', 'https:'].includes(nextUrl.protocol)) {
        throw Errors.blockedTarget(`Redirect to unsupported protocol "${nextUrl.protocol}".`);
      }
      current = nextUrl;
      // Drain the redirect body so the socket can be reused / closed cleanly.
      await safeDrain(response);
      response = null;
      continue;
    }
    break; // terminal (non-redirect) response
  }

  if (response === null) {
    throw Errors.tooManyRedirects();
  }

  const { bodyText, truncated, byteLength } = await readCappedBody(response, opts.maxResponseBytes);
  const totalMs = Date.now() - startedAt;

  return {
    requestedUrl: initialUrl.toString(),
    finalUrl: current.toString(),
    reachable: true,
    statusCode: response.status,
    ok: response.ok,
    redirectCount: redirectChain.length,
    redirectChain,
    timing: { totalMs },
    transport: { https: current.protocol === 'https:' },
    response: {
      contentType: response.headers.get('content-type') || null,
      contentLengthBytes: byteLength,
      bodyTruncated: truncated,
      server: response.headers.get('server') || null,
    },
    securityHeaders: extractSecurityHeaders(response.headers),
    seo: extractSeoSignals(bodyText, response.headers.get('content-type')),
    auditedAt: new Date().toISOString(),
  };
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

async function fetchOnce(url, fetchImpl, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    return await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'user-agent': opts.userAgent,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw Errors.fetchTimeout();
    throw Errors.fetchFailed(`Request to ${url.hostname} failed: ${err?.message || 'unknown error'}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Read the body up to a byte cap without buffering unbounded input. */
async function readCappedBody(response, maxBytes) {
  const contentType = response.headers.get('content-type') || '';
  // Only bother reading text-ish bodies; for binary we still measure size.
  if (!response.body) {
    return { bodyText: '', truncated: false, byteLength: 0 };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        truncated = true;
        chunks.push(value);
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    // Partial body is acceptable for an audit; return what we have.
  }
  const isText = /text|html|json|xml|javascript/i.test(contentType);
  let bodyText = '';
  if (isText) {
    const merged = concatChunks(chunks, Math.min(received, maxBytes));
    bodyText = new TextDecoder('utf-8', { fatal: false }).decode(merged);
  }
  return { bodyText, truncated, byteLength: received };
}

function concatChunks(chunks, totalLen) {
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, totalLen - offset);
    if (take <= 0) break;
    out.set(c.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

async function safeDrain(response) {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    /* ignore */
  }
}

function extractSecurityHeaders(headers) {
  const out = {};
  for (const [key, header] of Object.entries(SECURITY_HEADERS)) {
    out[key] = headers.get(header) !== null;
  }
  return out;
}

/** Best-effort, dependency-free extraction of a few SEO signals from HTML. */
function extractSeoSignals(bodyText, contentType) {
  const isHtml = /html/i.test(contentType || '') || /<html[\s>]/i.test(bodyText);
  if (!isHtml || !bodyText) {
    return { isHtml: false, title: null, titleLength: 0, metaDescription: null, h1Count: 0 };
  }
  const titleMatch = bodyText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? collapse(titleMatch[1]) : null;

  const descMatch = bodyText.match(
    /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i,
  ) || bodyText.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["']/i);
  const metaDescription = descMatch ? collapse(descMatch[1]) : null;

  const h1Count = (bodyText.match(/<h1[\s>]/gi) || []).length;

  return {
    isHtml: true,
    title,
    titleLength: title ? title.length : 0,
    metaDescription,
    h1Count,
  };
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}
