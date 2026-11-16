// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The label of `ihub.source.actions` (#3668): an installation is counted by its
 * catalog definition, a built-in provider by its own id, anything else as
 * `unknown`, so the label set is as small as the catalog and an id nobody
 * installed never becomes a label.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { documentProviderCategory } from '../services/integrations/documentAccess.js';

function withInstalled(t, installed) {
  const original = configCache.getIntegrations;
  configCache.getIntegrations = () => ({ data: { installed } });
  t.after(() => {
    configCache.getIntegrations = original;
  });
}

test('two installations of one definition share a label; the instance id is not one', t => {
  withInstalled(t, [
    { id: 'ifinder-munich', definition: 'com.intrafind/ifinder' },
    { id: 'ifinder-berlin', definition: 'com.intrafind/ifinder' }
  ]);
  assert.equal(documentProviderCategory('ifinder-munich'), 'com.intrafind/ifinder');
  assert.equal(documentProviderCategory('ifinder-berlin'), 'com.intrafind/ifinder');
});

test('a built-in provider is counted by its own id', t => {
  withInstalled(t, []);
  assert.equal(documentProviderCategory('project'), 'project');
});

test('an id nobody installed, and an installation without a definition, are unknown', t => {
  withInstalled(t, [{ id: 'odd' }]);
  assert.equal(documentProviderCategory('made-up-id-1'), 'unknown');
  assert.equal(documentProviderCategory('made-up-id-2'), 'unknown');
  assert.equal(documentProviderCategory('odd'), 'unknown');
});
