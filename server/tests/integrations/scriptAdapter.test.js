// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The `script` protocol: a definition folder carries its connector module,
 * which the native adapter loads and runs like a built-in connector.
 */
const { default: configCache } = await import('../../configCache.js');
const { default: registry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const { checkScriptCodeFiles } =
  await import('../../services/integrations/definitions/scriptModule.js');
const adapter = await import('../../services/integrations/protocols/native/NativeAdapter.js');
const { getProtocolAdapter, notifyDefinitionsChanged } =
  await import('../../services/integrations/protocols/index.js');
const { syncIntegrationScopeProviders } =
  await import('../../services/integrations/integrationTools.js');
const { getScopeProvider } = await import('../../services/integrations/scopes/index.js');

let root;
const definition = {
  id: 'test.script/echo',
  version: '1.0.0',
  name: { en: 'Echo' },
  protocol: { type: 'script', module: 'connector.js' },
  auth: { modes: ['none'] },
  install: [{ key: 'prefix', type: 'string', title: { en: 'Prefix' }, default: '>' }],
  actions: [
    { name: 'echo', title: { en: 'Echo' }, description: { en: 'Repeats' }, sideEffect: 'read' },
    { name: 'missing', title: { en: 'Not implemented' }, sideEffect: 'read' }
  ]
};
const connector = `
export default {
  id: 'echo',
  actions: {
    echo: {
      parameters: { type: 'object', properties: { text: { type: 'string', description: { en: 'Text', de: 'Text' } } }, required: ['text'] },
      run: async (args, ctx) => \`\${ctx.values.prefix} \${args.text} (\${ctx.user?.id || 'nobody'})\`
    }
  },
  test: async ({ values }) => [{ id: 'ok', label: 'Module', status: 'ok', message: values.prefix }]
};
`;
const instance = { id: 'echo', definition: definition.id, enabled: true, values: { prefix: '>>' } };

/**
 * A definition with scopes whose connector brings its own scope provider,
 * written in several versions: `run` and the provider both name the version.
 */
const scopedDefinition = {
  id: 'test.script/scoped',
  version: '1.0.0',
  name: { en: 'Scoped' },
  protocol: { type: 'script', module: 'connector.js' },
  auth: { modes: ['none'] },
  scopes: { label: { en: 'Space' } },
  actions: [{ name: 'which', title: { en: 'Which' }, sideEffect: 'read' }]
};
const scopedConnector = version => `
export default {
  id: 'scoped',
  actions: {
    which: { parameters: { type: 'object', properties: {} }, run: async () => '${version}' }
  },
  scopeProvider(resolved) {
    return {
      id: resolved.instance.id,
      version: '${version}',
      appliesTo: () => true,
      listScopes: async () => ({
        scopes: [{ id: 'space-${version}', name: 'Space ${version}' }],
        defaultScope: 'space-${version}',
        fixed: false,
        source: 'integration'
      }),
      validateScope: async ({ scopeId }) => ({ ok: true, scopeId, fixed: false })
    };
  }
};
`;
const scopedInstance = {
  id: 'scoped',
  definition: scopedDefinition.id,
  enabled: true,
  values: {},
  auth: { mode: 'none' }
};
const scopedDir = () => path.join(root, 'shipped', 'test.script__scoped');

/** Write (or rewrite) the scoped folder as `version`, with a module mtime that is surely new. */
async function writeScoped(version) {
  await fs.mkdir(scopedDir(), { recursive: true });
  await fs.writeFile(
    path.join(scopedDir(), 'integration.json'),
    JSON.stringify({ ...scopedDefinition, version })
  );
  const file = path.join(scopedDir(), 'connector.js');
  await fs.writeFile(file, scopedConnector(version));
  const later = new Date(Date.now() + 1000 * Number(version[0]));
  await fs.utimes(file, later, later);
  await registry.reload();
  return registry.get(scopedDefinition.id).definition;
}

function scopedResolved(def) {
  return { definition: def, instance: scopedInstance, values: {}, label: 'Scoped' };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-script-'));
  const dir = path.join(root, 'shipped', 'test.script__echo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'integration.json'), JSON.stringify(definition));
  await fs.writeFile(path.join(dir, 'connector.js'), connector);
  registry.shippedDir = path.join(root, 'shipped');
  registry.contentsDirOverride = path.join(root, 'contents');
  await registry.reload();
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
  configCache.cache?.clear?.();
});

describe('script protocol', () => {
  it('is served by the native adapter', () => {
    assert.equal(getProtocolAdapter('script'), getProtocolAdapter('native'));
    assert.ok(registry.get(definition.id), 'definition loaded');
  });

  it('lists the actions the module implements', async () => {
    const actions = await adapter.discoverActions({ definition, instance, language: 'de' });
    const echo = actions.find(a => a.name === 'echo');
    assert.equal(echo.available, true);
    assert.equal(echo.toolId, 'echo__echo');
    assert.equal(echo.parameters.properties.text.description, 'Text');
    assert.equal(actions.find(a => a.name === 'missing').available, false);
  });

  it('runs an action with the install values and the user', async () => {
    const result = await adapter.run({
      definition,
      instance,
      action: definition.actions[0],
      args: { text: 'hi' },
      context: { user: { id: 'alice' } }
    });
    assert.equal(result, '>> hi (alice)');
  });

  it('tests through the module', async () => {
    const result = await adapter.test({ definition, instance });
    assert.equal(result.success, true);
    assert.equal(result.steps[0].message, '>>');
    assert.equal(result.actionCount, 1);
  });

  it('skips a definition whose module is missing', async () => {
    const dir = path.join(root, 'shipped', 'test.script__broken');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'integration.json'),
      JSON.stringify({ ...definition, id: 'test.script/broken' })
    );
    await registry.reload();
    assert.equal(registry.get('test.script/broken'), null);
  });
});

describe('script connectors and their scope providers', () => {
  before(async () => {
    configCache.setCacheEntry('config/integrations.json', {
      installed: [scopedInstance],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
  });

  it("registers the connector's own scope provider with nothing loaded (startup)", async () => {
    const def = await writeScoped('1.0.0');
    const file = path.join(scopedDir(), 'connector.js');
    assert.equal(
      adapter.loadedScriptModules().some(m => m.file === file),
      false,
      'not loaded yet'
    );
    assert.equal(adapter.scopeProvider(scopedResolved(def)), null, 'sync lookup sees nothing');

    await syncIntegrationScopeProviders();

    const provider = getScopeProvider('scoped');
    assert.ok(provider, 'a provider is registered for the installation');
    assert.equal(provider.version, '1.0.0', "the connector's own provider, not the generic one");
    const { scopes } = await provider.listScopes({ user: { id: 'alice' }, app: {} });
    assert.deepEqual(
      scopes.map(s => s.id),
      ['space-1.0.0']
    );
  });

  it('serves the re-installed module for actions and the scope provider, one entry per file', async () => {
    const def = await writeScoped('2.0.0');
    const file = path.join(scopedDir(), 'connector.js');

    const result = await adapter.run({
      definition: def,
      instance: scopedInstance,
      action: def.actions[0],
      args: {}
    });
    assert.equal(result, '2.0.0');
    assert.equal(adapter.scopeProvider(scopedResolved(def)).version, '2.0.0');
    const entries = adapter.loadedScriptModules().filter(m => m.file === file);
    assert.equal(entries.length, 1, 'the previous version is evicted');
    assert.match(entries[0].key, /@2\.0\.0@/);
  });

  it('is told about a definition change: loads the module and re-registers the provider', async () => {
    await writeScoped('3.0.0');
    // The registry still holds what the last sync registered: the adapter was
    // asked directly above, nothing re-registered the provider since.
    assert.equal(getScopeProvider('scoped').version, '1.0.0', 'still the registered provider');

    await notifyDefinitionsChanged({ definitionIds: [scopedDefinition.id] });

    assert.equal(getScopeProvider('scoped').version, '3.0.0');
    const { scopes } = await getScopeProvider('scoped').listScopes({ user: {}, app: {} });
    assert.deepEqual(
      scopes.map(s => s.id),
      ['space-3.0.0']
    );
    assert.equal(
      adapter.loadedScriptModules().filter(m => m.definitionId === scopedDefinition.id).length,
      1
    );
  });

  it('keeps the other providers when one module does not load', async () => {
    await writeScoped('4.0.0');
    await fs.writeFile(path.join(scopedDir(), 'connector.js'), 'export default 42;\n');
    const brokenDir = path.join(root, 'shipped', 'test.script__other');
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.writeFile(
      path.join(brokenDir, 'integration.json'),
      JSON.stringify({ ...scopedDefinition, id: 'test.script/other' })
    );
    await fs.writeFile(path.join(brokenDir, 'connector.js'), scopedConnector('other'));
    await registry.reload();
    configCache.setCacheEntry('config/integrations.json', {
      installed: [
        scopedInstance,
        { ...scopedInstance, id: 'other', definition: 'test.script/other' }
      ],
      security: { blockPrivateIps: true, allowedHosts: [] }
    });

    await syncIntegrationScopeProviders();

    assert.equal(getScopeProvider('scoped'), null, 'the broken installation has no provider');
    assert.equal(getScopeProvider('other').version, 'other');
  });
});

describe('script definitions carry one bundled code file', () => {
  const def = { id: 'test.script/one', protocol: { type: 'script', module: 'connector.js' } };
  const module = "import crypto from 'node:crypto';\nexport default { actions: {} };\n";

  it('accepts the entry module alone, with bare and built-in imports', () => {
    checkScriptCodeFiles(def, { 'integration.json': {}, 'connector.js': module, 'README.md': '' });
    checkScriptCodeFiles({ ...def, protocol: { type: 'openapi' } }, { 'lib.js': 'x', 'a.js': 'y' });
  });

  it('refuses a second code file, naming it', () => {
    assert.throws(
      () => checkScriptCodeFiles(def, { 'connector.js': module, 'lib.mjs': '', 'util/x.cjs': '' }),
      error =>
        error.code === 'SCRIPT_EXTRA_CODE_FILES' && /lib\.mjs, util\/x\.cjs/.test(error.message)
    );
  });

  it('refuses a relative import in any form, as a text check', () => {
    for (const line of [
      "import { x } from './lib.js';",
      "import '../side-effect.js';",
      "export * from './re-export.js';",
      "const lib = await import('./lib.js');",
      "const lib = require('../lib.cjs');",
      '// see ./notes.js: import "./notes.js"'
    ]) {
      assert.throws(
        () => checkScriptCodeFiles(def, { 'connector.js': `${line}\n${module}` }),
        error => error.code === 'SCRIPT_RELATIVE_IMPORT',
        line
      );
    }
  });

  it('is enforced when the folder is written', async () => {
    const files = {
      'integration.json': { ...scopedDefinition, id: 'test.script/one', scopes: undefined },
      'connector.js': module
    };
    await assert.rejects(
      registry.writeInstalled('test.script/one', { ...files, 'lib.js': '' }),
      error => error.code === 'SCRIPT_EXTRA_CODE_FILES'
    );
    await assert.rejects(
      registry.writeInstalled('test.script/one', {
        ...files,
        'connector.js': `import './lib.js';\n${module}`
      }),
      error => error.code === 'SCRIPT_RELATIVE_IMPORT'
    );
    assert.equal(registry.get('test.script/one'), null);
  });
});
