import { describe, it, expect } from 'vitest';
import { parseAndValidateUrl, isBlockedIp, assertHostAllowed } from '../src/services/ssrf.js';

describe('parseAndValidateUrl', () => {
  it('accepts valid http and https URLs', () => {
    expect(parseAndValidateUrl('https://example.com').hostname).toBe('example.com');
    expect(parseAndValidateUrl('http://example.com/path?q=1').protocol).toBe('http:');
  });

  it('rejects non-string / empty input', () => {
    expect(() => parseAndValidateUrl(undefined)).toThrowError(/non-empty/);
    expect(() => parseAndValidateUrl('   ')).toThrowError(/non-empty/);
  });

  it('rejects unsupported protocols', () => {
    expect(() => parseAndValidateUrl('ftp://example.com')).toThrowError(/Unsupported protocol/);
    expect(() => parseAndValidateUrl('file:///etc/passwd')).toThrowError(/Unsupported protocol/);
    expect(() => parseAndValidateUrl('javascript:alert(1)')).toThrowError();
  });

  it('rejects malformed URLs', () => {
    expect(() => parseAndValidateUrl('not a url')).toThrowError(/not a valid/);
    expect(() => parseAndValidateUrl('example.com')).toThrowError(); // no scheme
  });

  it('enforces a maximum length', () => {
    const long = `https://example.com/${'a'.repeat(3000)}`;
    expect(() => parseAndValidateUrl(long)).toThrowError(/maximum length/);
  });
});

describe('isBlockedIp', () => {
  it('blocks loopback, private, and link-local ranges by default', () => {
    expect(isBlockedIp('127.0.0.1', false)).toBe(true);
    expect(isBlockedIp('10.0.0.5', false)).toBe(true);
    expect(isBlockedIp('192.168.1.1', false)).toBe(true);
    expect(isBlockedIp('169.254.169.254', false)).toBe(true); // cloud metadata
    expect(isBlockedIp('::1', false)).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isBlockedIp('1.1.1.1', false)).toBe(false);
    expect(isBlockedIp('8.8.8.8', false)).toBe(false);
  });

  it('respects the allowPrivate override', () => {
    expect(isBlockedIp('127.0.0.1', true)).toBe(false);
  });

  it('treats unparseable input as blocked', () => {
    expect(isBlockedIp('garbage', false)).toBe(true);
  });
});

describe('assertHostAllowed', () => {
  const lookupTo = (address) => async () => [{ address }];

  it('passes for a host resolving to a public IP', async () => {
    await expect(
      assertHostAllowed('example.com', { lookup: lookupTo('93.184.216.34') }),
    ).resolves.toBeUndefined();
  });

  it('throws BLOCKED_TARGET for a host resolving to a private IP', async () => {
    await expect(
      assertHostAllowed('internal.example', { lookup: lookupTo('10.1.2.3') }),
    ).rejects.toMatchObject({ code: 'BLOCKED_TARGET' });
  });

  it('checks literal IP hostnames without DNS', async () => {
    await expect(assertHostAllowed('169.254.169.254', {})).rejects.toMatchObject({
      code: 'BLOCKED_TARGET',
    });
  });
});
