// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration items of a marketplace catalog, screened when the catalog is
 * loaded (RegistryService.fetchCatalog):
 *
 *   - an item whose definition runs a local MCP process (`stdio`, or no
 *     fixed transport) is left out of the catalog, with a logged reason
 *     that names the registry and the item;
 *   - every other integration item carries `facts` derived from its
 *     definition (sign-in modes, effect, where it runs, action count and
 *     the actions); the browse list leaves the actions out, the detail has
 *     them;
 *   - a `script` item is not affected; a definition that cannot be fetched
 *     keeps its item with `facts: null`; a `facts` field the registry
 *     writes itself is dropped.
 *
 * The repo's source is native ESM, so mocks use `jest.unstable_mockModule` +
 * dynamic imports. Run with `NODE_OPTIONS=--experimental-vm-modules` (the
 * `test:marketplace` npm script does).
 */

import { jest } from '@jest/globals';
import os from 'os';

// TokenStorageService (imported by RegistryService) reads getRootDir() at
// module load, so it must point at a real directory before the imports below.
jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => os.tmpdir()
}));

// The catalog and the definitions are fetched over HTTP.
const throttledFetch = jest.fn();
jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch,
  throttledRun: (_id, fn) => fn()
}));

const { default: registryService } = await import('../services/marketplace/RegistryService.js');
const { default: logger } = await import('../utils/logger.js');
const { definitionFacts, registryProtocolRefusal, REGISTRY_STDIO_REFUSAL } =
  await import('../services/integrations/definitions/registryItems.js');

const BASE = 'https://registry.example';

const REGISTRY = {
  id: 'acme',
  name: 'ACME Registry',
  source: `${BASE}/catalog.json`,
  auth: { type: 'none' },
  enabled: true,
  trustCode: true
};

/** The definitions the registry serves, by path. */
const DEFINITIONS = {
  'integrations/open-data/integration.json': {
    id: 'org.example/open-data',
    name: { en: 'Open Data' },
    runs: 'cloud',
    protocol: { type: 'openapi', document: 'openapi.json' },
    auth: { modes: ['none', 'service-account'] },
    actions: [
      { name: 'search', title: { en: 'Search datasets' }, sideEffect: 'read' },
      { name: 'publish', title: { en: 'Publish a dataset' }, sideEffect: 'write' }
    ]
  },
  'integrations/local-files/integration.json': {
    id: 'org.example/local-files',
    name: { en: 'Local files' },
    protocol: { type: 'mcp', transport: { type: 'stdio', command: 'npx' } },
    auth: { modes: ['none'] }
  },
  'integrations/custom-crm/integration.json': {
    id: 'org.example/custom-crm',
    name: { en: 'Custom CRM' },
    runs: 'on-prem',
    protocol: { type: 'script', module: 'connector.js' },
    auth: { modes: ['oauth-user'] },
    actions: [{ name: 'findContact', sideEffect: 'read' }]
  }
};

/**
 * A catalog item of type integration served under `integrations/<name>/`.
 *
 * @param {string} name
 * @param {object} [extra]
 * @returns {object}
 */
function integrationItem(name, extra = {}) {
  return {
    type: 'integration',
    name,
    displayName: { en: name },
    version: '1.0.0',
    source: { type: 'relative', path: `integrations/${name}/integration.json` },
    ...extra
  };
}

const CATALOG = {
  name: 'ACME',
  items: [
    integrationItem('open-data', { facts: { actionCount: 99 } }),
    integrationItem('local-files'),
    integrationItem('custom-crm', {
      source: {
        type: 'relative',
        path: 'integrations/custom-crm/integration.json',
        integrity: { 'connector.js': 'sha256-abc' }
      }
    }),
    integrationItem('gone'),
    {
      type: 'prompt',
      name: 'summarize',
      version: '1.0.0',
      source: { type: 'relative', path: 'prompts/summarize.json' }
    }
  ]
};

/**
 * A fetch response with a JSON or 404 body.
 *
 * @param {number} status
 * @param {unknown} [body]
 */
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: { get: () => null },
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  };
}

/** Serve the catalog and the definitions; anything else is a 404. */
function serveRegistry() {
  throttledFetch.mockImplementation(async (_id, url) => {
    if (url === `${BASE}/catalog.json`) return response(200, CATALOG);
    const path = url.slice(`${BASE}/`.length);
    if (DEFINITIONS[path]) return response(200, DEFINITIONS[path]);
    return response(404);
  });
}

/** ConfigCache double with the registry and nothing installed. */
const configCache = {
  getInstallations: () => ({ data: { installations: {} } }),
  getRegistries: () => ({ data: { registries: [REGISTRY] } }),
  getApps: () => ({ data: [] }),
  getModels: () => ({ data: [] }),
  getPrompts: () => ({ data: [] }),
  getWorkflows: () => ({ data: [] }),
  getSkills: () => ({ data: [] }),
  getIntegrations: () => ({ data: [] }),
  get: () => ({ data: null })
};

beforeEach(() => {
  throttledFetch.mockReset();
  serveRegistry();
  jest.spyOn(registryService, '_getConfigCache').mockResolvedValue(configCache);
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('catalog load screens integration items', () => {
  test('a stdio integration is left out of the catalog with a logged reason', async () => {
    const catalog = await registryService.fetchCatalog(REGISTRY);

    const names = catalog.items.map(i => i.name);
    expect(names).toEqual(['open-data', 'custom-crm', 'gone', 'summarize']);
    expect(logger.warn).toHaveBeenCalledWith(
      `Catalog item 'integration:local-files' of registry 'acme' rejected: ${REGISTRY_STDIO_REFUSAL}`,
      expect.objectContaining({
        registryId: 'acme',
        itemType: 'integration',
        itemName: 'local-files',
        reason: REGISTRY_STDIO_REFUSAL
      })
    );
  });

  test('pages the marketplace list by cursor and ends with a null nextCursor', async () => {
    const catalog = await registryService.fetchCatalog(REGISTRY);
    jest
      .spyOn(registryService, 'getCachedCatalogAsync')
      .mockResolvedValue({ registryId: 'acme', catalog });

    const first = await registryService.getAllItems({ type: 'integration', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.page).toBeUndefined();
    const second = await registryService.getAllItems({
      type: 'integration',
      limit: 2,
      cursor: first.nextCursor
    });
    expect(second.items.map(i => i.name)).toEqual(['gone']);
    expect(second.nextCursor).toBeNull();
  });

  test('only the good integration is listed in the marketplace', async () => {
    const catalog = await registryService.fetchCatalog(REGISTRY);
    jest
      .spyOn(registryService, 'getCachedCatalogAsync')
      .mockResolvedValue({ registryId: 'acme', catalog });

    const { items } = await registryService.getAllItems({ type: 'integration' });

    expect(items.map(i => i.name)).toEqual(['open-data', 'custom-crm', 'gone']);
    const openData = items.find(i => i.name === 'open-data');
    // The browse list carries the four facts but not the action list
    expect(openData.facts).toEqual({
      protocol: 'openapi',
      authModes: ['none', 'service-account'],
      effect: 'read-write',
      runs: 'cloud',
      actionCount: 2
    });
  });

  test('a script integration under trust for code is not affected', async () => {
    const catalog = await registryService.fetchCatalog(REGISTRY);

    const crm = catalog.items.find(i => i.name === 'custom-crm');
    expect(crm.source.integrity).toEqual({ 'connector.js': 'sha256-abc' });
    expect(crm.facts).toMatchObject({
      protocol: 'script',
      authModes: ['oauth-user'],
      effect: 'read',
      runs: 'on-prem',
      actionCount: 1
    });
  });

  test('a definition that cannot be fetched keeps its item without facts', async () => {
    const catalog = await registryService.fetchCatalog(REGISTRY);

    expect(catalog.items.find(i => i.name === 'gone').facts).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not fetch the definition of a catalog integration; its facts are not shown',
      expect.objectContaining({ registryId: 'acme', itemName: 'gone' })
    );
  });

  test('the facts a registry writes itself are replaced by the derived ones', async () => {
    const catalog = await registryService.fetchCatalog(REGISTRY);

    expect(catalog.items.find(i => i.name === 'open-data').facts.actionCount).toBe(2);
    expect(catalog.items.find(i => i.name === 'summarize')).not.toHaveProperty('facts');
  });

  test('the item detail carries the actions with their effect', async () => {
    const catalog = await registryService.fetchCatalog(REGISTRY);
    jest
      .spyOn(registryService, 'getCachedCatalogAsync')
      .mockResolvedValue({ registryId: 'acme', catalog });

    const detail = await registryService.getItemDetail('acme', 'integration', 'open-data');

    expect(detail.facts.actions).toEqual([
      { name: 'search', title: { en: 'Search datasets' }, sideEffect: 'read' },
      { name: 'publish', title: { en: 'Publish a dataset' }, sideEffect: 'write' }
    ]);
  });

  test('the item detail of a catalog cached without facts derives them from the preview', async () => {
    const cachedItem = integrationItem('open-data');
    jest
      .spyOn(registryService, 'getCachedCatalogAsync')
      .mockResolvedValue({ registryId: 'acme', catalog: { items: [cachedItem] } });

    const detail = await registryService.getItemDetail('acme', 'integration', 'open-data');

    expect(detail.facts).toMatchObject({ effect: 'read-write', actionCount: 2 });
  });

  test('the item detail derives facts the refresh could not read (cached as null)', async () => {
    const cachedItem = integrationItem('open-data', { facts: null });
    jest
      .spyOn(registryService, 'getCachedCatalogAsync')
      .mockResolvedValue({ registryId: 'acme', catalog: { items: [cachedItem] } });

    const detail = await registryService.getItemDetail('acme', 'integration', 'open-data');

    expect(detail.facts).toMatchObject({ effect: 'read-write', actionCount: 2 });
  });
});

describe('registryProtocolRefusal', () => {
  test.each([
    ['stdio transport', { type: 'mcp', transport: { type: 'stdio' } }, REGISTRY_STDIO_REFUSAL],
    ['no fixed transport', { type: 'mcp' }, REGISTRY_STDIO_REFUSAL],
    ['remote transport', { type: 'mcp', transport: { type: 'streamableHttp' } }, null],
    ['openapi', { type: 'openapi', document: 'openapi.json' }, null],
    ['script', { type: 'script', module: 'connector.js' }, null]
  ])('%s', (_label, protocol, expected) => {
    expect(registryProtocolRefusal({ protocol })).toBe(expected);
  });
});

describe('definitionFacts', () => {
  test('an MCP server lists its own actions: no count, effect unknown', () => {
    expect(
      definitionFacts({
        protocol: { type: 'mcp', transport: { type: 'streamableHttp' } },
        runs: 'cloud',
        auth: { modes: ['service-account'] }
      })
    ).toEqual({
      protocol: 'mcp',
      authModes: ['service-account'],
      effect: 'unknown',
      runs: 'cloud',
      actionCount: null,
      actions: []
    });
  });

  test('only reading actions are read; an undeclared effect is unknown', () => {
    const read = definitionFacts({
      protocol: { type: 'native' },
      actions: [{ name: 'a', sideEffect: 'read' }]
    });
    const mixed = definitionFacts({
      protocol: { type: 'native' },
      actions: [{ name: 'a', sideEffect: 'read' }, { name: 'b' }]
    });
    const destructive = definitionFacts({
      protocol: { type: 'native' },
      actions: [{ name: 'a', sideEffect: 'destructive' }, { name: 'b' }]
    });

    expect(read.effect).toBe('read');
    expect(mixed.effect).toBe('unknown');
    expect(destructive.effect).toBe('read-write');
  });

  test('malformed fields are left out', () => {
    expect(
      definitionFacts({
        protocol: 'mcp',
        runs: 'moon',
        auth: { modes: 'none' },
        actions: [null, { title: 'no name' }, { name: 'x', sideEffect: 'explode' }]
      })
    ).toEqual({
      protocol: null,
      authModes: [],
      effect: 'unknown',
      runs: null,
      actionCount: 1,
      actions: [{ name: 'x', title: null, sideEffect: 'unknown' }]
    });
  });
});
