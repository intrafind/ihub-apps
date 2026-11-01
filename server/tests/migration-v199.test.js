// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V199: iHub's own tool files retire; the `ihub` installation owns the tools. */
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
  contentHash,
  ihubInstance,
  ACTIONS_BY_FILE,
  SHIPPED_HASHES
} from '../migrations/V199__ihub_tools_installed_integration.js';
import { IHUB_TOOL_FILE_IDS } from '../services/integrations/protocols/native/connectors/ihub/index.js';

const TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../defaults/tools');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const shipped = id => JSON.parse(readFileSync(path.join(TOOLS_DIR, `${id}.json`), 'utf8'));

function makeCtx(files) {
  const logs = [];
  const warnings = [];
  return {
    logs,
    warnings,
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = structuredClone(data);
    },
    deleteFile: async rel => {
      delete files[rel];
    },
    listFiles: async () => [],
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

describe('V199 iHub tools → installed integration', () => {
  it('declares its version', () => assert.equal(version, '199'));

  it('knows every tool file the connector ships, with its hash as shipped', () => {
    const ids = [...IHUB_TOOL_FILE_IDS].sort();
    assert.deepEqual(Object.keys(SHIPPED_HASHES).sort(), ids);
    for (const id of ids) {
      assert.equal(contentHash(shipped(id), sha256), SHIPPED_HASHES[id], id);
      assert.ok(ACTIONS_BY_FILE[id]?.length, `${id} has actions`);
    }
    assert.deepEqual(ACTIONS_BY_FILE.evidence, [
      'evidence_collect',
      'evidence_validateQuotesFastPath',
      'evidence_composeReport'
    ]);
    // Key order and `enabled` do not count; a changed description does.
    const askUser = shipped('ask_user');
    const reordered = Object.fromEntries(Object.entries(askUser).reverse());
    assert.equal(contentHash({ ...reordered, enabled: false }, sha256), SHIPPED_HASHES.ask_user);
    assert.notEqual(
      contentHash({ ...askUser, description: { en: 'edited' } }, sha256),
      SHIPPED_HASHES.ask_user
    );
  });

  it('creates the installation and removes the shipped tool files', async () => {
    const ctx = makeCtx({
      'config/integrations.json': { installed: [], security: { blockPrivateIps: true } },
      'tools/ask_user.json': shipped('ask_user'),
      'tools/evidence.json': { ...shipped('evidence'), enabled: false },
      'tools/knowledge.json': shipped('knowledge'),
      'tools/other.json': { id: 'other', script: 'other.js' }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx, { sha256 });
    const [instance] = ctx.files['config/integrations.json'].installed;
    assert.equal(instance.id, 'ihub');
    assert.equal(instance.definition, 'com.intrafind/ihub');
    assert.equal(instance.enabled, true);
    assert.deepEqual(instance.actions.disabled, ACTIONS_BY_FILE.evidence);
    assert.ok(instance.installedAt);
    for (const rel of ['tools/ask_user.json', 'tools/evidence.json', 'tools/knowledge.json']) {
      assert.equal(rel in ctx.files, false, rel);
    }
    assert.equal('tools/other.json' in ctx.files, true);
    assert.equal(ctx.warnings.length, 0);
  });

  it('keeps an admin-edited tool file and says so', async () => {
    const edited = { ...shipped('write_artifact'), description: { en: 'Our own wording' } };
    const ctx = makeCtx({
      'tools/write_artifact.json': edited,
      'tools/read_memory.json': shipped('read_memory')
    });
    await up(ctx, { sha256 });
    assert.deepEqual(ctx.files['tools/write_artifact.json'], edited);
    assert.equal('tools/read_memory.json' in ctx.files, false);
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0], /tools\/write_artifact\.json/);
    assert.equal(ctx.files['config/integrations.json'].installed[0].id, 'ihub');
  });

  it('adds disabled actions to an existing installation and is idempotent', async () => {
    const ctx = makeCtx({
      'config/integrations.json': {
        installed: [{ ...ihubInstance(['ask_user']), installedAt: 'then' }],
        security: {}
      },
      'tools/schedule_task.json': { ...shipped('schedule_task'), enabled: false }
    });
    await up(ctx, { sha256 });
    await up(ctx, { sha256 });
    const { installed } = ctx.files['config/integrations.json'];
    assert.equal(installed.length, 1);
    assert.deepEqual(installed[0].actions.disabled, ['ask_user', 'schedule_task']);
    assert.equal(installed[0].installedAt, 'then');
  });
});
