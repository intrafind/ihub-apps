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
import {
  scanMigrationFiles,
  loadHistory,
  computeChecksum,
  reconcileRenamedMigrations,
  acquireLock,
  releaseLock
} from '../migrations/runner.js';
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

    it('should throw when two files declare the same version', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'V018__add_cookie_settings.js'),
        'export const version = "018";'
      );
      await fs.writeFile(
        path.join(tmpDir, 'V018__add_setup_configured_flag.js'),
        'export const version = "018";'
      );

      await expect(scanMigrationFiles(tmpDir)).rejects.toThrow(/Duplicate migration version V018/);
    });

    it('should not throw when all versions are unique', async () => {
      await fs.writeFile(path.join(tmpDir, 'V001__first.js'), 'export const version = "001";');
      await fs.writeFile(path.join(tmpDir, 'V002__second.js'), 'export const version = "002";');

      await expect(scanMigrationFiles(tmpDir)).resolves.toHaveLength(2);
    });
  });

  describe('acquireLock / releaseLock', () => {
    it('acquires a lock on an empty directory and writes lock metadata', async () => {
      await acquireLock(tmpDir);
      const raw = await fs.readFile(path.join(tmpDir, '.migration-lock'), 'utf8');
      const lock = JSON.parse(raw);
      expect(lock.pid).toBe(process.pid);
      expect(typeof lock.startedAt).toBe('string');
    });

    it('rejects a second acquire while the lock is fresh', async () => {
      await acquireLock(tmpDir);
      await expect(acquireLock(tmpDir)).rejects.toThrow(/Migration lock held/);
    });

    it('lets exactly one of two concurrent acquires win instead of racing', async () => {
      // Regression test for the read-then-write TOCTOU: two callers hitting
      // acquireLock at the same instant used to both pass the "does it
      // exist" check before either had written the lock file, so both
      // resolved successfully and both went on to run migrations.
      const results = await Promise.allSettled([acquireLock(tmpDir), acquireLock(tmpDir)]);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.message).toMatch(/Migration lock held/);
    });

    it('steals a stale lock instead of blocking forever', async () => {
      const lockPath = path.join(tmpDir, '.migration-lock');
      const staleStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 999999, startedAt: staleStartedAt, hostname: 'stale-host' })
      );

      await expect(acquireLock(tmpDir)).resolves.toBeUndefined();
      const raw = await fs.readFile(lockPath, 'utf8');
      const lock = JSON.parse(raw);
      expect(lock.pid).toBe(process.pid);
    });

    it('releaseLock removes the lock file and is a no-op when absent', async () => {
      await acquireLock(tmpDir);
      await releaseLock(tmpDir);
      await expect(fs.access(path.join(tmpDir, '.migration-lock'))).rejects.toThrow();
      await expect(releaseLock(tmpDir)).resolves.toBeUndefined();
    });
  });

  describe('reconcileRenamedMigrations', () => {
    it('rewrites a history entry recorded under a renamed migration file', () => {
      const history = {
        schemaVersion: '1.0',
        migrations: [
          {
            version: '018',
            description: 'add_setup_configured_flag',
            file: 'V018__add_setup_configured_flag.js',
            checksum: 'abc123',
            status: 'success'
          }
        ]
      };

      const changed = reconcileRenamedMigrations(history);

      expect(changed).toBe(true);
      expect(history.migrations[0].version).toBe('075');
      expect(history.migrations[0].file).toBe('V075__add_setup_configured_flag.js');
    });

    it('leaves the sibling that kept its original version number untouched', () => {
      const history = {
        schemaVersion: '1.0',
        migrations: [
          {
            version: '018',
            description: 'add_cookie_settings',
            file: 'V018__add_cookie_settings.js',
            checksum: 'abc123',
            status: 'success'
          }
        ]
      };

      const changed = reconcileRenamedMigrations(history);

      expect(changed).toBe(false);
      expect(history.migrations[0].version).toBe('018');
      expect(history.migrations[0].file).toBe('V018__add_cookie_settings.js');
    });

    it('rewrites the Qwant provider entry that was renumbered V110 -> V111', () => {
      const history = {
        schemaVersion: '1.0',
        migrations: [
          {
            version: '110',
            description: 'add_qwant_websearch_provider',
            file: 'V110__add_qwant_websearch_provider.js',
            checksum: 'abc123',
            status: 'success'
          },
          {
            version: '110',
            description: 'add_proxy_defaults',
            file: 'V110__add_proxy_defaults.js',
            checksum: 'def456',
            status: 'success'
          }
        ]
      };

      const changed = reconcileRenamedMigrations(history);

      expect(changed).toBe(true);
      expect(history.migrations[0].version).toBe('111');
      expect(history.migrations[0].file).toBe('V111__add_qwant_websearch_provider.js');
      // The proxy migration kept V110, so its history entry must not move.
      expect(history.migrations[1].version).toBe('110');
      expect(history.migrations[1].file).toBe('V110__add_proxy_defaults.js');
    });

    it('moves the 5.5.30 follow-ups to V148-V151 from any earlier numbering', () => {
      // They were V143-V146, V145-V148, V146-V149, V147-V150, and main's V144-V147 share
      // numbers with them: only the file name tells them apart.
      const entry = (version, file) => ({
        version,
        description: file.replace(/^V\d+__|\.js$/g, ''),
        file,
        checksum: 'abc123',
        status: 'success'
      });
      const files = [
        'translator_task_in_system_prompt',
        'seed_mistral_realtime_transcription_model',
        'seed_google_tts_models',
        'dictation_via_transcription_models'
      ];
      const mains = [
        entry('144', 'V144__remove_app_wizard_fields.js'),
        entry('145', 'V145__add_short_link_allowed_hosts.js'),
        entry('146', 'V146__add_local_auth_lockout.js'),
        entry('147', 'V147__add_proxy_auth_trusted_sources.js')
      ];
      const rows = history => history.migrations.map(m => `${m.version} ${m.file}`);
      const current = files.map((name, i) => `${148 + i} V${148 + i}__${name}.js`);

      for (const first of [143, 145, 146, 147]) {
        const history = {
          schemaVersion: '1.0',
          migrations: [
            ...files.map((name, i) => entry(String(first + i), `V${first + i}__${name}.js`)),
            ...mains.map(m => ({ ...m }))
          ]
        };
        expect(reconcileRenamedMigrations(history)).toBe(true);
        expect(rows(history)).toEqual([...current, ...rows({ migrations: mains })]);
      }
    });

    it('rewrites both CIMD governance entries, V111/V112 -> V112/V113', () => {
      // The chain is the interesting part: the governance migration moves onto
      // the number the grandfathering one is vacating, so a rule that matched
      // on version alone would rewrite the same entry twice.
      const history = {
        schemaVersion: '1.0',
        migrations: [
          {
            version: '111',
            description: 'add_oauth_cimd_governance',
            file: 'V111__add_oauth_cimd_governance.js',
            checksum: 'abc123',
            status: 'success'
          },
          {
            version: '112',
            description: 'grandfather_connected_cimd_clients',
            file: 'V112__grandfather_connected_cimd_clients.js',
            checksum: 'def456',
            status: 'skipped'
          }
        ]
      };

      const changed = reconcileRenamedMigrations(history);

      expect(changed).toBe(true);
      expect(history.migrations[0].version).toBe('112');
      expect(history.migrations[0].file).toBe('V112__add_oauth_cimd_governance.js');
      expect(history.migrations[1].version).toBe('113');
      expect(history.migrations[1].file).toBe('V113__grandfather_connected_cimd_clients.js');
    });

    it('leaves the Qwant provider on V111 when it is already reconciled', () => {
      // V111 now belongs to Qwant. Its entry must not be dragged to V112 by the
      // governance rule, which is why the match is on (version, file).
      const history = {
        schemaVersion: '1.0',
        migrations: [
          {
            version: '111',
            description: 'add_qwant_websearch_provider',
            file: 'V111__add_qwant_websearch_provider.js',
            checksum: 'abc123',
            status: 'success'
          }
        ]
      };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations[0].version).toBe('111');
    });

    it('rewrites the short-link allowlist entry renumbered V143 -> V145', () => {
      const history = {
        schemaVersion: '1.0',
        migrations: [
          {
            version: '143',
            description: 'add_short_link_allowed_hosts',
            file: 'V143__add_short_link_allowed_hosts.js',
            checksum: 'abc123',
            status: 'success'
          },
          {
            version: '144',
            description: 'remove_app_wizard_fields',
            file: 'V144__remove_app_wizard_fields.js',
            checksum: 'def456',
            status: 'success'
          }
        ]
      };

      expect(reconcileRenamedMigrations(history)).toBe(true);
      expect(history.migrations[0].version).toBe('145');
      expect(history.migrations[0].file).toBe('V145__add_short_link_allowed_hosts.js');
      // V144 belongs to the app wizard cleanup, which kept its number.
      expect(history.migrations[1].version).toBe('144');
      expect(history.migrations[1].file).toBe('V144__remove_app_wizard_fields.js');
    });

    it.each([
      '141',
      '142',
      '143',
      '145',
      '146',
      '147',
      '148',
      '152',
      '153',
      '154',
      '155',
      '156',
      '157'
    ])(
      'moves an EU AI Act entry recorded at V%s to V158 so it no longer blocks main',
      oldVersion => {
        // A dev install that ran the branch while it held that number recorded
        // it; main's provider plain names (V141), text-to-speech (V142),
        // short-link allowlist (V145), local sign-in lockout (V146), proxy-auth
        // trusted sources (V147), Translator system prompt (V148), user skills
        // settings (V152), workflow code node removal (V153), user skills
        // marketplace (V154), skill builder (V155), skills catalog token budget
        // (V156) and read_url tool rename (V157) migrations hold those numbers
        // now, and V143 sorts below main's app wizard field cleanup (V144).
        const history = {
          schemaVersion: '1.0',
          migrations: [
            {
              version: oldVersion,
              description: 'add_ai_transparency',
              file: `V${oldVersion}__add_ai_transparency.js`,
              checksum: 'abc123',
              status: 'success'
            },
            {
              version: '140',
              description: 'web_tools_filters_and_page_offset',
              file: 'V140__web_tools_filters_and_page_offset.js',
              checksum: 'def456',
              status: 'success'
            }
          ]
        };

        expect(reconcileRenamedMigrations(history)).toBe(true);
        expect(history.migrations[0].version).toBe('158');
        expect(history.migrations[0].file).toBe('V158__add_ai_transparency.js');
        expect(history.migrations[1].version).toBe('140');
      }
    );

    it("leaves main's V145 short-link entry alone when reconciling the EU AI Act V145", () => {
      const shortLinks = {
        version: '145',
        description: 'add_short_link_allowed_hosts',
        file: 'V145__add_short_link_allowed_hosts.js',
        checksum: 'abc123',
        status: 'success'
      };
      const history = { schemaVersion: '1.0', migrations: [{ ...shortLinks }] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([shortLinks]);
    });

    it("leaves main's V148 Translator entry alone when reconciling the EU AI Act V148", () => {
      const translator = {
        version: '148',
        description: 'translator_task_in_system_prompt',
        file: 'V148__translator_task_in_system_prompt.js',
        checksum: 'abc123',
        status: 'success'
      };
      const history = { schemaVersion: '1.0', migrations: [{ ...translator }] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([translator]);
    });

    it("leaves main's V152 user skills entry alone when reconciling the EU AI Act V152", () => {
      const userSkills = {
        version: '152',
        description: 'add_user_skills_settings',
        file: 'V152__add_user_skills_settings.js',
        checksum: 'abc123',
        status: 'success'
      };
      const history = { schemaVersion: '1.0', migrations: [{ ...userSkills }] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([userSkills]);
    });

    it("leaves main's V153 workflow entry alone when reconciling the EU AI Act V153", () => {
      const workflows = {
        version: '153',
        description: 'replace_workflow_code_accumulator',
        file: 'V153__replace_workflow_code_accumulator.js',
        checksum: 'abc123',
        status: 'success'
      };
      const history = { schemaVersion: '1.0', migrations: [{ ...workflows }] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([workflows]);
    });

    it("leaves main's V154 skills marketplace entry alone when reconciling the EU AI Act V154", () => {
      const marketplace = {
        version: '154',
        description: 'add_user_skills_marketplace',
        file: 'V154__add_user_skills_marketplace.js',
        checksum: 'abc123',
        status: 'success'
      };
      const history = { schemaVersion: '1.0', migrations: [{ ...marketplace }] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([marketplace]);
    });

    it("leaves main's V155 skill builder entry alone when reconciling the EU AI Act V155", () => {
      const skillBuilder = {
        version: '155',
        description: 'add_skill_builder_to_chat_app',
        file: 'V155__add_skill_builder_to_chat_app.js',
        checksum: 'abc123',
        status: 'success'
      };
      const history = { schemaVersion: '1.0', migrations: [{ ...skillBuilder }] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([skillBuilder]);
    });

    it("leaves main's V156 skills budget entry alone when reconciling the EU AI Act V156", () => {
      const skillsBudget = {
        version: '156',
        description: 'add_skills_catalog_token_budget',
        file: 'V156__add_skills_catalog_token_budget.js',
        checksum: 'abc123',
        status: 'success'
      };
      const history = { schemaVersion: '1.0', migrations: [{ ...skillsBudget }] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([skillsBudget]);
    });

    it("leaves main's V157 read_url entry alone when reconciling the EU AI Act V157", () => {
      const readUrl = {
        version: '157',
        description: 'rename_web_page_reader_tool_to_read_url',
        file: 'V157__rename_web_page_reader_tool_to_read_url.js',
        checksum: 'abc123',
        status: 'success'
      };
      const history = { schemaVersion: '1.0', migrations: [{ ...readUrl }] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([readUrl]);
    });

    it('is a no-op on a fresh install with no matching history entries', () => {
      const history = { schemaVersion: '1.0', migrations: [] };

      expect(reconcileRenamedMigrations(history)).toBe(false);
      expect(history.migrations).toEqual([]);
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
