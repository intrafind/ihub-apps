/**
 * Tests for configCache.updatePlatformSection: the shared, serialized
 * read-modify-write helper that replaced the per-route savePlatformConfig
 * clones and ad-hoc disk-read blocks across the admin routes.
 */
import { jest } from '@jest/globals';
import { promises as fsp } from 'fs';
import configCache from '../configCache.js';

describe('configCache.updatePlatformSection', () => {
  let diskState;

  beforeEach(() => {
    diskState = JSON.stringify({ cors: { origin: ['https://a.example'] } });
    jest.spyOn(fsp, 'readFile').mockImplementation(async () => diskState);
    jest.spyOn(fsp, 'writeFile').mockImplementation(async (_filePath, data) => {
      diskState = data;
    });
    jest.spyOn(fsp, 'rename').mockResolvedValue(undefined);
    jest.spyOn(configCache, 'refreshCacheEntry').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('serializes concurrent updates to different sections without clobbering', async () => {
    const [corsResult, sslResult] = await Promise.all([
      configCache.updatePlatformSection(cfg => {
        cfg.cors = { origin: ['https://new.example'] };
        return cfg;
      }),
      configCache.updatePlatformSection(cfg => {
        cfg.ssl = { ignoreInvalidCertificates: true };
        return cfg;
      })
    ]);

    const finalOnDisk = JSON.parse(diskState);
    expect(finalOnDisk.cors).toEqual({ origin: ['https://new.example'] });
    expect(finalOnDisk.ssl).toEqual({ ignoreInvalidCertificates: true });
    // Both callers see the config as it stood right after their own write,
    // which — because writes are serialized — always includes every prior
    // section update rather than a stale, pre-race snapshot.
    expect(corsResult.cors).toEqual({ origin: ['https://new.example'] });
    expect(sslResult.cors).toEqual({ origin: ['https://new.example'] });
    expect(sslResult.ssl).toEqual({ ignoreInvalidCertificates: true });
    expect(configCache.refreshCacheEntry).toHaveBeenCalledTimes(2);
  });

  test('defaults to {} when platform.json is missing', async () => {
    fsp.readFile.mockImplementation(async () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    });

    const result = await configCache.updatePlatformSection(cfg => {
      cfg.features = { usageTrackingMode: 'anonymous' };
      return cfg;
    });

    expect(result).toEqual({ features: { usageTrackingMode: 'anonymous' } });
  });

  test('propagates non-ENOENT read errors instead of silently starting fresh', async () => {
    fsp.readFile.mockImplementation(async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    await expect(configCache.updatePlatformSection(cfg => cfg)).rejects.toThrow(
      'permission denied'
    );
  });

  test('a rejected update does not stall later queued updates', async () => {
    fsp.readFile.mockImplementationOnce(async () => {
      throw Object.assign(new Error('boom'), { code: 'EACCES' });
    });

    await expect(configCache.updatePlatformSection(cfg => cfg)).rejects.toThrow('boom');

    const result = await configCache.updatePlatformSection(cfg => {
      cfg.ssrf = { allowedHosts: ['example.com'] };
      return cfg;
    });

    expect(result.ssrf).toEqual({ allowedHosts: ['example.com'] });
  });

  test('supports mutators that mutate in place without returning a value', async () => {
    const result = await configCache.updatePlatformSection(cfg => {
      cfg.audit = { anonymizeIp: 'mask' };
      // no return — the helper should fall back to the mutated input
    });

    expect(result.audit).toEqual({ anonymizeIp: 'mask' });
    expect(result.cors).toEqual({ origin: ['https://a.example'] });
  });
});
