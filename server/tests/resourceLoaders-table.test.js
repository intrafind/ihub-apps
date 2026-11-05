// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RESOURCE_LOADERS, loadResources } from '../resourceLoaders.js';
import { compareByOrderThenName, nameOf } from '../utils/resourceLoader.js';

describe('RESOURCE_LOADERS', () => {
  it('names a directory, a log name and a validator for every resource', () => {
    assert.deepEqual(Object.keys(RESOURCE_LOADERS), [
      'apps',
      'models',
      'prompts',
      'workflows',
      'agents',
      'tools',
      'projects'
    ]);
    for (const spec of Object.values(RESOURCE_LOADERS)) {
      assert.equal(typeof spec.resourceName, 'string');
      assert.equal(typeof spec.directory, 'string');
      assert.equal(typeof spec.validateItem, 'function');
    }
  });

  it('refuses an unknown resource', () => {
    assert.throws(() => loadResources('nope'), /Unknown resource: nope/);
  });

  it('sorts projects by name alone, ignoring `order`', () => {
    const { sortComparator } = RESOURCE_LOADERS.projects;
    const sorted = [
      { id: 'b', name: 'Beta', order: 1 },
      { id: 'a', name: 'Alpha', order: 2 }
    ].sort(sortComparator);
    assert.deepEqual(
      sorted.map(p => p.id),
      ['a', 'b']
    );
  });

  it('keeps exactly one default model, and a chat one', () => {
    const models = [
      { id: 'tts', enabled: true, default: true, modelType: 'tts' },
      { id: 'chat-a', enabled: true },
      { id: 'chat-b', enabled: true, default: true },
      { id: 'chat-c', enabled: true, default: true }
    ];
    const result = RESOURCE_LOADERS.models.postProcess(models);
    assert.deepEqual(
      result.filter(m => m.default).map(m => m.id),
      ['chat-b']
    );
  });
});

describe('compareByOrderThenName', () => {
  it('orders by `order` first, items without one last, then by name', () => {
    const items = [
      { id: 'z', name: 'Zed' },
      { id: 'b', name: { de: 'Bee', en: 'Bee' }, order: 2 },
      { id: 'a', name: 'Ay', order: 2 },
      { id: 'c', name: 'Cee', order: 1 }
    ];
    assert.deepEqual(
      items.sort(compareByOrderThenName).map(i => i.id),
      ['c', 'a', 'b', 'z']
    );
  });

  it('names a resource by its English name, else its first, else its id', () => {
    assert.equal(nameOf({ name: { de: 'Eins', en: 'One' } }), 'One');
    assert.equal(nameOf({ name: { de: 'Eins' } }), 'Eins');
    assert.equal(nameOf({ id: 'x' }), 'x');
  });
});
