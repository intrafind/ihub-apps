/**
 * The admin switch of structure-preserving document extraction
 * (concepts/document-extraction/): `structuredDocumentExtraction` is declared in the feature
 * registry, on by default, and listed under "Content" in Admin → Features without a migration.
 *
 * Run: node --test server/tests/document-extraction-feature.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { featureRegistry, featureCategories, resolveFeatures } from '../featureRegistry.js';

const ID = 'structuredDocumentExtraction';

describe('structuredDocumentExtraction feature', () => {
  const entry = featureRegistry.find(feature => feature.id === ID);

  it('T-FLAG-01: is registered, in a known category, on by default and not a preview', () => {
    assert.ok(entry, 'registry entry exists');
    assert.equal(entry.default, true);
    assert.equal(entry.category, 'content');
    assert.ok(featureCategories[entry.category]);
    assert.notEqual(entry.preview, true);
    for (const language of ['en', 'de']) {
      assert.ok(entry.name[language], `name.${language}`);
      assert.ok(entry.description[language], `description.${language}`);
    }
  });

  it('T-FLAG-01: resolves to enabled without a saved value and honors an explicit off', () => {
    const enabled = id => resolveFeatures({}).find(feature => feature.id === id).enabled;
    assert.equal(enabled(ID), true);
    const off = resolveFeatures({ [ID]: false }).find(feature => feature.id === ID);
    assert.equal(off.enabled, false);
  });

  it('keeps feature ids unique', () => {
    const ids = featureRegistry.map(feature => feature.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
