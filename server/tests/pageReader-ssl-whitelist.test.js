// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `read_url` honours `ssl.ignoreInvalidCertificates` + `ssl.domainWhitelist`
 * (CLAUDE.md, "Outbound Connections and the SSL Whitelist"). With the global switch on,
 * only whitelisted hosts skip certificate verification; every other host is still verified.
 *
 * `readWebPage` must therefore not turn the global flag into a forced override for
 * `createAgent`: it hands over `null` and lets `createAgent` decide per host.
 */
import { jest } from '@jest/globals';

const throttledFetchMock = jest.fn();

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: throttledFetchMock
}));

jest.unstable_mockModule('../services/loop/RunStream.js', () => ({
  emitToolProgress: () => null
}));

const okResponse = () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: name => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
  text: async () => '<html><body><main>hello</main></body></html>'
});

describe('read_url SSL whitelist', () => {
  let readWebPage;
  let configCache;

  // Direct connections only, so the agent that reaches `throttledFetch` carries the TLS options.
  const setSsl = ssl =>
    configCache.setCacheEntry('config/platform.json', { ssl, proxy: { enabled: false } });
  const agentOptionsOfLastFetch = () => throttledFetchMock.mock.calls.at(-1)[2].agent.options;

  beforeEach(async () => {
    jest.clearAllMocks();
    throttledFetchMock.mockImplementation(async () => okResponse());
    configCache = (await import('../configCache.js')).default;
    ({ readWebPage } = await import('../services/pageReader/pageReader.js'));
  });

  afterEach(() => configCache.setCacheEntry('config/platform.json', {}));

  test('a whitelisted host skips certificate verification', async () => {
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['93.184.216.34'] });
    await readWebPage({ url: 'https://93.184.216.34/whitelisted' });
    expect(agentOptionsOfLastFetch().rejectUnauthorized).toBe(false);
  });

  test('a host outside the whitelist is still verified while the global switch is on', async () => {
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['93.184.216.34'] });
    await readWebPage({ url: 'https://93.184.216.35/other' });
    expect(agentOptionsOfLastFetch().rejectUnauthorized).not.toBe(false);
  });

  test('nothing skips verification while the global switch is off', async () => {
    setSsl({ ignoreInvalidCertificates: false, domainWhitelist: ['93.184.216.34'] });
    await readWebPage({ url: 'https://93.184.216.34/switch-off' });
    expect(agentOptionsOfLastFetch().rejectUnauthorized).not.toBe(false);
  });
});
