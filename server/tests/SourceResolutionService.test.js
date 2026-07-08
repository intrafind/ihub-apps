import { jest } from '@jest/globals';

/**
 * Unit tests for SourceResolutionService. configCache is mocked so tests
 * control which admin sources are "configured" without touching disk.
 *
 * The service is instantiated fresh per test (mirroring how PromptService
 * and PromptNodeExecutor use it in production — see #1820), so these tests
 * also guard against resolveAppSources depending on any cross-instance
 * cache state.
 */

const store = { sources: [] };

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getSources: () => ({ data: store.sources })
  }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {}
  }
}));

const { default: SourceResolutionService } = await import('../services/SourceResolutionService.js');

function setSources(sources) {
  store.sources = sources;
}

beforeEach(() => {
  setSources([]);
});

describe('SourceResolutionService.resolveAppSources', () => {
  it('returns an empty array when the app has no sources', async () => {
    const service = new SourceResolutionService();

    await expect(service.resolveAppSources({ id: 'app-1', sources: [] })).resolves.toEqual([]);
  });

  it('resolves a string source reference against admin sources', async () => {
    setSources([
      {
        id: 'faq',
        name: { en: 'FAQ' },
        description: { en: 'Frequently asked questions' },
        type: 'filesystem',
        enabled: true,
        exposeAs: 'prompt',
        config: { path: 'sources/faq.md' }
      }
    ]);
    const service = new SourceResolutionService();

    const resolved = await service.resolveAppSources({ id: 'app-1', sources: ['faq'] });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ id: 'faq', type: 'filesystem', exposeAs: 'prompt' });
  });

  it('skips disabled or unknown source references without throwing', async () => {
    setSources([{ id: 'disabled-source', enabled: false, config: {} }]);
    const service = new SourceResolutionService();

    const resolved = await service.resolveAppSources({
      id: 'app-1',
      sources: ['disabled-source', 'does-not-exist']
    });

    expect(resolved).toEqual([]);
  });

  it('does not reuse resolutions across separate instances (no dead cache)', async () => {
    setSources([{ id: 'faq', enabled: true, config: {} }]);
    const first = await new SourceResolutionService().resolveAppSources({
      id: 'app-1',
      sources: ['faq']
    });
    expect(first).toHaveLength(1);

    // Even if the admin source disappears between requests, a fresh instance
    // must reflect current config rather than any stale cached resolution.
    setSources([]);
    const second = await new SourceResolutionService().resolveAppSources({
      id: 'app-1',
      sources: ['faq']
    });
    expect(second).toEqual([]);
  });
});
