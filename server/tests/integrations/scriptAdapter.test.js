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
const { default: registry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const adapter = await import('../../services/integrations/protocols/native/NativeAdapter.js');
const { getProtocolAdapter } = await import('../../services/integrations/protocols/index.js');

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
