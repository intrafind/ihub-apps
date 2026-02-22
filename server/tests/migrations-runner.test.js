/**
 * Configuration Migration Runner Test Suite
 *
 * Tests for the migration runner, utils, and migration files.
 */

import { jest } from '@jest/globals';
import {
  setDefault,
  removeKey,
  renameKey,
  mergeDefaults,
  addIfMissing,
  removeById,
  transformWhere
} from '../migrations/utils.js';
import { scanMigrationFiles, loadHistory, computeChecksum } from '../migrations/runner.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// ──────────────────────────────────────────────────────────────────────
// Utils Tests
// ──────────────────────────────────────────────────────────────────────

describe('Migration Utils', () => {
  describe('setDefault', () => {
    it('should set a missing top-level key', () => {
      const obj = { a: 1 };
      const result = setDefault(obj, 'b', 2);
      expect(result).toBe(true);
      expect(obj.b).toBe(2);
    });

    it('should not overwrite an existing key', () => {
      const obj = { a: 1 };
      const result = setDefault(obj, 'a', 99);
      expect(result).toBe(false);
      expect(obj.a).toBe(1);
    });

    it('should set a nested key creating intermediate objects', () => {
      const obj = {};
      const result = setDefault(obj, 'a.b.c', 'deep');
      expect(result).toBe(true);
      expect(obj.a.b.c).toBe('deep');
    });

    it('should not overwrite a nested existing key', () => {
      const obj = { a: { b: { c: 'original' } } };
      const result = setDefault(obj, 'a.b.c', 'new');
      expect(result).toBe(false);
      expect(obj.a.b.c).toBe('original');
    });

    it('should handle setting a value when intermediate path is non-object', () => {
      const obj = { a: 'string' };
      // a is a string, so a.b can't be traversed — setDefault should create intermediate
      const result = setDefault(obj, 'a.b', 'value');
      expect(result).toBe(true);
      expect(obj.a.b).toBe('value');
    });

    it('should preserve existing falsy values', () => {
      const obj = { a: false, b: 0, c: '', d: null };
      expect(setDefault(obj, 'a', true)).toBe(false);
      expect(setDefault(obj, 'b', 1)).toBe(false);
      expect(setDefault(obj, 'c', 'hello')).toBe(false);
      // null is a valid value that hasOwnProperty returns true for
      expect(setDefault(obj, 'd', 'not-null')).toBe(false);
    });
  });

  describe('removeKey', () => {
    it('should remove an existing top-level key', () => {
      const obj = { a: 1, b: 2 };
      const result = removeKey(obj, 'a');
      expect(result).toBe(true);
      expect(obj).toEqual({ b: 2 });
    });

    it('should return false for a missing key', () => {
      const obj = { a: 1 };
      const result = removeKey(obj, 'b');
      expect(result).toBe(false);
      expect(obj).toEqual({ a: 1 });
    });

    it('should remove a nested key', () => {
      const obj = { a: { b: { c: 1, d: 2 } } };
      const result = removeKey(obj, 'a.b.c');
      expect(result).toBe(true);
      expect(obj.a.b).toEqual({ d: 2 });
    });

    it('should return false when intermediate path does not exist', () => {
      const obj = { a: 1 };
      const result = removeKey(obj, 'a.b.c');
      expect(result).toBe(false);
    });
  });

  describe('renameKey', () => {
    it('should rename a top-level key', () => {
      const obj = { oldKey: 'value', other: 1 };
      const result = renameKey(obj, 'oldKey', 'newKey');
      expect(result).toBe(true);
      expect(obj).toEqual({ newKey: 'value', other: 1 });
    });

    it('should return false if the old key does not exist', () => {
      const obj = { a: 1 };
      const result = renameKey(obj, 'missing', 'newKey');
      expect(result).toBe(false);
    });

    it('should rename nested keys', () => {
      const obj = { config: { legacy: { old: 'data' } } };
      const result = renameKey(obj, 'config.legacy.old', 'config.modern.new');
      expect(result).toBe(true);
      expect(obj.config.modern.new).toBe('data');
      expect(obj.config.legacy.old).toBeUndefined();
    });

    it('should preserve the value type during rename', () => {
      const nested = { x: [1, 2, 3] };
      const obj = { source: nested };
      renameKey(obj, 'source', 'target');
      expect(obj.target).toBe(nested); // Same reference
      expect(obj.source).toBeUndefined();
    });
  });

  describe('mergeDefaults', () => {
    it('should add missing keys from defaults', () => {
      const existing = { a: 1 };
      const defaults = { a: 99, b: 2, c: 3 };
      const result = mergeDefaults(existing, defaults);
      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('should deep merge nested objects', () => {
      const existing = { config: { port: 3000 } };
      const defaults = { config: { port: 8080, host: 'localhost' }, debug: false };
      const result = mergeDefaults(existing, defaults);
      expect(result).toEqual({ config: { port: 3000, host: 'localhost' }, debug: false });
    });

    it('should not overwrite arrays', () => {
      const existing = { items: [1, 2] };
      const defaults = { items: [3, 4, 5] };
      const result = mergeDefaults(existing, defaults);
      expect(result.items).toEqual([1, 2]);
    });

    it('should handle empty existing object', () => {
      const existing = {};
      const defaults = { a: 1, b: { c: 2 } };
      const result = mergeDefaults(existing, defaults);
      expect(result).toEqual({ a: 1, b: { c: 2 } });
    });

    it('should return the existing object (mutated)', () => {
      const existing = { a: 1 };
      const result = mergeDefaults(existing, { b: 2 });
      expect(result).toBe(existing);
    });
  });

  describe('addIfMissing', () => {
    it('should add a new item to the array', () => {
      const array = [{ id: 'a' }, { id: 'b' }];
      const result = addIfMissing(array, { id: 'c', name: 'C' });
      expect(result).toBe(true);
      expect(array).toHaveLength(3);
      expect(array[2]).toEqual({ id: 'c', name: 'C' });
    });

    it('should not add a duplicate item', () => {
      const array = [{ id: 'a' }, { id: 'b' }];
      const result = addIfMissing(array, { id: 'a', name: 'New A' });
      expect(result).toBe(false);
      expect(array).toHaveLength(2);
    });

    it('should use a custom id field', () => {
      const array = [{ name: 'Alice' }, { name: 'Bob' }];
      const result = addIfMissing(array, { name: 'Charlie' }, 'name');
      expect(result).toBe(true);
      expect(array).toHaveLength(3);
    });
  });

  describe('removeById', () => {
    it('should remove a matching item', () => {
      const array = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      const result = removeById(array, 'b');
      expect(result).toBe(true);
      expect(array).toEqual([{ id: 'a' }, { id: 'c' }]);
    });

    it('should return false if no match', () => {
      const array = [{ id: 'a' }];
      const result = removeById(array, 'z');
      expect(result).toBe(false);
      expect(array).toHaveLength(1);
    });

    it('should use a custom id field', () => {
      const array = [{ name: 'x' }, { name: 'y' }];
      const result = removeById(array, 'x', 'name');
      expect(result).toBe(true);
      expect(array).toEqual([{ name: 'y' }]);
    });
  });

  describe('transformWhere', () => {
    it('should transform matching items', () => {
      const array = [
        { id: 1, active: true },
        { id: 2, active: false },
        { id: 3, active: true }
      ];
      const count = transformWhere(
        array,
        item => item.active,
        item => {
          item.transformed = true;
        }
      );
      expect(count).toBe(2);
      expect(array[0].transformed).toBe(true);
      expect(array[1].transformed).toBeUndefined();
      expect(array[2].transformed).toBe(true);
    });

    it('should return 0 when no items match', () => {
      const array = [{ x: 1 }, { x: 2 }];
      const count = transformWhere(
        array,
        item => item.x > 10,
        item => {
          item.x = 0;
        }
      );
      expect(count).toBe(0);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Runner Tests
// ──────────────────────────────────────────────────────────────────────

describe('Migration Runner', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('scanMigrationFiles', () => {
    it('should find and sort V*.js migration files', async () => {
      // Create mock migration files
      await fs.writeFile(path.join(tmpDir, 'V002__second.js'), 'export const version = "002";');
      await fs.writeFile(path.join(tmpDir, 'V001__first.js'), 'export const version = "001";');
      await fs.writeFile(path.join(tmpDir, 'V003__third.js'), 'export const version = "003";');
      await fs.writeFile(path.join(tmpDir, 'runner.js'), 'not a migration');
      await fs.writeFile(path.join(tmpDir, 'utils.js'), 'not a migration');

      const files = await scanMigrationFiles(tmpDir);
      expect(files).toHaveLength(3);
      expect(files[0].version).toBe('001');
      expect(files[1].version).toBe('002');
      expect(files[2].version).toBe('003');
      expect(files[0].description).toBe('first');
      expect(files[0].file).toBe('V001__first.js');
    });

    it('should return empty array for non-existent directory', async () => {
      const files = await scanMigrationFiles(path.join(tmpDir, 'nonexistent'));
      expect(files).toEqual([]);
    });

    it('should skip files that do not match the pattern', async () => {
      await fs.writeFile(path.join(tmpDir, 'V001__valid.js'), 'ok');
      await fs.writeFile(path.join(tmpDir, 'v001__lowercase.js'), 'bad');
      await fs.writeFile(path.join(tmpDir, 'V1__short.js'), 'bad');
      await fs.writeFile(path.join(tmpDir, 'README.md'), 'docs');

      const files = await scanMigrationFiles(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0].version).toBe('001');
    });
  });

  describe('loadHistory', () => {
    it('should return empty history when file does not exist', async () => {
      const history = await loadHistory(tmpDir);
      expect(history).toEqual({ schemaVersion: '1.0', migrations: [] });
    });

    it('should load and parse existing history', async () => {
      const mockHistory = {
        schemaVersion: '1.0',
        migrations: [
          {
            version: '001',
            description: 'baseline',
            file: 'V001__baseline.js',
            checksum: 'abc123',
            appliedAt: '2026-02-20T00:00:00.000Z',
            executionTimeMs: 5,
            status: 'success'
          }
        ]
      };
      await fs.writeFile(path.join(tmpDir, '.migration-history.json'), JSON.stringify(mockHistory));

      const history = await loadHistory(tmpDir);
      expect(history.schemaVersion).toBe('1.0');
      expect(history.migrations).toHaveLength(1);
      expect(history.migrations[0].version).toBe('001');
    });
  });

  describe('computeChecksum', () => {
    it('should return a consistent SHA-256 hash', async () => {
      const filePath = path.join(tmpDir, 'test.js');
      await fs.writeFile(filePath, 'export const version = "001";');

      const hash1 = await computeChecksum(filePath);
      const hash2 = await computeChecksum(filePath);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce different hashes for different content', async () => {
      const file1 = path.join(tmpDir, 'a.js');
      const file2 = path.join(tmpDir, 'b.js');
      await fs.writeFile(file1, 'content A');
      await fs.writeFile(file2, 'content B');

      const hash1 = await computeChecksum(file1);
      const hash2 = await computeChecksum(file2);
      expect(hash1).not.toBe(hash2);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Migration File Tests
// ──────────────────────────────────────────────────────────────────────

describe('Migration Files', () => {
  describe('V001__baseline', () => {
    it('should export the correct version and description', async () => {
      const mod = await import('../migrations/V001__baseline.js');
      expect(mod.version).toBe('001');
      expect(mod.description).toBe('baseline');
      expect(typeof mod.up).toBe('function');
    });

    it('should be a no-op that calls ctx.log', async () => {
      const mod = await import('../migrations/V001__baseline.js');
      const ctx = { log: jest.fn() };
      await mod.up(ctx);
      expect(ctx.log).toHaveBeenCalledTimes(1);
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Baseline'));
    });
  });

  describe('V002__ensure_default_providers', () => {
    it('should export the correct version and description', async () => {
      const mod = await import('../migrations/V002__ensure_default_providers.js');
      expect(mod.version).toBe('002');
      expect(mod.description).toBe('Ensure default providers are present');
      expect(typeof mod.up).toBe('function');
      expect(typeof mod.precondition).toBe('function');
    });

    it('should skip if providers.json does not exist', async () => {
      const mod = await import('../migrations/V002__ensure_default_providers.js');
      const ctx = { fileExists: jest.fn().mockResolvedValue(false) };
      const result = await mod.precondition(ctx);
      expect(result).toBe(false);
    });

    it('should proceed if providers.json exists', async () => {
      const mod = await import('../migrations/V002__ensure_default_providers.js');
      const ctx = { fileExists: jest.fn().mockResolvedValue(true) };
      const result = await mod.precondition(ctx);
      expect(result).toBe(true);
    });

    it('should add missing providers', async () => {
      const mod = await import('../migrations/V002__ensure_default_providers.js');

      const existingProviders = {
        providers: [{ id: 'openai', name: 'OpenAI' }]
      };
      const defaultProviders = {
        providers: [
          { id: 'openai', name: 'OpenAI' },
          { id: 'anthropic', name: 'Anthropic' },
          { id: 'google', name: 'Google' }
        ]
      };
      let writtenData = null;
      const ctx = {
        readJson: jest.fn().mockResolvedValue(existingProviders),
        readDefaultJson: jest.fn().mockResolvedValue(defaultProviders),
        writeJson: jest.fn().mockImplementation(async (path, data) => {
          writtenData = data;
        }),
        log: jest.fn()
      };

      await mod.up(ctx);

      expect(ctx.writeJson).toHaveBeenCalledTimes(1);
      expect(writtenData.providers).toHaveLength(3);
      expect(writtenData.providers.map(p => p.id)).toEqual(['openai', 'anthropic', 'google']);
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('2 missing provider'));
    });

    it('should not write if all providers are present', async () => {
      const mod = await import('../migrations/V002__ensure_default_providers.js');

      const providers = {
        providers: [
          { id: 'openai', name: 'OpenAI' },
          { id: 'anthropic', name: 'Anthropic' }
        ]
      };
      const ctx = {
        readJson: jest.fn().mockResolvedValue(providers),
        readDefaultJson: jest.fn().mockResolvedValue(providers),
        writeJson: jest.fn(),
        log: jest.fn()
      };

      await mod.up(ctx);

      expect(ctx.writeJson).not.toHaveBeenCalled();
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('already present'));
    });
  });
});
