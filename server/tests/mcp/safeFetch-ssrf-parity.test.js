// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * #3246: `safeFetch` must classify private targets exactly like `utils/ssrfGuard`.
 * These ranges slipped past its former regex list: CGNAT (100.64/10), multicast and
 * reserved (224/4, 240/4) and the hex IPv4-mapped IPv6 form (`::ffff:7f00:1`).
 * Covered through the real network entry points `assertSafeHost` and `safeFetch`.
 */

import { jest } from '@jest/globals';
import { isPrivateIP as isPrivateIp } from '../../utils/ssrfGuard.js';

const lookupMock = jest.fn();
jest.unstable_mockModule('node:dns', () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock }
}));

let platform = {};
jest.unstable_mockModule('../../configCache.js', () => ({
  default: { getPlatform: () => platform }
}));

const undiciAgentCalls = [];
const undiciFetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
jest.unstable_mockModule('undici', () => ({
  fetch: undiciFetchMock,
  Agent: class {
    constructor(opts) {
      undiciAgentCalls.push(opts);
    }
  }
}));

const { assertSafeHost, safeFetch } = await import('../../services/mcp/safeFetch.js');

const BLOCKED_LITERALS = [
  ['CGNAT low edge', '100.64.0.1'],
  ['CGNAT high edge', '100.127.255.254'],
  ['multicast', '224.0.0.1'],
  ['multicast high', '239.255.255.250'],
  ['reserved 240/4', '240.0.0.1'],
  ['broadcast', '255.255.255.255'],
  ['hex IPv4-mapped loopback', '::ffff:7f00:1'],
  ['hex IPv4-mapped IMDS', '::ffff:a9fe:a9fe'],
  ['dotted IPv4-mapped CGNAT', '::ffff:100.64.0.1'],
  ['IPv6 multicast', 'ff02::1'],
  ['NAT64 loopback', '64:ff9b::7f00:1']
];

const PUBLIC_LITERALS = [
  '8.8.8.8',
  '100.63.255.255',
  '100.128.0.1',
  '223.255.255.255',
  '::ffff:808:808'
];

beforeEach(() => {
  lookupMock.mockReset();
  undiciAgentCalls.length = 0;
  undiciFetchMock.mockClear();
  platform = {};
});

describe('safeFetch private-IP classification matches ssrfGuard (#3246)', () => {
  it.each(BLOCKED_LITERALS)('isPrivateIp blocks %s (%s)', (_label, ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(PUBLIC_LITERALS)('isPrivateIp allows public %s', ip => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it.each(BLOCKED_LITERALS)(
    'assertSafeHost rejects a name resolving to %s (%s)',
    async (_l, ip) => {
      lookupMock.mockResolvedValue({ address: ip, family: ip.includes(':') ? 6 : 4 });
      await expect(assertSafeHost('rebind.example.com')).rejects.toMatchObject({
        code: 'SSRF_BLOCKED'
      });
    }
  );

  it.each(BLOCKED_LITERALS)('safeFetch refuses a request resolving to %s (%s)', async (_l, ip) => {
    lookupMock.mockResolvedValue({ address: ip, family: ip.includes(':') ? 6 : 4 });
    await expect(safeFetch('http://rebind.example.com/x')).rejects.toMatchObject({
      code: 'SSRF_BLOCKED'
    });
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('safeFetch refuses an IP literal URL in a gap range', async () => {
    lookupMock.mockResolvedValue({ address: '100.64.0.1', family: 4 });
    await expect(safeFetch('http://100.64.0.1/')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('safeFetch lets a public address through and pins the socket to it', async () => {
    lookupMock.mockResolvedValue({ address: '8.8.8.8', family: 4 });
    await safeFetch('http://public.example.com/x');
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    expect(undiciAgentCalls[0].connect.lookup).toEqual(expect.any(Function));
    const lookupCallback = jest.fn();
    undiciAgentCalls[0].connect.lookup('public.example.com', { all: true }, lookupCallback);
    expect(lookupCallback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
  });
});

describe('safeFetch allow-lists keep working (#3246)', () => {
  it('per-caller allowHosts bypasses the private veto', async () => {
    lookupMock.mockResolvedValue({ address: '100.64.0.1', family: 4 });
    await expect(assertSafeHost('mcp.internal', ['MCP.internal'])).resolves.toBeUndefined();
  });

  it('platform.ssrf.allowedHosts (with wildcard) bypasses the private veto', async () => {
    platform = { ssrf: { allowedHosts: ['*.corp.example'] } };
    lookupMock.mockResolvedValue({ address: '::ffff:7f00:1', family: 6 });
    await expect(assertSafeHost('svc.corp.example')).resolves.toBeUndefined();
    await expect(assertSafeHost('svc.other.example')).rejects.toMatchObject({
      code: 'SSRF_BLOCKED'
    });
  });

  it('blockPrivateIps:false disables the veto', async () => {
    lookupMock.mockResolvedValue({ address: '224.0.0.1', family: 4 });
    await expect(assertSafeHost('x.example', [], false)).resolves.toBeUndefined();
  });
});

describe('safeFetch TLS bypass honours ssl.domainWhitelist (CLAUDE.md)', () => {
  const ssl = { ignoreInvalidCertificates: true, domainWhitelist: ['selfsigned.example.com'] };

  it('whitelisted https host: certificate verification is skipped and redirects are not followed', async () => {
    platform = { ssl };
    lookupMock.mockResolvedValue({ address: '8.8.8.8', family: 4 });
    await safeFetch('https://selfsigned.example.com/x');
    expect(undiciAgentCalls[0].connect.rejectUnauthorized).toBe(false);
    expect(undiciFetchMock.mock.calls[0][1].redirect).toBe('error');
  });

  it('non-whitelisted https host: certificate verification stays on', async () => {
    platform = { ssl };
    lookupMock.mockResolvedValue({ address: '8.8.8.8', family: 4 });
    await safeFetch('https://other.example.com/x');
    expect(undiciAgentCalls[0].connect.rejectUnauthorized).toBeUndefined();
    expect(undiciFetchMock.mock.calls[0][1].redirect).toBeUndefined();
  });

  it('whitelisting does not disable the SSRF veto', async () => {
    platform = { ssl };
    lookupMock.mockResolvedValue({ address: '100.64.0.1', family: 4 });
    await expect(safeFetch('https://selfsigned.example.com/x')).rejects.toMatchObject({
      code: 'SSRF_BLOCKED'
    });
  });
});
