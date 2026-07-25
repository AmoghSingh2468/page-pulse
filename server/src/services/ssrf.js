import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Errors } from '../errors.js';

/**
 * SSRF protection.
 *
 * Auditing arbitrary user-supplied URLs is a classic Server-Side Request Forgery
 * vector: without guards, a caller could point the service at cloud metadata
 * endpoints (169.254.169.254), localhost admin panels, or internal services.
 *
 * We defend in two layers:
 *   1. parseAndValidateUrl — scheme allow-list + syntactic checks.
 *   2. assertHostAllowed   — resolve DNS and reject private / reserved ranges.
 *
 * assertHostAllowed is re-run on every redirect hop, because a public URL can
 * 301 to an internal address.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// ipaddr.js range() categories we consider unsafe to reach.
const BLOCKED_RANGES = new Set([
  'unspecified', // 0.0.0.0 / ::
  'broadcast',
  'multicast',
  'linkLocal', // 169.254.0.0/16, fe80::/10 (includes cloud metadata)
  'loopback', // 127.0.0.0/8, ::1
  'private', // 10/8, 172.16/12, 192.168/16
  'uniqueLocal', // fc00::/7
  'reserved',
  'carrierGradeNat', // 100.64.0.0/10
]);

/**
 * Parse and syntactically validate a candidate URL.
 * @param {unknown} input
 * @returns {URL}
 */
export function parseAndValidateUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw Errors.invalidUrl('URL must be a non-empty string.');
  }
  const trimmed = input.trim();
  if (trimmed.length > 2048) {
    throw Errors.invalidUrl('URL exceeds the maximum length of 2048 characters.');
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw Errors.invalidUrl(`"${trimmed}" is not a valid absolute URL.`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw Errors.invalidUrl(`Unsupported protocol "${url.protocol}". Use http or https.`, {
      protocol: url.protocol,
    });
  }
  if (!url.hostname) {
    throw Errors.invalidUrl('URL is missing a hostname.');
  }
  return url;
}

/**
 * Return true if an IP string falls in a blocked range.
 * @param {string} ip
 * @param {boolean} allowPrivate
 */
export function isBlockedIp(ip, allowPrivate) {
  if (allowPrivate) return false;
  let addr;
  try {
    addr = ipaddr.process(ip); // normalises IPv4-mapped IPv6
  } catch {
    return true; // unparseable => treat as unsafe
  }
  return BLOCKED_RANGES.has(addr.range());
}

/**
 * Resolve a hostname and assert every resolved address is public.
 * Throws Errors.blockedTarget when any address is disallowed.
 *
 * @param {string} hostname
 * @param {object} [opts]
 * @param {boolean} [opts.allowPrivate=false]
 * @param {(host:string)=>Promise<Array<{address:string}>>} [opts.lookup] injectable for tests
 */
export async function assertHostAllowed(hostname, opts = {}) {
  const allowPrivate = opts.allowPrivate ?? false;
  const lookup = opts.lookup ?? ((h) => dns.lookup(h, { all: true, verbatim: true }));

  // A literal IP hostname still needs checking.
  if (ipaddr.isValid(hostname)) {
    if (isBlockedIp(hostname, allowPrivate)) {
      throw Errors.blockedTarget(`Host ${hostname} resolves to a blocked address range.`);
    }
    return;
  }

  let records;
  try {
    records = await lookup(hostname);
  } catch {
    throw Errors.fetchFailed(`DNS resolution failed for ${hostname}.`);
  }
  if (!records || records.length === 0) {
    throw Errors.fetchFailed(`No DNS records for ${hostname}.`);
  }
  for (const rec of records) {
    if (isBlockedIp(rec.address, allowPrivate)) {
      throw Errors.blockedTarget(`Host ${hostname} resolves to a blocked address range.`, {
        address: rec.address,
      });
    }
  }
}
