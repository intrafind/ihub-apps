// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A marketplace integration that is not on this server yet appears on the
 * Catalog tab as an entry the tile can render and install from its registry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { marketplaceEntryView } from '../../services/integrations/definitions/marketplaceDefinitions.js';

const item = {
  type: 'integration',
  name: 'mcp__github',
  displayName: { en: 'GitHub', de: 'GitHub' },
  description: { en: 'Work with repositories.', de: 'Mit Repositories arbeiten.' },
  version: '1.0.0',
  compatibility: { ihub: '>=5.6.0' },
  releases: [{ version: '1.0.0' }],
  author: 'GitHub',
  category: 'coding',
  icon: 'code',
  facts: { protocol: 'mcp', authModes: ['service-account'], runs: 'cloud', actionCount: null }
};
const registry = { id: 'ihub-official', name: 'iHub Official Marketplace' };

describe('marketplaceEntryView', () => {
  it('maps a catalog item to a Catalog-tab entry', () => {
    const view = marketplaceEntryView(item, 'mcp/github', registry, 'de');
    assert.equal(view.id, 'mcp/github');
    assert.equal(view.source, 'marketplace');
    assert.deepEqual(view.marketplace, {
      registryId: 'ihub-official',
      registryName: 'iHub Official Marketplace',
      name: 'mcp__github'
    });
    assert.equal(view.description, 'Mit Repositories arbeiten.');
    assert.equal(view.protocol, 'mcp');
    assert.equal(view.supported, true);
    assert.equal(view.dynamicActions, true);
    assert.equal(view.actionCount, null);
    assert.equal(view.builtIn, false);
    assert.deepEqual(view.installedInstances, []);
    assert.equal(view.compatible, true);
  });

  it('marks an item this server cannot run as incompatible', () => {
    const view = marketplaceEntryView(
      { ...item, compatibility: { ihub: '>=99.0.0' } },
      'mcp/github',
      registry,
      'en'
    );
    assert.equal(view.compatible, false);
    assert.equal(view.status, 'incompatible');
    assert.ok(view.statusReason);
  });

  it('is unsupported without screened facts', () => {
    const view = marketplaceEntryView({ ...item, facts: null }, 'mcp/github', registry, 'en');
    assert.equal(view.protocol, null);
    assert.equal(view.supported, false);
  });
});
