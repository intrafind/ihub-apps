// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Example apps of integrations (#3128): the template → app logic of
 * `services/integrations/exampleApps.js`, the `exampleApps` field of the
 * definition schema, `IntegrationRegistry.readExampleApp`, and every
 * example app a shipped definition names passes the app schema.
 *
 * Run with `npm run test:integrations`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IntegrationRegistry } from '../../services/integrations/definitions/IntegrationRegistry.js';
import { appConfigSchema } from '../../validators/appConfigSchema.js';
import { validateIntegrationDefinition } from '../../validators/integrationDefinitionSchema.js';
import {
  bindToInstallation,
  buildExampleApp,
  generatedExampleApp,
  isValidAppId,
  nameForInstallation,
  suggestAppId,
  toAppId
} from '../../services/integrations/exampleApps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shippedDir = path.join(here, '..', '..', 'defaults', 'integration-definitions');

const DEFINITION = {
  id: 'org.example/portal',
  type: 'people-directory',
  name: { en: 'Portal', de: 'Portal' },
  description: { en: 'Search the portal.', de: 'Das Portal durchsuchen.' },
  instructions: { en: 'Start with search.', de: 'Beginne mit search.' },
  actions: [
    {
      name: 'search',
      title: { en: 'Search', de: 'Suchen' },
      examples: [{ en: 'Find parking data', de: 'Finde Parkdaten' }]
    },
    { name: 'hidden', enabledByDefault: false, examples: [{ en: 'never' }] },
    { name: 'plain' }
  ]
};

describe('example app ids', () => {
  it('prefers the template id, then appends the installation, then a number', () => {
    const taken = new Set(['open-data', 'open-data-govdata']);
    const isTaken = id => taken.has(id);
    assert.equal(suggestAppId('fresh', 'govdata', isTaken), 'fresh');
    assert.equal(suggestAppId('open-data', 'govdata', isTaken), 'open-data-govdata-2');
    taken.delete('open-data-govdata');
    assert.equal(suggestAppId('open-data', 'govdata', isTaken), 'open-data-govdata');
  });

  it('falls back to <instance>-assistant and keeps ids within 50 characters', () => {
    assert.equal(
      suggestAppId(undefined, 'jira', () => false),
      'jira-assistant'
    );
    const long = suggestAppId('a'.repeat(60), 'b'.repeat(20), id => id.length === 50);
    assert.ok(long.length <= 50 && isValidAppId(long), long);
    assert.equal(toAppId('My App!'), 'my-app');
    assert.equal(isValidAppId('Bad Id'), false);
  });
});

describe('bindToInstallation', () => {
  it('re-keys a definition-id binding to the installation and keeps its settings', () => {
    const out = bindToInstallation(
      { 'org.example/portal': { actions: ['search'], required: false }, 'type:web-search': {} },
      DEFINITION,
      'corp'
    );
    assert.deepEqual(out, {
      'type:web-search': {},
      corp: { actions: ['search'], required: false }
    });
  });

  it('re-keys a type binding and adds one when the template binds nothing', () => {
    assert.deepEqual(bindToInstallation({ 'type:people-directory': {} }, DEFINITION, 'corp'), {
      corp: {}
    });
    assert.deepEqual(bindToInstallation(undefined, DEFINITION, 'corp'), { corp: {} });
  });
});

describe('buildExampleApp', () => {
  it('sets id, enabled and binding, names the installation when renamed', () => {
    const template = {
      id: 'portal-app',
      name: { en: 'Portal app', de: 'Portal-App' },
      parentId: 'x',
      integrations: { 'org.example/portal': {} }
    };
    const app = buildExampleApp({
      template,
      definition: DEFINITION,
      instance: { id: 'corp', label: { en: 'Corp', de: 'Firma' } },
      appId: 'portal-app-corp',
      enabled: false,
      renamed: true
    });
    assert.equal(app.id, 'portal-app-corp');
    assert.equal(app.enabled, false);
    assert.deepEqual(app.integrations, { corp: {} });
    assert.deepEqual(app.name, { en: 'Portal app (Corp)', de: 'Portal-App (Firma)' });
    assert.equal(app.parentId, undefined);
    // The template is not changed.
    assert.deepEqual(template.integrations, { 'org.example/portal': {} });
  });

  it('does not repeat a label already in the name', () => {
    assert.equal(nameForInstallation('Corp search', 'Corp'), 'Corp search');
  });
});

describe('generatedExampleApp', () => {
  it('builds a valid assistant from the definition', () => {
    const app = generatedExampleApp(DEFINITION, { id: 'corp', label: 'Corp portal' });
    assert.deepEqual(app.name, { en: 'Corp portal', de: 'Corp portal' });
    assert.match(app.system.en, /Corp portal/);
    assert.match(app.system.en, /Start with search\./);
    assert.match(app.system.de, /Beginne mit search\./);
    assert.deepEqual(
      app.starterPrompts.map(p => p.message.en),
      ['Find parking data'],
      'only enabled actions with examples'
    );
    const built = buildExampleApp({
      template: app,
      definition: DEFINITION,
      instance: { id: 'corp' },
      appId: 'corp-assistant',
      enabled: true
    });
    const result = appConfigSchema.safeParse(built);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it('uses the definition name without a label', () => {
    const app = generatedExampleApp(DEFINITION, { id: 'corp' });
    assert.equal(app.name.en, 'Portal');
  });
});

describe('definition schema: exampleApps', () => {
  const base = {
    id: 'org.example/x',
    version: '1.0.0',
    name: 'X',
    protocol: { type: 'native', module: 'x' },
    auth: { modes: ['none'] }
  };

  it('accepts JSON companion files', () => {
    const result = validateIntegrationDefinition({
      ...base,
      exampleApps: [{ file: 'apps/x.json' }]
    });
    assert.ok(result.success);
  });

  it('refuses other files, traversal, duplicates and too many', () => {
    for (const exampleApps of [
      [{ file: 'apps/x.md' }],
      [{ file: '../x.json' }],
      [{ file: '/abs.json' }],
      [{ file: 'apps/x.json' }, { file: 'apps/x.json' }],
      Array.from({ length: 6 }, (_, i) => ({ file: `apps/${i}.json` })),
      [{ file: 'apps/x.json', extra: true }]
    ]) {
      assert.equal(
        validateIntegrationDefinition({ ...base, exampleApps }).success,
        false,
        JSON.stringify(exampleApps)
      );
    }
  });
});

describe('IntegrationRegistry.readExampleApp', () => {
  it('reads only listed JSON files inside the folder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-example-apps-'));
    try {
      const dir = path.join(root, 'org.example__x');
      await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'integration.json'),
        JSON.stringify({
          id: 'org.example/x',
          version: '1.0.0',
          name: 'X',
          protocol: { type: 'native', module: 'x' },
          auth: { modes: ['none'] },
          exampleApps: [{ file: 'apps/x.json' }, { file: 'apps/broken.json' }]
        })
      );
      await fs.writeFile(path.join(dir, 'apps', 'x.json'), JSON.stringify({ id: 'x' }));
      await fs.writeFile(path.join(dir, 'apps', 'other.json'), JSON.stringify({ id: 'o' }));
      await fs.writeFile(path.join(dir, 'apps', 'broken.json'), '{ nope');
      const registry = new IntegrationRegistry({
        shippedDir: root,
        contentsDir: path.join(root, 'none')
      });
      await registry.reload();
      assert.deepEqual(await registry.readExampleApp('org.example/x', 'apps/x.json'), { id: 'x' });
      assert.equal(await registry.readExampleApp('org.example/x', 'apps/other.json'), null);
      assert.equal(await registry.readExampleApp('org.example/x', 'apps/broken.json'), null);
      assert.equal(await registry.readExampleApp('org.example/missing', 'apps/x.json'), null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('shipped example apps', () => {
  it('every example app a shipped definition names exists and passes the app schema', async () => {
    const registry = new IntegrationRegistry({
      shippedDir,
      contentsDir: path.join(os.tmpdir(), 'ihub-no-installed-definitions')
    });
    await registry.reload();
    const withExamples = registry.list().filter(e => e.definition.exampleApps?.length);
    assert.ok(
      withExamples.some(e => e.definition.id === 'com.intrafind/ldap-browser') &&
        withExamples.some(e => e.definition.id === 'org.ckan/open-data-portal'),
      'the LDAP browser and CKAN ship example apps'
    );
    for (const entry of withExamples) {
      for (const { file } of entry.definition.exampleApps) {
        const template = await registry.readExampleApp(entry.definition.id, file);
        assert.ok(template, `${entry.definition.id}: ${file} is readable JSON`);
        const app = buildExampleApp({
          template,
          definition: entry.definition,
          instance: { id: 'test-installation', label: 'Test' },
          appId: 'test-app',
          enabled: true,
          renamed: true
        });
        const result = appConfigSchema.safeParse(app);
        assert.ok(
          result.success,
          `${entry.definition.id}: ${file}: ${JSON.stringify(result.error?.issues)}`
        );
        assert.deepEqual(Object.keys(app.integrations), ['test-installation']);
      }
    }
  });

  it('every shipped definition gets a valid generated example app', async () => {
    const registry = new IntegrationRegistry({
      shippedDir,
      contentsDir: path.join(os.tmpdir(), 'ihub-no-installed-definitions')
    });
    await registry.reload();
    for (const entry of registry.list()) {
      const app = buildExampleApp({
        template: generatedExampleApp(entry.definition, { id: 'inst' }),
        definition: entry.definition,
        instance: { id: 'inst' },
        appId: 'inst-assistant',
        enabled: true
      });
      const result = appConfigSchema.safeParse(app);
      assert.ok(result.success, `${entry.definition.id}: ${JSON.stringify(result.error?.issues)}`);
    }
  });
});
