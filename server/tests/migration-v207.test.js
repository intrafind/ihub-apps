// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V207: every installation without a valid `definitionVersion` gets the
 * version of the definition shipped (or installed from the marketplace) at
 * that time as its baseline; installations whose definition is missing are
 * left alone; a second run changes nothing.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import {
  up,
  precondition,
  version,
  description,
  isStrictVersion,
  readDefinitionVersions,
  stampBaseline
} from '../migrations/V207__integration_definition_version_baseline.js';

let root;
let defaultsDir;
let contentsDir;

async function writeDefinition(base, folder, definition) {
  const dir = path.join(base, 'integration-definitions', folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'integration.json'), JSON.stringify(definition));
}

function makeCtx(files) {
  const logs = [];
  const warnings = [];
  let writes = 0;
  return {
    logs,
    warnings,
    files,
    defaultsDir,
    contentsDir,
    get writes() {
      return writes;
    },
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes += 1;
      files[rel] = structuredClone(data);
    },
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v207-'));
  defaultsDir = path.join(root, 'defaults');
  contentsDir = path.join(root, 'contents');
  await writeDefinition(defaultsDir, 'com.intrafind__ifinder', {
    id: 'com.intrafind/ifinder',
    version: '1.0.0'
  });
  await writeDefinition(defaultsDir, 'org.ckan__open-data-portal', {
    id: 'org.ckan/open-data-portal',
    version: '1.0.0'
  });
  // The marketplace copy wins over the shipped one, as at load.
  await writeDefinition(contentsDir, 'org.ckan__open-data-portal', {
    id: 'org.ckan/open-data-portal',
    version: '1.3.0'
  });
  await writeDefinition(contentsDir, 'org.example__tool', {
    id: 'org.example/tool',
    version: '2.1.0'
  });
  // Never read: a staging folder of the registry and a broken definition.
  await writeDefinition(contentsDir, '.staging-1', { id: 'org.example/tool', version: '9.9.9' });
  await writeDefinition(contentsDir, 'org.example__broken', {
    id: 'org.example/broken',
    version: 'x'
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('V207 integration definition version baseline', () => {
  it('has the version and description of its file name', () => {
    assert.equal(version, '207');
    assert.equal(description, 'integration_definition_version_baseline');
  });

  it('accepts only strict versions', () => {
    for (const ok of ['1.0.0', '0.0.1', '10.20.30', '1.2.3-rc.1', '1.2.3-beta']) {
      assert.equal(isStrictVersion(ok), true, ok);
    }
    for (const bad of [
      undefined,
      null,
      1,
      '',
      '1.2',
      'v1.2.3',
      '01.2.3',
      '1.2.3+build',
      '1.2.3-01',
      'latest'
    ]) {
      assert.equal(isStrictVersion(bad), false, String(bad));
    }
  });

  it('decides the tricky versions exactly as the semver grammar it snapshots', () => {
    const cases = {
      // accepted
      '0.0.0': true,
      '1.2.3-0': true,
      '1.2.3-0a': true,
      '1.2.3-01a': true,
      '1.2.3-a-': true,
      '1.2.3--': true,
      '1.2.3-a.0.b': true,
      '1.2.3-A-Z.9': true,
      '1.2.3-alpha-beta': true,
      '1.2.3-1.2.3': true,
      // beyond Number.MAX_SAFE_INTEGER: the grammar admits it (the semver package does not)
      '99999999999999999999.0.0': true,
      [`1.2.3-${'a'.repeat(58)}`]: true,
      // refused
      [`1.2.3-${'a'.repeat(59)}`]: false,
      '1.2.3-': false,
      '1.2.3-.a': false,
      '1.2.3-a.': false,
      '1.2.3-a..b': false,
      '1.2.3-00': false,
      '1.2.3-a.01': false,
      '1.2.3-a+b': false,
      '1.2.3+b': false,
      '1.2.3.4': false,
      '1.2.-3': false,
      '1.2.3a': false,
      '1..3': false,
      '.1.2.3': false,
      '1.2.3\n': false,
      ' 1.2.3': false,
      '=1.2.3': false,
      '1.02.3': false,
      '1.2.03': false,
      '-1.2.3': false
    };
    for (const [value, expected] of Object.entries(cases)) {
      assert.equal(isStrictVersion(value), expected, JSON.stringify(value));
    }
  });

  it('matches the strict semver grammar over every short string and prerelease combination', () => {
    // Below Number.MAX_SAFE_INTEGER, a string semver parses back to itself is
    // exactly the grammar V207 snapshots: no `v`, no `=`, no spaces, no build.
    const oracle = value => semver.valid(value) === value;
    const checked = [];
    const alphabet = ['0', '1', '.', '-', 'a', '+'];
    const brute = (prefix, depth) => {
      checked.push(prefix);
      if (depth > 0) for (const char of alphabet) brute(prefix + char, depth - 1);
    };
    brute('', 5);
    const numbers = ['0', '1', '01', '10', 'a', ''];
    const identifiers = ['0', '01', '1', '10', 'a', '0a', 'a-', '-', '', '1a1', 'A-Z', '+', '00'];
    for (const major of numbers) {
      for (const minor of numbers) {
        for (const patch of numbers) {
          const core = `${major}.${minor}.${patch}`;
          checked.push(core);
          for (const first of identifiers) {
            checked.push(`${core}-${first}`);
            for (const second of identifiers) checked.push(`${core}-${first}.${second}`);
          }
        }
      }
    }
    const mismatches = checked.filter(value => isStrictVersion(value) !== oracle(value));
    assert.deepEqual(mismatches, []);
    assert.ok(checked.filter(oracle).length > 1000, 'the enumeration reaches accepted versions');
  });

  it('reads both trees, skipping dot-folders and invalid definitions', async () => {
    const shipped = await readDefinitionVersions(path.join(defaultsDir, 'integration-definitions'));
    assert.deepEqual(Object.fromEntries(shipped), {
      'com.intrafind/ifinder': '1.0.0',
      'org.ckan/open-data-portal': '1.0.0'
    });
    const installed = await readDefinitionVersions(
      path.join(contentsDir, 'integration-definitions')
    );
    assert.deepEqual(Object.fromEntries(installed), {
      'org.ckan/open-data-portal': '1.3.0',
      'org.example/tool': '2.1.0'
    });
    assert.equal((await readDefinitionVersions(path.join(root, 'nowhere'))).size, 0);
  });

  it('runs only when integrations.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(
      await precondition(makeCtx({ 'config/integrations.json': { installed: [] } })),
      true
    );
  });

  it('stamps missing and invalid versions, keeps valid ones, leaves unknown definitions', async () => {
    const files = {
      'config/integrations.json': {
        installed: [
          { id: 'ifinder', definition: 'com.intrafind/ifinder', values: { baseUrl: 'https://x' } },
          { id: 'govdata', definition: 'org.ckan/open-data-portal', definitionVersion: '1.2' },
          { id: 'tool', definition: 'org.example/tool', definitionVersion: '2.0.0' },
          { id: 'ghost', definition: 'org.example/gone' },
          { id: 'broken', definition: 'org.example/broken' }
        ],
        security: { blockPrivateIps: true, allowedHosts: [] }
      }
    };
    const ctx = makeCtx(files);
    await up(ctx);
    const installed = files['config/integrations.json'].installed;
    assert.equal(installed[0].definitionVersion, '1.0.0', 'shipped version as the baseline');
    assert.deepEqual(installed[0].values, { baseUrl: 'https://x' }, 'nothing else changes');
    assert.equal(installed[1].definitionVersion, '1.3.0', 'the installed copy wins');
    assert.equal(installed[2].definitionVersion, '2.0.0', 'a valid version is kept');
    assert.equal(installed[3].definitionVersion, undefined, 'definition missing: left alone');
    assert.equal(installed[4].definitionVersion, undefined, 'invalid definition: left alone');
    assert.deepEqual(files['config/integrations.json'].security, {
      blockPrivateIps: true,
      allowedHosts: []
    });
    assert.equal(ctx.writes, 1);
    assert.match(ctx.logs.join('\n'), /ifinder@1\.0\.0, govdata@1\.3\.0/);
    assert.match(ctx.warnings.join('\n'), /ghost, broken/);

    // Idempotent: the second run writes nothing.
    const again = makeCtx(files);
    await up(again);
    assert.equal(again.writes, 0);
    assert.equal(files['config/integrations.json'].installed[0].definitionVersion, '1.0.0');
  });

  it('writes nothing for an empty file', async () => {
    const ctx = makeCtx({ 'config/integrations.json': { installed: [] } });
    await up(ctx);
    assert.equal(ctx.writes, 0);
  });

  it('stampBaseline reports what it did', () => {
    const config = {
      installed: [
        { id: 'a', definition: 'x/y' },
        { id: 'b', definition: 'x/z', definitionVersion: '1.0.0' }
      ]
    };
    const result = stampBaseline(config, new Map([['x/y', '3.0.0']]));
    assert.deepEqual(result, {
      stamped: [{ id: 'a', version: '3.0.0', previous: undefined }],
      missing: []
    });
  });

  it('the stamped versions pass the installed integrations schema', async () => {
    const { validateIntegrationsConfig } =
      await import('../validators/integrationsConfigSchema.js');
    const files = {
      'config/integrations.json': {
        installed: [{ id: 'ifinder', definition: 'com.intrafind/ifinder', definitionVersion: 'v1' }]
      }
    };
    const beforeStamp = validateIntegrationsConfig(files['config/integrations.json']);
    assert.equal(beforeStamp.data.installed[0].status, 'needsReview');
    await up(makeCtx(files));
    const afterStamp = validateIntegrationsConfig(files['config/integrations.json']);
    assert.equal(afterStamp.success, true);
    assert.equal(afterStamp.data.installed[0].definitionVersion, '1.0.0');
    assert.equal(afterStamp.data.installed[0].status, undefined);
  });
});
