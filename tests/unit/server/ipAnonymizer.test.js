import { describe, it, expect } from '@jest/globals';
import { anonymizeIp } from '../../../server/utils/ipAnonymizer.js';

describe('anonymizeIp', () => {
  it('masks the last octet of an IPv4 address', () => {
    expect(anonymizeIp('1.2.3.4')).toBe('1.2.3.0');
    expect(anonymizeIp('192.168.1.42')).toBe('192.168.1.0');
    expect(anonymizeIp('10.0.0.255')).toBe('10.0.0.0');
  });

  it('masks IPv4-mapped IPv6 addresses', () => {
    expect(anonymizeIp('::ffff:1.2.3.4')).toBe('::ffff:1.2.3.0');
    expect(anonymizeIp('::ffff:192.168.1.42')).toBe('::ffff:192.168.1.0');
  });

  it('zeros the last 80 bits (/48) of an IPv6 address', () => {
    expect(anonymizeIp('2001:db8:abcd:1234:5678:9abc:def0:1234')).toBe('2001:db8:abcd::');
    expect(anonymizeIp('2001:db8:0:0:0:0:0:1')).toBe('2001:db8:0::');
  });

  it('handles compressed IPv6 addresses', () => {
    expect(anonymizeIp('2001:db8::1')).toBe('2001:db8:0::');
    expect(anonymizeIp('fe80::1')).toBe('fe80:0:0::');
  });

  it('returns null for unparseable input', () => {
    expect(anonymizeIp('not-an-ip')).toBeNull();
    expect(anonymizeIp('1.2.3')).toBeNull();
  });

  it('passes through falsy values unchanged', () => {
    expect(anonymizeIp('')).toBe('');
    expect(anonymizeIp(null)).toBeNull();
    expect(anonymizeIp(undefined)).toBeUndefined();
  });

  it('returns non-string inputs unchanged', () => {
    expect(anonymizeIp(12345)).toBe(12345);
    expect(anonymizeIp({})).toEqual({});
  });
});
