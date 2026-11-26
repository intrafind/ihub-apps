#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V264 specs — the Qwant web search engine is removed.
 *
 * Its installation goes, apps naming it fall back to `auto`, grants of it are
 * dropped, and everything else (the other engines, `type:web-search` grants,
 * unrelated apps) is left as it is.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  migrateApp,
  migrateGrants,
  version,
  description
} from '../migrations/V264__remove_qwant_web_search_engine.js';

let baseDir = null;

function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    listFiles: async (directory, pattern) => {
      const suffix = pattern.replace('*', '');
      try {
        return (await fs.readdir(path.join(dir, directory))).filter(name => name.endsWith(suffix));
      } catch {
        return [];
      }
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

const engine = (id, definition) => ({ id, definition, definitionVersion: '1.0.0', enabled: true });
const QWANT = engine('qwant', 'com.intrafind/qwant-search');
const BRAVE = engine('brave', 'com.intrafind/brave-search');
const STAAN = engine('staan', 'com.intrafind/staan-search');

async function setUp({ installed, groups, apps = {} }) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'case-'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
  if (installed) {
    await fs.writeFile(
      path.join(dir, 'config/integrations.json'),
      JSON.stringify({ installed }),
      'utf8'
    );
  }
  if (groups) {
    await fs.writeFile(path.join(dir, 'config/groups.json'), JSON.stringify({ groups }), 'utf8');
  }
  for (const [id, app] of Object.entries(apps)) {
    await fs.writeFile(path.join(dir, `apps/${id}.json`), JSON.stringify(app), 'utf8');
  }
  return dir;
}

const readJson = async (dir, rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v264-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V264 remove the Qwant web search engine', () => {
  it('exports its version and description', () => {
    assert.equal(version, '264');
    assert.equal(description, 'remove_qwant_web_search_engine');
  });

  it('runs only when there is something to read', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'empty-'));
    assert.equal(await precondition(makeCtx(dir)), false);
    assert.equal(await precondition(makeCtx(await setUp({ installed: [] }))), true);
  });

  it('removes the Qwant installation and keeps the other engines', async () => {
    const dir = await setUp({ installed: [BRAVE, QWANT, STAAN] });
    const ctx = makeCtx(dir);
    await up(ctx);
    const { installed } = await readJson(dir, 'config/integrations.json');
    assert.deepEqual(
      installed.map(entry => entry.id),
      ['brave', 'staan']
    );
    assert.ok(ctx.logs.some(([, message]) => /Removed 1 installation/.test(message)));
  });

  it('removes an installation of the definition whatever its id', async () => {
    const dir = await setUp({
      installed: [engine('my-qwant', 'com.intrafind/qwant-search'), engine('qwant', 'org.acme/x')]
    });
    await up(makeCtx(dir));
    const { installed } = await readJson(dir, 'config/integrations.json');
    assert.deepEqual(
      installed.map(entry => entry.id),
      ['qwant']
    );
  });

  it('drops the grants of Qwant and keeps the others', async () => {
    const dir = await setUp({
      installed: [QWANT],
      groups: {
        staff: {
          id: 'staff',
          permissions: {
            integrations: ['qwant', 'brave', 'com.intrafind/qwant-search', 'type:web-search']
          }
        },
        users: { id: 'users', permissions: { apps: ['*'] } }
      }
    });
    await up(makeCtx(dir));
    const { groups } = await readJson(dir, 'config/groups.json');
    assert.deepEqual(groups.staff.permissions.integrations, ['brave', 'type:web-search']);
    assert.deepEqual(groups.users.permissions, { apps: ['*'] });
  });

  it('sets apps that name Qwant to auto and leaves other apps alone', async () => {
    const dir = await setUp({
      installed: [QWANT],
      apps: {
        onQwant: { id: 'onQwant', websearch: { enabled: true, provider: 'qwant', maxResults: 7 } },
        onBrave: { id: 'onBrave', websearch: { enabled: true, provider: 'brave' } },
        plain: { id: 'plain' }
      }
    });
    await up(makeCtx(dir));
    assert.deepEqual((await readJson(dir, 'apps/onQwant.json')).websearch, {
      enabled: true,
      provider: 'auto',
      maxResults: 7
    });
    assert.equal((await readJson(dir, 'apps/onBrave.json')).websearch.provider, 'brave');
    assert.deepEqual(await readJson(dir, 'apps/plain.json'), { id: 'plain' });
  });

  it('is idempotent: a second run changes nothing', async () => {
    const dir = await setUp({
      installed: [BRAVE, QWANT],
      groups: { staff: { id: 'staff', permissions: { integrations: ['qwant'] } } },
      apps: { a: { id: 'a', websearch: { provider: 'qwant' } } }
    });
    await up(makeCtx(dir));
    const snapshot = await Promise.all(
      ['config/integrations.json', 'config/groups.json', 'apps/a.json'].map(rel =>
        fs.readFile(path.join(dir, rel), 'utf8')
      )
    );
    const ctx = makeCtx(dir);
    await up(ctx);
    const again = await Promise.all(
      ['config/integrations.json', 'config/groups.json', 'apps/a.json'].map(rel =>
        fs.readFile(path.join(dir, rel), 'utf8')
      )
    );
    assert.deepEqual(again, snapshot);
    assert.equal(
      ctx.logs.some(([, message]) => /Removed|→|grant/.test(message)),
      false
    );
  });

  it('warns about an app file it cannot read and carries on', async () => {
    const dir = await setUp({ installed: [QWANT] });
    await fs.writeFile(path.join(dir, 'apps/broken.json'), '{ nope', 'utf8');
    await fs.writeFile(
      path.join(dir, 'apps/ok.json'),
      JSON.stringify({ id: 'ok', websearch: { provider: 'qwant' } }),
      'utf8'
    );
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.ok(
      ctx.logs.some(([level, message]) => level === 'warn' && /broken\.json/.test(message))
    );
    assert.equal((await readJson(dir, 'apps/ok.json')).websearch.provider, 'auto');
  });
});

describe('V264 migrateApp / migrateGrants', () => {
  it('removes an app binding of Qwant, and `integrations` when it was the only one', () => {
    const only = migrateApp({ id: 'a', integrations: { qwant: {} } });
    assert.equal('integrations' in only.app, false);
    const mixed = migrateApp({
      id: 'a',
      integrations: { 'com.intrafind/qwant-search': {}, jira: { actions: ['getTicket'] } }
    });
    assert.deepEqual(Object.keys(mixed.app.integrations), ['jira']);
  });

  it('returns the very same app when nothing changes', () => {
    const app = { id: 'a', websearch: { provider: 'auto' } };
    const result = migrateApp(app);
    assert.equal(result.app, app);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(migrateApp(null), { app: null, changes: [] });
  });

  it('migrateGrants is null when no grant names Qwant', () => {
    assert.equal(migrateGrants(['brave', 'type:web-search']), null);
    assert.equal(migrateGrants(undefined), null);
    assert.deepEqual(migrateGrants(['qwant']), []);
  });
});
