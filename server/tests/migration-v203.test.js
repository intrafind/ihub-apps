// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V203: the `websearch` installation becomes one installation per engine
 * ("keep what worked"), grants by `websearch` become `type:web-search`, stale
 * app references go, and a fresh install gets no engine.
 *
 * Run: node --test server/tests/migration-v203.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  description,
  planEngines,
  migrateApp,
  migrateGrants,
  isFreshInstall,
  oldActionEnabled,
  FRESH_RUN_WINDOW_MS
} from '../migrations/V203__web_search_engines.js';

const READER_DEFAULT = {
  id: 'read_url',
  name: { en: 'Web Page Reader' },
  script: 'webContentExtractor.js',
  method: 'extractForTool',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
};

function makeCtx(files, defaults = { 'tools/read_url.json': READER_DEFAULT }) {
  const logs = [];
  const warnings = [];
  return {
    logs,
    warnings,
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => {
      if (!(rel in files)) throw new Error(`ENOENT ${rel}`);
      return structuredClone(files[rel]);
    },
    writeJson: async (rel, data) => {
      files[rel] = structuredClone(data);
    },
    readDefaultJson: async rel => {
      if (!(rel in defaults)) throw new Error(`ENOENT ${rel}`);
      return structuredClone(defaults[rel]);
    },
    listFiles: async (dir, pattern) => {
      const prefix = `${dir}/`;
      const suffix = pattern?.startsWith('*') ? pattern.slice(1) : '';
      return Object.keys(files)
        .filter(rel => rel.startsWith(prefix) && rel.endsWith(suffix))
        .map(rel => rel.slice(prefix.length));
    },
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

function websearch(values = {}, extra = {}) {
  return {
    id: 'websearch',
    definition: 'com.intrafind/web-search',
    enabled: true,
    values: { defaultProvider: 'auto', ...values },
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    ...extra
  };
}

function integrationsFile(...installed) {
  return { installed, security: { blockPrivateIps: true, allowedHosts: [] } };
}

/** A migration history whose first entry was written long ago: an upgrade. */
const UPGRADE_HISTORY = {
  migrations: [{ version: '001', appliedAt: '2025-01-01T00:00:00.000Z', status: 'success' }]
};
/** A migration history that began in this run: a fresh install. */
const freshHistory = () => ({
  migrations: [{ version: '001', appliedAt: new Date().toISOString(), status: 'success' }]
});

const ids = files => files['config/integrations.json'].installed.map(entry => entry.id);
const engine = (files, id) => files['config/integrations.json'].installed.find(e => e.id === id);

let savedEnv;
beforeEach(() => {
  savedEnv = { brave: process.env.BRAVE_SEARCH_API_KEY, staan: process.env.STAAN_API_KEY };
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.STAAN_API_KEY;
});
afterEach(() => {
  for (const [name, value] of [
    ['BRAVE_SEARCH_API_KEY', savedEnv.brave],
    ['STAAN_API_KEY', savedEnv.staan]
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('V203 web_search_engines', () => {
  it('has the expected version and description', () => {
    assert.equal(version, '203');
    assert.equal(description, 'web_search_engines');
  });

  it('runs where integrations, groups or apps exist', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/integrations.json': {} })), true);
    assert.equal(await precondition(makeCtx({ 'config/groups.json': {} })), true);
    assert.equal(await precondition(makeCtx({ 'apps/a.json': {} })), true);
  });

  describe('keys', () => {
    it('installs Brave and Staan where a credential was referenced, and carries the refs', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(
          websearch({
            braveCredentialRef: 'integration-websearch-brave',
            staanCredentialRef: 'staan-key'
          })
        )
      };
      await up(makeCtx(files));
      assert.deepEqual(ids(files), ['brave', 'staan']);
      assert.deepEqual(engine(files, 'brave').values, { apiKeyRef: 'integration-websearch-brave' });
      assert.deepEqual(engine(files, 'staan').values, { apiKeyRef: 'staan-key' });
      assert.equal(engine(files, 'brave').definition, 'com.intrafind/brave-search');
      assert.equal(engine(files, 'staan').definition, 'com.intrafind/staan-search');
      assert.equal(engine(files, 'brave').definitionVersion, '1.0.0');
      assert.equal(engine(files, 'brave').enabled, true);
    });

    it('installs an engine whose key is only in the environment, without a ref', async () => {
      process.env.STAAN_API_KEY = 'from-env';
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch())
      };
      const ctx = makeCtx(files);
      await up(ctx);
      assert.deepEqual(ids(files), ['staan']);
      assert.deepEqual(engine(files, 'staan').values, {});
      assert.ok(ctx.logs.some(line => line.includes('STAAN_API_KEY')));
    });

    it('carries the enabled state and a switched-off search action', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(
          websearch(
            { braveCredentialRef: 'b', staanCredentialRef: 's' },
            { enabled: false, actions: { enabled: ['*'], disabled: ['staan'] } }
          )
        )
      };
      await up(makeCtx(files));
      assert.equal(engine(files, 'brave').enabled, false);
      assert.deepEqual(engine(files, 'brave').actions.disabled, []);
      assert.deepEqual(engine(files, 'staan').actions.disabled, ['search']);
    });

    it('relabels the credentials V195 created', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(
          websearch({ braveCredentialRef: 'integration-websearch-brave' })
        ),
        'config/credentials.json': {
          credentials: {
            'integration-websearch-brave': {
              id: 'integration-websearch-brave',
              type: 'secret',
              description: 'Managed by the installed integration "websearch"',
              value: 'enc'
            },
            other: { id: 'other', description: 'mine' }
          }
        }
      };
      await up(makeCtx(files));
      const store = files['config/credentials.json'].credentials;
      assert.equal(
        store['integration-websearch-brave'].description,
        'API key of the web search engine "brave"'
      );
      assert.equal(store['integration-websearch-brave'].value, 'enc');
      assert.equal(store.other.description, 'mine');
    });
  });

  describe('Qwant', () => {
    it('is installed where Auto fell back to it (no keys)', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch())
      };
      await up(makeCtx(files));
      assert.deepEqual(ids(files), ['qwant']);
      assert.deepEqual(engine(files, 'qwant').values, {});
    });

    it('is not installed when Auto had a keyed engine and nothing named Qwant', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch({ braveCredentialRef: 'b' }))
      };
      await up(makeCtx(files));
      assert.deepEqual(ids(files), ['brave']);
    });

    it('is installed when it was the default engine, keys or not', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(
          websearch({ defaultProvider: 'qwant', braveCredentialRef: 'b' })
        )
      };
      await up(makeCtx(files));
      assert.deepEqual(ids(files), ['brave', 'qwant']);
    });

    it('is installed when an app names it', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch({ staanCredentialRef: 's' })),
        'apps/news.json': { id: 'news', websearch: { enabled: true, provider: 'qwant' } }
      };
      await up(makeCtx(files));
      assert.deepEqual(ids(files), ['staan', 'qwant']);
    });
  });

  describe('fresh install', () => {
    it('gets no engine from the Auto default V195 created in the same run', async () => {
      const files = {
        '.migration-history.json': freshHistory(),
        'config/integrations.json': integrationsFile(
          websearch({}, { installedAt: new Date().toISOString() }),
          { id: 'x500bund', definition: 'com.intrafind/ldap-directory', enabled: false }
        ),
        'apps/web-chat.json': { id: 'web-chat', websearch: { enabled: true, provider: 'auto' } }
      };
      const ctx = makeCtx(files);
      await up(ctx);
      assert.deepEqual(ids(files), ['x500bund']);
      assert.ok(ctx.logs.some(line => line.includes('fresh install')));
      // The shipped app is left as it is: it searches natively.
      assert.deepEqual(files['apps/web-chat.json'].websearch, { enabled: true, provider: 'auto' });
    });

    it('still installs an engine a key or an app asks for', async () => {
      process.env.BRAVE_SEARCH_API_KEY = 'k';
      const files = {
        '.migration-history.json': freshHistory(),
        'config/integrations.json': integrationsFile(websearch())
      };
      await up(makeCtx(files));
      assert.deepEqual(ids(files), ['brave']);
    });

    it('is told by a history that began in this run', async () => {
      const now = Date.parse('2026-11-02T10:00:00Z');
      const at = ms => ({
        '.migration-history.json': {
          migrations: [{ version: '001', appliedAt: new Date(now - ms).toISOString() }]
        }
      });
      assert.equal(await isFreshInstall(makeCtx(at(5_000)), now), true);
      assert.equal(await isFreshInstall(makeCtx(at(FRESH_RUN_WINDOW_MS + 1)), now), false);
      assert.equal(await isFreshInstall(makeCtx({}), now), false);
      assert.equal(
        await isFreshInstall(makeCtx({ '.migration-history.json': { migrations: [] } }), now),
        false
      );
    });
  });

  describe('apps', () => {
    it('pins apps on Auto to an explicit former default engine', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(
          websearch({ defaultProvider: 'staan', staanCredentialRef: 's' })
        ),
        'apps/auto.json': { id: 'auto', websearch: { enabled: true, provider: 'auto' } },
        'apps/unset.json': { id: 'unset', websearch: { enabled: true } },
        'apps/brave.json': { id: 'brave', websearch: { enabled: true, provider: 'brave' } },
        'apps/none.json': { id: 'none' }
      };
      await up(makeCtx(files));
      assert.equal(files['apps/auto.json'].websearch.provider, 'staan');
      assert.equal(files['apps/unset.json'].websearch.provider, 'staan');
      assert.equal(files['apps/brave.json'].websearch.provider, 'brave');
      assert.deepEqual(files['apps/none.json'], { id: 'none' });
    });

    it('leaves apps on Auto when the default was Auto', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch()),
        'apps/auto.json': { id: 'auto', websearch: { enabled: true, provider: 'auto' } }
      };
      await up(makeCtx(files));
      assert.equal(files['apps/auto.json'].websearch.provider, 'auto');
    });

    it('warns when the explicit default engine had no key and is not installed', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch({ defaultProvider: 'brave' })),
        'apps/auto.json': { id: 'auto', websearch: { enabled: true } }
      };
      const ctx = makeCtx(files);
      await up(ctx);
      assert.deepEqual(ids(files), []);
      assert.equal(files['apps/auto.json'].websearch.provider, 'brave');
      assert.ok(ctx.warnings.some(line => line.includes('"brave" is not installed')));
    });

    it('removes stale references to websearch', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch({ braveCredentialRef: 'b' })),
        'apps/a.json': {
          id: 'a',
          tools: ['websearch', 'read_url'],
          integrations: { websearch: {}, 'com.intrafind/web-search': {}, jira: {} }
        },
        'apps/b.json': { id: 'b', tools: ['websearch'], integrations: { websearch: {} } }
      };
      await up(makeCtx(files));
      assert.deepEqual(files['apps/a.json'].tools, ['read_url']);
      assert.deepEqual(files['apps/a.json'].integrations, { jira: {} });
      assert.deepEqual(files['apps/b.json'], { id: 'b' });
    });

    it('migrateApp changes nothing on an app without references', () => {
      const app = { id: 'x', websearch: { enabled: true, provider: 'qwant' }, tools: ['jira'] };
      const { app: next, changes } = migrateApp(app, 'brave');
      assert.equal(next, app);
      assert.deepEqual(changes, []);
    });
  });

  describe('groups', () => {
    it('turns grants of websearch into type:web-search', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch()),
        'config/groups.json': {
          groups: {
            anonymous: { id: 'anonymous', permissions: { integrations: ['ihub', 'websearch'] } },
            research: {
              id: 'research',
              permissions: { integrations: ['websearch', 'com.intrafind/web-search', 'jira'] }
            },
            both: { id: 'both', permissions: { integrations: ['type:web-search', 'websearch'] } },
            users: { id: 'users', permissions: { integrations: ['*'] } },
            none: { id: 'none', permissions: {} }
          }
        }
      };
      await up(makeCtx(files));
      const groups = files['config/groups.json'].groups;
      assert.deepEqual(groups.anonymous.permissions.integrations, ['ihub', 'type:web-search']);
      assert.deepEqual(groups.research.permissions.integrations, ['type:web-search', 'jira']);
      assert.deepEqual(groups.both.permissions.integrations, ['type:web-search']);
      assert.deepEqual(groups.users.permissions.integrations, ['*']);
      assert.deepEqual(groups.none.permissions, {});
    });

    it('migrateGrants returns null when nothing changes', () => {
      assert.equal(migrateGrants(['*']), null);
      assert.equal(migrateGrants(undefined), null);
    });
  });

  describe('page reader', () => {
    it('stays off through a tool file when websearch had switched it off', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(
          websearch({}, { actions: { enabled: ['*'], disabled: ['readUrl'] } })
        )
      };
      await up(makeCtx(files));
      assert.equal(files['tools/read_url.json'].enabled, false);
      assert.equal(files['tools/read_url.json'].script, 'webContentExtractor.js');
    });

    it('writes no tool file while it was on, and keeps an existing one', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch())
      };
      await up(makeCtx(files));
      assert.equal('tools/read_url.json' in files, false);

      const own = { id: 'read_url', enabled: true, description: 'mine' };
      const files2 = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(
          websearch({}, { actions: { enabled: ['brave', 'qwant'] } })
        ),
        'tools/read_url.json': own
      };
      await up(makeCtx(files2));
      assert.deepEqual(files2['tools/read_url.json'], own);
    });

    it('oldActionEnabled reads enabled and disabled lists as the server did', () => {
      assert.equal(oldActionEnabled({}, 'readUrl'), true);
      assert.equal(oldActionEnabled({ actions: { disabled: ['readUrl'] } }, 'readUrl'), false);
      assert.equal(oldActionEnabled({ actions: { enabled: ['brave'] } }, 'readUrl'), false);
      assert.equal(oldActionEnabled({ actions: { enabled: ['readUrl'] } }, 'readUrl'), true);
    });
  });

  describe('idempotence and missing files', () => {
    it('changes nothing on a second run', async () => {
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch({ braveCredentialRef: 'b' })),
        'config/groups.json': {
          groups: { anonymous: { id: 'anonymous', permissions: { integrations: ['websearch'] } } }
        },
        'apps/a.json': { id: 'a', websearch: { enabled: true } }
      };
      await up(makeCtx(files));
      const after = structuredClone(files);
      await up(makeCtx(files));
      assert.deepEqual(files, after);
    });

    it('does nothing without the files', async () => {
      const files = {};
      const ctx = makeCtx(files);
      await up(ctx);
      assert.deepEqual(files, {});
    });

    it('keeps an engine installation that exists already', async () => {
      const own = { id: 'brave', definition: 'com.intrafind/brave-search', enabled: false };
      const files = {
        '.migration-history.json': UPGRADE_HISTORY,
        'config/integrations.json': integrationsFile(websearch({ braveCredentialRef: 'b' }), own)
      };
      await up(makeCtx(files));
      assert.deepEqual(engine(files, 'brave'), own);
      assert.deepEqual(ids(files), ['brave']);
    });
  });

  describe('planEngines', () => {
    it('explains every engine it installs or leaves out', () => {
      const plan = planEngines(websearch({ braveCredentialRef: 'b' }), {
        env: { STAAN_API_KEY: '' },
        now: '2026-11-02T00:00:00.000Z'
      });
      assert.deepEqual(
        plan.engines.map(e => e.id),
        ['brave']
      );
      assert.equal(plan.reasons.brave, 'credential "b"');
      assert.equal(plan.skipped.staan, 'no API key was configured');
      assert.equal(plan.skipped.qwant, 'Qwant was not used');
      assert.equal(plan.defaultEngine, null);
      assert.equal(plan.engines[0].installedAt, '2026-11-02T00:00:00.000Z');
    });
  });
});
