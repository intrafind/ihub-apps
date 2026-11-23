// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Bedrock model listing goes out through `httpFetch`, so the platform's
 * proxy and SSL whitelist apply to it (CLAUDE.md "Outbound Connections and
 * the SSL Whitelist"): `node-fetch` is replaced by a recorder, and the agent
 * it is handed is inspected for a whitelisted and a non-whitelisted host.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';

const platform = {
  ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['bedrock.eu-central-1.amazonaws.com'] },
  proxy: { enabled: true, https: 'http://proxy.corp.example:3128', noProxy: [] }
};

jest.unstable_mockModule('../configCache.js', () => ({
  resolveEnvVarsInObject: value => value,
  default: {
    getPlatform: () => platform,
    getProviders: () => ({ data: [], etag: 'p' }),
    getModels: () => ({ data: [], etag: 'm' })
  }
}));

const fetchCalls = [];
jest.unstable_mockModule('node-fetch', () => ({
  default: async (url, options) => {
    fetchCalls.push({ url, options });
    const body = url.includes('/foundation-models')
      ? { modelSummaries: [] }
      : { inferenceProfileSummaries: [] };
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    };
  }
}));

const { discoverBedrockModels } = await import('../services/BedrockModelDiscovery.js');

/** The TLS options the agent applies to the destination behind the proxy. */
function destinationTls(agent) {
  return agent?._destinationTlsOptions || {};
}

describe('Bedrock model listing transport', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
  });

  it('sends both listing calls through the proxy agent, skipping verification only for a whitelisted host', async () => {
    await discoverBedrockModels({ region: 'eu-central-1', apiKey: 'k' });

    expect(fetchCalls.map(c => new URL(c.url).pathname)).toEqual([
      '/foundation-models',
      '/inference-profiles'
    ]);
    for (const { options } of fetchCalls) {
      expect(options.agent).toBeDefined();
      expect(String(options.agent.proxy)).toContain('proxy.corp.example');
      expect(destinationTls(options.agent).rejectUnauthorized).toBe(false);
    }
  });

  it('keeps certificate verification for a host that is not on the whitelist', async () => {
    await discoverBedrockModels({ region: 'us-east-1', apiKey: 'k' });

    expect(fetchCalls[0].url).toBe('https://bedrock.us-east-1.amazonaws.com/foundation-models');
    for (const { options } of fetchCalls) {
      expect(options.agent).toBeDefined();
      expect(String(options.agent.proxy)).toContain('proxy.corp.example');
      expect(destinationTls(options.agent).rejectUnauthorized).toBeUndefined();
    }
  });
});
