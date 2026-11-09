// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V202: the `ihub` installation keeps only `ask_user` and the scheduled-task
 * tools; the knowledge, agent workspace and evidence tools leave its action
 * lists. A workflow or agent tool the installation had switched off stays
 * off through a tool file; the retired tool files that initial setup had
 * seeded again are removed.
 *
 * Run: node --test server/tests/migration-v202.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  up,
  precondition,
  version,
  description,
  contentHash,
  IHUB_TOOL_FILES,
  KNOWLEDGE_ACTIONS,
  MOVED_ACTIONS,
  SHIPPED_HASHES,
  WORKFLOW_ACTIONS,
  WORKFLOW_TOOL_FILES
} from '../migrations/V202__ihub_integration_chat_tools_only.js';
import {
  ihubInstance,
  SHIPPED_HASHES as V199_SHIPPED_HASHES
} from '../migrations/V199__ihub_tools_installed_integration.js';
import { PLATFORM_TOOL_FILE_IDS, PLATFORM_TOOL_IDS } from '../services/tools/platformTools.js';

/** The page reader: a platform tool since V204, retired by V195, not by V199/V202. */
const PAGE_READER = 'read_url';
import { KNOWLEDGE_TOOL_IDS } from '../services/knowledge/knowledgeTools.js';
import { IHUB_TOOL_FILE_IDS } from '../services/integrations/protocols/native/connectors/ihub/index.js';
import { RETIRED_IHUB_TOOL_FILES } from '../utils/setupUtils.js';

const DEFAULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../defaults');
const DEFINITION_FILE = path.join(
  DEFAULTS_DIR,
  'integration-definitions/com.intrafind__ihub/integration.json'
);
const sha256 = text => createHash('sha256').update(text).digest('hex');
// The files as V199 found them shipped. `knowledge.json` has changed since
// (#3539: its descriptions name the document list of a searched project); a
// copy seeded before then still matches the frozen hash, so the migration is
// tested against that copy, kept as a fixture.
const SHIPPED_AT_V199 = {
  knowledge: path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures/migration-v199/knowledge.v199.json'
  )
};
const shipped = id =>
  JSON.parse(
    readFileSync(SHIPPED_AT_V199[id] || path.join(DEFAULTS_DIR, `tools/${id}.json`), 'utf8')
  );

function makeCtx(files) {
  const logs = [];
  const warnings = [];
  const writes = [];
  return {
    logs,
    warnings,
    writes,
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes.push(rel);
      files[rel] = structuredClone(data);
    },
    deleteFile: async rel => {
      delete files[rel];
    },
    readDefaultJson: async rel => JSON.parse(readFileSync(path.join(DEFAULTS_DIR, rel), 'utf8')),
    listFiles: async () => [],
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

const integrations = (...installed) => ({
  installed,
  security: { blockPrivateIps: true, allowedHosts: [] }
});

describe('V202 iHub integration keeps only the chat tools', () => {
  it('declares its version', () => {
    assert.equal(version, '202');
    assert.equal(description, 'ihub_integration_chat_tools_only');
  });

  it('moves exactly the knowledge tools and the platform tools', () => {
    assert.deepEqual([...KNOWLEDGE_ACTIONS].sort(), [...KNOWLEDGE_TOOL_IDS].sort());
    // The page reader joined the platform tools with V204; V195 had retired its file.
    assert.deepEqual(
      [...WORKFLOW_ACTIONS].sort(),
      PLATFORM_TOOL_IDS.filter(id => id !== PAGE_READER).sort()
    );
    assert.deepEqual(
      Object.keys(WORKFLOW_TOOL_FILES).sort(),
      PLATFORM_TOOL_FILE_IDS.filter(id => id !== PAGE_READER).sort()
    );
    assert.deepEqual([...IHUB_TOOL_FILES].sort(), [...IHUB_TOOL_FILE_IDS].sort());
    const definition = JSON.parse(readFileSync(DEFINITION_FILE, 'utf8'));
    const kept = definition.actions.map(action => action.name);
    assert.deepEqual(kept.sort(), [...IHUB_TOOL_FILES].sort());
    for (const name of MOVED_ACTIONS) {
      assert.equal(kept.includes(name), false, `${name} is no longer an action`);
    }
  });

  it('snapshots V199’s hashes of the shipped files, which initial setup no longer seeds', () => {
    assert.deepEqual(SHIPPED_HASHES, V199_SHIPPED_HASHES);
    for (const id of Object.keys(SHIPPED_HASHES)) {
      assert.equal(contentHash(shipped(id), sha256), SHIPPED_HASHES[id], id);
    }
    // Plus the page reader, whose file V195 retired and V204 reads in place.
    assert.deepEqual(
      [...RETIRED_IHUB_TOOL_FILES].sort(),
      [...Object.keys(SHIPPED_HASHES), PAGE_READER].map(id => `tools/${id}.json`).sort()
    );
  });

  it('removes the moved actions from every action list', async () => {
    const instance = { ...ihubInstance(['ask_user', 'knowledge_read']), installedAt: 'then' };
    instance.actions.overrides = {
      ask_user: { sideEffect: 'read' },
      knowledge_search: { description: { en: 'Ours' } },
      write_memory: { sideEffect: 'write' }
    };
    const ctx = makeCtx({ 'config/integrations.json': integrations(instance) });
    assert.equal(await precondition(ctx), true);
    await up(ctx);

    const [migrated] = ctx.files['config/integrations.json'].installed;
    assert.deepEqual(migrated.actions.enabled, ['*']);
    assert.deepEqual(migrated.actions.disabled, ['ask_user']);
    assert.deepEqual(Object.keys(migrated.actions.overrides), ['ask_user']);
    assert.equal(migrated.installedAt, 'then');
    assert.ok(migrated.updatedAt);
    assert.match(ctx.logs.join('\n'), /disabled: knowledge_read/);
    assert.match(ctx.logs.join('\n'), /overrides: write_memory/);
    assert.equal(ctx.warnings.length, 1);
    assert.match(
      ctx.warnings[0],
      /knowledge_read now come with every request that reaches a project and cannot be switched off/
    );
  });

  it('keeps a switched-off workflow or agent tool off through its tool file', async () => {
    const instance = ihubInstance([
      'write_artifact',
      'evidence_collect',
      'evidence_validateQuotesFastPath',
      'evidence_composeReport'
    ]);
    const ctx = makeCtx({ 'config/integrations.json': integrations(instance) });
    await up(ctx);

    assert.deepEqual(ctx.files['config/integrations.json'].installed[0].actions.disabled, []);
    for (const id of ['write_artifact', 'evidence']) {
      const file = ctx.files[`tools/${id}.json`];
      assert.ok(file, `tools/${id}.json is written`);
      assert.equal(file.enabled, false);
      assert.equal(contentHash(file, sha256), SHIPPED_HASHES[id], 'the shipped file as shipped');
    }
    assert.equal('tools/read_memory.json' in ctx.files, false, 'a tool left on gets no file');
    assert.deepEqual(ctx.warnings, []);
  });

  it('warns about a single evidence function, which a tool file cannot switch off alone', async () => {
    const ctx = makeCtx({
      'config/integrations.json': integrations(ihubInstance(['evidence_collect']))
    });
    await up(ctx);
    assert.equal('tools/evidence.json' in ctx.files, false);
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0], /evidence_collect are now offered/);
  });

  it('reads an explicit enabled list as switching everything else off', async () => {
    const instance = ihubInstance();
    instance.actions.enabled = ['ask_user', 'knowledge_search', 'schedule_task'];
    const ctx = makeCtx({ 'config/integrations.json': integrations(instance) });
    await up(ctx);
    const [migrated] = ctx.files['config/integrations.json'].installed;
    assert.deepEqual(migrated.actions.enabled, ['ask_user', 'schedule_task']);
    for (const id of Object.keys(WORKFLOW_TOOL_FILES)) {
      assert.equal(ctx.files[`tools/${id}.json`]?.enabled, false, `${id} stays off`);
    }
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0], /knowledge_read, knowledge_list now come with/);
  });

  it('leaves a tool file of a switched-off tool to decide, as it did since V199', async () => {
    const edited = { ...shipped('write_artifact'), description: { en: 'Ours' } };
    const ctx = makeCtx({
      'config/integrations.json': integrations(ihubInstance(['write_artifact'])),
      'tools/write_artifact.json': edited
    });
    await up(ctx);
    assert.deepEqual(ctx.files['tools/write_artifact.json'], edited);
    assert.deepEqual(ctx.warnings, []);
  });

  it('removes the shipped files initial setup seeded again, keeping their switches', async () => {
    const files = {
      'config/integrations.json': integrations(ihubInstance()),
      'tools/ask_user.json': shipped('ask_user'),
      'tools/schedule_task.json': { ...shipped('schedule_task'), enabled: false },
      'tools/knowledge.json': shipped('knowledge'),
      'tools/write_memory.json': shipped('write_memory'),
      'tools/read_inbox.json': { ...shipped('read_inbox'), enabled: false },
      'tools/list_tasks.json': { ...shipped('list_tasks'), description: { en: 'Ours' } }
    };
    const ctx = makeCtx(files);
    assert.equal(await precondition(ctx), true);
    await up(ctx);

    for (const id of ['ask_user', 'schedule_task', 'knowledge', 'write_memory']) {
      assert.equal(`tools/${id}.json` in ctx.files, false, `tools/${id}.json is removed`);
    }
    assert.equal(ctx.files['tools/read_inbox.json'].enabled, false, 'an off switch is kept');
    assert.equal(ctx.files['tools/list_tasks.json'].description.en, 'Ours', 'an edit is kept');
    const [migrated] = ctx.files['config/integrations.json'].installed;
    assert.deepEqual(migrated.actions.disabled, ['schedule_task']);
    assert.deepEqual(ctx.warnings, []);
  });

  it('creates the installation when a seeded iHub file was switched off and none exists', async () => {
    const ctx = makeCtx({ 'tools/ask_user.json': { ...shipped('ask_user'), enabled: false } });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const config = ctx.files['config/integrations.json'];
    assert.equal(config.installed.length, 1);
    assert.equal(config.installed[0].id, 'ihub');
    assert.equal(config.installed[0].definition, 'com.intrafind/ihub');
    assert.deepEqual(config.installed[0].actions.disabled, ['ask_user']);
    assert.equal('tools/ask_user.json' in ctx.files, false);
  });

  it('warns about a switched-off knowledge file and about an edited one', async () => {
    const off = makeCtx({ 'tools/knowledge.json': { ...shipped('knowledge'), enabled: false } });
    await up(off);
    assert.equal('tools/knowledge.json' in off.files, false);
    assert.equal(off.warnings.length, 1);
    assert.match(off.warnings[0], /knowledge_search, knowledge_read, knowledge_list now come with/);

    const edited = makeCtx({
      'tools/knowledge.json': { id: 'knowledge', description: { en: 'Our own wording' } }
    });
    assert.equal(await precondition(edited), true);
    await up(edited);
    assert.ok('tools/knowledge.json' in edited.files, 'the admin’s file is not deleted');
    assert.equal(edited.warnings.length, 1);
    assert.match(edited.warnings[0], /tools\/knowledge\.json is no longer read/);
  });

  it('is idempotent and leaves other installations alone', async () => {
    const other = {
      id: 'portal',
      definition: 'org.ckan/open-data-portal',
      actions: { enabled: ['*'], disabled: ['knowledge_search'], overrides: {} }
    };
    const ctx = makeCtx({
      'config/integrations.json': integrations(ihubInstance(['write_inbox']), other),
      'tools/ask_user.json': shipped('ask_user')
    });
    await up(ctx);
    const once = structuredClone(ctx.files);
    const writes = ctx.writes.length;
    await up(ctx);
    assert.deepEqual(ctx.files, once);
    assert.equal(ctx.writes.length, writes, 'the second run writes nothing');
    assert.deepEqual(once['config/integrations.json'].installed[1], other);
    assert.deepEqual(once['config/integrations.json'].installed[0].actions.disabled, []);
    assert.equal(once['tools/write_inbox.json'].enabled, false);
  });

  it('does nothing without the file or the installation', async () => {
    const empty = makeCtx({});
    assert.equal(await precondition(empty), false);
    await up(empty);
    assert.deepEqual(empty.files, {});
    assert.equal(empty.warnings.length, 0);

    const without = makeCtx({ 'config/integrations.json': integrations() });
    await up(without);
    assert.equal(without.writes.length, 0);
    assert.match(without.logs[0], /No installation "ihub"/);
  });
});
