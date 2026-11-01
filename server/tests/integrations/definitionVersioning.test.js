// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The versioning fields of an integration definition (`compatibility`,
 * `releases`) and the compatibility check against the server version.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIntegrationDefinition,
  definitionSchemaRevision
} from '../../validators/integrationDefinitionSchema.js';
import {
  checkCompatibility,
  satisfiesRange,
  requiredRange,
  normalizeVersion,
  isNewerVersion
} from '../../services/integrations/definitions/compatibility.js';
import { installationStatusFor } from '../../services/marketplace/localContent.js';

function definition(extra = {}) {
  return {
    id: 'org.example/service',
    version: '1.4.0',
    name: { en: 'Example' },
    protocol: { type: 'openapi', document: 'api.json', baseUrl: '{baseUrl}' },
    auth: { modes: ['none'] },
    install: [{ key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true }],
    actions: [{ name: 'x', operationId: 'x', sideEffect: 'read' }],
    ...extra
  };
}

const messages = result => result.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('\n');

describe('definition schema: compatibility', () => {
  test('defaults to revision 1 and no range', () => {
    const result = validateIntegrationDefinition(definition());
    assert.ok(result.success);
    assert.deepEqual(result.data.compatibility, { schema: 1 });
    assert.equal(result.data.releases, undefined);
  });

  test('accepts a semver range and refuses a string that is none', () => {
    const ok = validateIntegrationDefinition(definition({ compatibility: { ihub: '>=5.7.0 <7' } }));
    assert.ok(ok.success);
    assert.equal(ok.data.compatibility.ihub, '>=5.7.0 <7');
    assert.equal(ok.data.compatibility.schema, 1);
    for (const bad of ['newer', '>=', '5.7.0 or later']) {
      const result = validateIntegrationDefinition(definition({ compatibility: { ihub: bad } }));
      assert.equal(result.success, false, bad);
      assert.match(messages(result), /compatibility\.ihub: .*semver range/);
    }
  });

  test('refuses an unknown schema revision, in the raw document and in the parse', () => {
    const raw = definition({ compatibility: { schema: 2 } });
    assert.deepEqual(definitionSchemaRevision(raw), { revision: 2, supported: false });
    assert.deepEqual(definitionSchemaRevision(definition()), { revision: 1, supported: true });
    assert.deepEqual(definitionSchemaRevision(definition({ compatibility: { schema: 1 } })), {
      revision: 1,
      supported: true
    });
    const result = validateIntegrationDefinition(raw);
    assert.equal(result.success, false);
    assert.match(messages(result), /compatibility\.schema: .*revision 2 is not supported/);
  });
});

describe('definition schema: releases', () => {
  const releases = [
    {
      version: '1.4.0',
      date: '2026-11-12',
      summary: { en: 'DataStore search returns total.' },
      notes: { features: 'releases/1.4.0/features.md', fixes: 'releases/1.4.0/fixes.md' },
      migration: '1.4.0'
    },
    { version: '1.3.1', date: '2026-11-02', summary: { en: 'Fix paging.' } },
    {
      version: '1.3.0',
      date: '2026-10-28',
      summary: 'Renamed fq.',
      notes: { breaking: 'releases/1.3.0/breaking-changes.md' }
    }
  ];

  test('accepts a history newest first whose head is the definition version', () => {
    const result = validateIntegrationDefinition(definition({ releases }));
    assert.ok(result.success, result.success ? '' : messages(result));
    assert.equal(result.data.releases.length, 3);
    assert.equal(result.data.releases[0].migration, '1.4.0');
  });

  test('refuses a head that is not the definition version', () => {
    const result = validateIntegrationDefinition(definition({ version: '1.5.0', releases }));
    assert.equal(result.success, false);
    assert.match(messages(result), /releases\.0\.version: the newest release must be .*1\.5\.0/);
  });

  test('refuses a history that is not strictly descending', () => {
    const shuffled = [releases[0], releases[2], releases[1]];
    let result = validateIntegrationDefinition(definition({ releases: shuffled }));
    assert.equal(result.success, false);
    assert.match(messages(result), /releases\.2\.version: .*newest first/);
    const duplicate = [releases[0], { ...releases[0] }];
    result = validateIntegrationDefinition(definition({ releases: duplicate }));
    assert.equal(result.success, false);
    result = validateIntegrationDefinition(definition({ releases: [] }));
    assert.equal(result.success, false);
  });

  test('refuses bad dates, note paths outside the folder and non-Markdown notes', () => {
    const cases = [
      [{ ...releases[0], date: '12.11.2026' }, /date/],
      [{ ...releases[0], notes: { features: '../other/features.md' } }, /relative path/],
      [{ ...releases[0], notes: { features: '/etc/passwd.md' } }, /relative path/],
      [{ ...releases[0], notes: { features: 'releases/1.4.0/features.txt' } }, /Markdown/],
      [{ ...releases[0], notes: { changes: 'releases/1.4.0/changes.md' } }, /notes/]
    ];
    for (const [release, pattern] of cases) {
      const result = validateIntegrationDefinition(definition({ releases: [release] }));
      assert.equal(result.success, false, JSON.stringify(release));
      assert.match(messages(result), pattern);
    }
  });
});

describe('compatibility check', () => {
  test('normalizes versions and reads the catalog short form', () => {
    assert.equal(normalizeVersion('v5.7.0'), '5.7.0');
    assert.equal(normalizeVersion('5.7.0-rc.1'), '5.7.0-rc.1');
    assert.equal(normalizeVersion('5.7'), '5.7.0');
    assert.equal(normalizeVersion('next'), null);
    assert.equal(requiredRange({ compatibility: { ihub: '>=6' } }), '>=6');
    assert.equal(requiredRange({ minVersion: '5.7' }), '>=5.7.0');
    assert.equal(requiredRange({ compatibility: { ihub: '>=6' }, minVersion: '5.7' }), '>=6');
    assert.equal(requiredRange({}), null);
  });

  test('satisfies ranges, including prereleases, and treats no range as compatible', () => {
    assert.equal(satisfiesRange('>=5.7.0 <7', '5.7.2'), true);
    assert.equal(satisfiesRange('>=5.7.0 <7', '7.0.0'), false);
    assert.equal(satisfiesRange('>=5.7.0', '5.6.4'), false);
    assert.equal(satisfiesRange('>=5.7.0', '5.7.1-rc.1'), true);
    assert.equal(satisfiesRange(null, '5.6.4'), true);
    assert.equal(satisfiesRange('>=5.7.0', null), true);
    assert.equal(satisfiesRange('not a range', '5.7.0'), false);
  });

  test('reports the verdict with the range it was checked against', () => {
    assert.deepEqual(checkCompatibility({ compatibility: { ihub: '>=6.0.0' } }, '5.7.2'), {
      requires: '>=6.0.0',
      compatible: false,
      serverVersion: '5.7.2'
    });
    assert.deepEqual(checkCompatibility({ minVersion: '5.7.0' }, '5.7.2'), {
      requires: '>=5.7.0',
      compatible: true,
      serverVersion: '5.7.2'
    });
    assert.equal(isNewerVersion('1.4.0', '1.3.1'), true);
    assert.equal(isNewerVersion('1.3.1', '1.4.0'), false);
    assert.equal(isNewerVersion('1.4.0', undefined), false);
  });

  test('marks an installed item whose catalog version differs as update-available', () => {
    assert.equal(installationStatusFor({ version: '1.0.0' }, false, '1.1.0'), 'update-available');
    assert.equal(installationStatusFor({ version: '1.0.0' }, false, '1.0.0'), 'installed');
    assert.equal(installationStatusFor({ version: null }, false, '1.0.0'), 'installed');
    assert.equal(installationStatusFor(undefined, true, '1.0.0'), 'local');
    assert.equal(installationStatusFor(undefined, false), 'available');
  });
});
