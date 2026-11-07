// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The marketplace fetch guard (#3087): a registry's own host is fetched as it
 * is, private address or not; a GitHub registry also reaches the GitHub pair;
 * every other host must be a public address — checked again on every
 * redirect hop, with redirects followed by hand.
 *
 * The public check is the real `assertPublicTarget` for IP literals (no DNS is
 * involved there). Host names are answered from a fake DNS table instead of
 * the network, and a test that needs a "public" third-party server serves it
 * from loopback by naming its host in `treatedAsPublic`.
 *
 * The HTTP part runs real requests through `throttledFetch` → `httpFetch`
 * against two loopback servers: A is the registry's own host, B is "another
 * host".
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports, run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import http from 'node:http';

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    getModels: () => ({ data: [] })
  }
}));

const { assertPublicTarget, isPrivateIP } = await import('../utils/ssrfGuard.js');
const {
  assertAllowedMarketplaceTarget,
  marketplaceFetch,
  marketplaceTargetGuard,
  registryOwnHosts,
  MARKETPLACE_TARGET_BLOCKED,
  MAX_MARKETPLACE_REDIRECTS
} = await import('../services/marketplace/marketplaceFetch.js');

/** What host names "resolve" to in these tests. */
const FAKE_DNS = {
  'registry.example': ['93.184.216.34'],
  'cdn.example.org': ['93.184.216.35'],
  'api.github.com': ['140.82.112.6'],
  'intranet.example.com': ['10.0.0.5']
};

/** `URL.host` values a test lets through as public (loopback servers standing in for one). */
let treatedAsPublic = new Set();
/** Every host the public check was asked about, in order. */
let checkedHosts = [];

const realCheckTarget = marketplaceTargetGuard.checkTarget;

beforeEach(() => {
  treatedAsPublic = new Set();
  checkedHosts = [];
  marketplaceTargetGuard.checkTarget = async url => {
    checkedHosts.push(url.host);
    // An IP-literal URL never consults the pinned lookup, so loopback can
    // stand in for the "public" address here.
    if (treatedAsPublic.has(url.host)) return { ok: true, addresses: ['127.0.0.1'] };
    const addresses = FAKE_DNS[url.hostname];
    if (!addresses) return assertPublicTarget(url);
    const privateAddress = addresses.find(address => isPrivateIP(address));
    return privateAddress
      ? { ok: false, reason: `host resolves to private IP ${privateAddress}` }
      : { ok: true, addresses };
  };
});

afterAll(() => {
  marketplaceTargetGuard.checkTarget = realCheckTarget;
});

const PUBLIC_REGISTRY = { id: 'public', source: 'https://registry.example/catalog.json' };
const GITHUB_REGISTRY = {
  id: 'github',
  source: 'https://raw.githubusercontent.com/org/marketplace/main/catalog.json'
};

describe('assertAllowedMarketplaceTarget', () => {
  test('admits the registry host without the public check, even on a private address', async () => {
    const registry = { id: 'corp', source: 'https://10.1.2.3/marketplace/catalog.json' };

    await expect(
      assertAllowedMarketplaceTarget('https://10.1.2.3/marketplace/skills/x/SKILL.md', registry)
    ).resolves.toMatchObject({ admittedAs: 'registry', addresses: null });
    // The scheme does not matter for the host, the port does.
    await expect(
      assertAllowedMarketplaceTarget('http://10.1.2.3/marketplace/x.json', registry)
    ).resolves.toMatchObject({ admittedAs: 'registry' });
    expect(checkedHosts).toEqual([]);

    await expect(
      assertAllowedMarketplaceTarget('https://10.1.2.3:6379/', registry)
    ).rejects.toMatchObject({ code: MARKETPLACE_TARGET_BLOCKED, host: '10.1.2.3:6379' });
  });

  test('admits the GitHub pair for a GitHub registry, and only for one', async () => {
    expect([...registryOwnHosts(GITHUB_REGISTRY)].sort()).toEqual([
      'api.github.com',
      'raw.githubusercontent.com'
    ]);
    for (const url of [
      'https://api.github.com/repos/org/marketplace/contents/apps/x.json?ref=main',
      'https://raw.githubusercontent.com/org/marketplace/main/skills/x/SKILL.md'
    ]) {
      await expect(assertAllowedMarketplaceTarget(url, GITHUB_REGISTRY)).resolves.toMatchObject({
        admittedAs: 'registry'
      });
    }
    // A registry configured with a github.com/blob URL is a GitHub registry too.
    const blob = { source: 'https://github.com/org/marketplace/blob/main/catalog.json' };
    await expect(
      assertAllowedMarketplaceTarget('https://api.github.com/repos/org/m/git/trees/main', blob)
    ).resolves.toMatchObject({ admittedAs: 'registry' });
    expect(checkedHosts).toEqual([]);

    // Any other registry reaches GitHub only as the public host it is.
    await expect(
      assertAllowedMarketplaceTarget('https://api.github.com/repos/o/r/contents/x', PUBLIC_REGISTRY)
    ).resolves.toMatchObject({ admittedAs: 'public', addresses: ['140.82.112.6'] });
    expect(checkedHosts).toEqual(['api.github.com']);
  });

  test('lets a third-party host through when it is public, with the addresses to pin', async () => {
    await expect(
      assertAllowedMarketplaceTarget('https://cdn.example.org/skills/x/SKILL.md', PUBLIC_REGISTRY)
    ).resolves.toMatchObject({ admittedAs: 'public', addresses: ['93.184.216.35'] });
  });

  test('refuses a private address a public registry names, and says which host', async () => {
    for (const [url, host] of [
      ['http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
      ['http://127.0.0.1:8080/admin', '127.0.0.1:8080'],
      ['http://[::1]/', '[::1]'],
      ['https://intranet.example.com/hr.json', 'intranet.example.com']
    ]) {
      const refusal = assertAllowedMarketplaceTarget(url, PUBLIC_REGISTRY);
      await expect(refusal).rejects.toMatchObject({ code: MARKETPLACE_TARGET_BLOCKED, host });
      await expect(refusal).rejects.toThrow(`'${host}' refused`);
    }
  });

  test('admits nothing for a registry without a usable source', async () => {
    expect(registryOwnHosts(undefined).size).toBe(0);
    expect(registryOwnHosts({ source: 'not a url' }).size).toBe(0);
    await expect(
      assertAllowedMarketplaceTarget('http://10.0.0.1/x', { source: 'ftp://10.0.0.1/' })
    ).rejects.toMatchObject({ code: MARKETPLACE_TARGET_BLOCKED });
  });

  test('refuses anything but http and https', async () => {
    await expect(
      assertAllowedMarketplaceTarget('file:///etc/passwd', PUBLIC_REGISTRY)
    ).rejects.toMatchObject({ code: MARKETPLACE_TARGET_BLOCKED });
    expect(checkedHosts).toEqual([]);
  });
});

/**
 * A loopback HTTP server answering from `routes` (path → handler) and keeping
 * every request it got.
 */
async function startServer(routes) {
  const requests = [];
  // A Map, so a request path can never reach an inherited property.
  const handlers = new Map(Object.entries(routes));
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const handler = handlers.get(req.url);
    if (typeof handler !== 'function') {
      res.writeHead(404).end('missing');
      return;
    }
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      })
  };
}

const redirectTo = location => (_req, res) => res.writeHead(302, { Location: location }).end();

describe('marketplaceFetch', () => {
  let registryHost;
  let otherHost;
  let privateRegistry;
  const credentials = { Authorization: 'Bearer registry-token' };

  beforeAll(async () => {
    otherHost = await startServer({
      '/secret': (_req, res) => res.end('internal'),
      '/public.md': (_req, res) => res.end('# public')
    });
    registryHost = await startServer({
      '/catalog.json': (_req, res) =>
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"items":[]}'),
      '/moved': redirectTo('/catalog.json'),
      '/to-internal': redirectTo(`${otherHost.origin}/secret`),
      '/to-public': redirectTo(`${otherHost.origin}/public.md`),
      '/to-file': redirectTo('file:///etc/passwd'),
      '/loop': redirectTo('/loop')
    });
    // A private registry: its catalog is on a loopback address.
    privateRegistry = { id: 'corp', source: `${registryHost.origin}/catalog.json` };
  });

  afterAll(async () => {
    await registryHost.close();
    await otherHost.close();
  });

  beforeEach(() => {
    registryHost.requests.length = 0;
    otherHost.requests.length = 0;
  });

  test('fetches from the private registry host itself, with its credentials', async () => {
    const response = await marketplaceFetch(
      'marketplace-registry',
      `${registryHost.origin}/catalog.json`,
      {
        registry: privateRegistry,
        headers: { Accept: 'application/json' },
        authHeaders: credentials
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(registryHost.requests[0].headers.authorization).toBe('Bearer registry-token');
    expect(registryHost.requests[0].headers.accept).toBe('application/json');
    expect(checkedHosts).toEqual([]);
  });

  test('refuses a private address a public registry names, without connecting to it', async () => {
    await expect(
      marketplaceFetch('marketplace-installer', `${otherHost.origin}/secret`, {
        registry: PUBLIC_REGISTRY
      })
    ).rejects.toMatchObject({ code: MARKETPLACE_TARGET_BLOCKED, host: otherHost.host });
    expect(otherHost.requests).toEqual([]);
  });

  test('fetches from a public third-party host', async () => {
    treatedAsPublic.add(otherHost.host);

    const response = await marketplaceFetch(
      'marketplace-installer',
      `${otherHost.origin}/public.md`,
      {
        registry: privateRegistry
      }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# public');
    expect(checkedHosts).toEqual([otherHost.host]);
  });

  test('refuses a redirect from the registry host to a private address', async () => {
    await expect(
      marketplaceFetch('marketplace-installer', `${registryHost.origin}/to-internal`, {
        registry: privateRegistry,
        authHeaders: credentials
      })
    ).rejects.toMatchObject({
      code: MARKETPLACE_TARGET_BLOCKED,
      host: otherHost.host,
      message: expect.stringContaining(`reached through a redirect from '${registryHost.host}'`)
    });
    // The hop itself was answered; the internal address never saw a request,
    // so the HTTP client did not follow the redirect on its own.
    expect(registryHost.requests.map(r => r.url)).toEqual(['/to-internal']);
    expect(otherHost.requests).toEqual([]);
  });

  test('follows a redirect to a public host, without the registry credentials', async () => {
    treatedAsPublic.add(otherHost.host);

    const response = await marketplaceFetch(
      'marketplace-installer',
      `${registryHost.origin}/to-public`,
      { registry: privateRegistry, headers: { Accept: 'text/plain' }, authHeaders: credentials }
    );

    expect(await response.text()).toBe('# public');
    expect(registryHost.requests[0].headers.authorization).toBe('Bearer registry-token');
    expect(otherHost.requests).toHaveLength(1);
    expect(otherHost.requests[0].headers.authorization).toBeUndefined();
    expect(otherHost.requests[0].headers.accept).toBe('text/plain');
  });

  test('follows a redirect on the registry host and keeps the credentials', async () => {
    const response = await marketplaceFetch(
      'marketplace-registry',
      `${registryHost.origin}/moved`,
      {
        registry: privateRegistry,
        authHeaders: credentials
      }
    );

    expect(response.status).toBe(200);
    expect(registryHost.requests.map(r => [r.url, r.headers.authorization])).toEqual([
      ['/moved', 'Bearer registry-token'],
      ['/catalog.json', 'Bearer registry-token']
    ]);
  });

  test('refuses a redirect to anything but http and https', async () => {
    await expect(
      marketplaceFetch('marketplace-installer', `${registryHost.origin}/to-file`, {
        registry: privateRegistry
      })
    ).rejects.toMatchObject({ code: MARKETPLACE_TARGET_BLOCKED });
  });

  test(`stops after ${MAX_MARKETPLACE_REDIRECTS} redirects`, async () => {
    await expect(
      marketplaceFetch('marketplace-installer', `${registryHost.origin}/loop`, {
        registry: privateRegistry
      })
    ).rejects.toThrow(`stopped after ${MAX_MARKETPLACE_REDIRECTS} redirects`);
    expect(registryHost.requests).toHaveLength(MAX_MARKETPLACE_REDIRECTS + 1);
  });
});
