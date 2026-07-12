/**
 * Unit tests for the default-model reconciliation helpers in modelsLoader.js.
 *
 * These consolidate logic that used to be re-implemented independently in
 * every admin models write handler (PUT/POST/toggle/batch-toggle/DELETE).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ensureOneDefaultModel,
  clearOtherDefaults,
  promoteNewDefault,
  ensureDefaultAmongEnabled
} from '../modelsLoader.js';

describe('modelsLoader default-model helpers', () => {
  describe('ensureOneDefaultModel', () => {
    it('promotes the first enabled model when none is default', () => {
      const models = [
        { id: 'a', enabled: false },
        { id: 'b', enabled: true },
        { id: 'c', enabled: true }
      ];
      ensureOneDefaultModel(models);
      assert.strictEqual(models.find(m => m.id === 'b').default, true);
      assert.ok(!models.find(m => m.id === 'c').default);
    });

    it('keeps only the first default when multiple are marked default', () => {
      const models = [
        { id: 'a', enabled: true, default: true },
        { id: 'b', enabled: true, default: true }
      ];
      ensureOneDefaultModel(models);
      assert.strictEqual(models.find(m => m.id === 'a').default, true);
      assert.strictEqual(models.find(m => m.id === 'b').default, false);
    });
  });

  describe('clearOtherDefaults', () => {
    it('clears default on every other model and returns only the changed ones', () => {
      const models = [
        { id: 'a', default: true },
        { id: 'b', default: false },
        { id: 'c', default: true }
      ];
      const changed = clearOtherDefaults(models, 'b');
      assert.deepStrictEqual(changed.map(m => m.id).sort(), ['a', 'c']);
      assert.strictEqual(models.find(m => m.id === 'a').default, false);
      assert.strictEqual(models.find(m => m.id === 'c').default, false);
    });

    it('returns an empty array when no other model is default', () => {
      const models = [{ id: 'a', default: true }];
      const changed = clearOtherDefaults(models, 'a');
      assert.deepStrictEqual(changed, []);
    });
  });

  describe('promoteNewDefault', () => {
    it('promotes the first other enabled model', () => {
      const models = [
        { id: 'a', enabled: true, default: true },
        { id: 'b', enabled: false },
        { id: 'c', enabled: true }
      ];
      const promoted = promoteNewDefault(models, 'a');
      assert.strictEqual(promoted.id, 'c');
      assert.strictEqual(models.find(m => m.id === 'c').default, true);
    });

    it('returns null when no other enabled model exists', () => {
      const models = [{ id: 'a', enabled: true, default: true }];
      const promoted = promoteNewDefault(models, 'a');
      assert.strictEqual(promoted, null);
    });
  });

  describe('ensureDefaultAmongEnabled', () => {
    it('promotes the first enabled model when none is default', () => {
      const models = [
        { id: 'a', enabled: false, default: false },
        { id: 'b', enabled: true, default: false },
        { id: 'c', enabled: true, default: false }
      ];
      const promoted = ensureDefaultAmongEnabled(models);
      assert.strictEqual(promoted.id, 'b');
      assert.strictEqual(models.find(m => m.id === 'b').default, true);
    });

    it('does nothing when an enabled model is already default', () => {
      const models = [
        { id: 'a', enabled: true, default: true },
        { id: 'b', enabled: true, default: false }
      ];
      const promoted = ensureDefaultAmongEnabled(models);
      assert.strictEqual(promoted, null);
      assert.strictEqual(models.find(m => m.id === 'b').default, false);
    });

    it('returns null when no model is enabled', () => {
      const models = [{ id: 'a', enabled: false, default: false }];
      const promoted = ensureDefaultAmongEnabled(models);
      assert.strictEqual(promoted, null);
    });
  });
});
