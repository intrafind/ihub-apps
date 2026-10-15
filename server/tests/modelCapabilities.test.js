import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_SUPPORT,
  TOOL_SUPPORT_VALUES,
  matchesModelFilter,
  modelCanRequireToolUse,
  modelSupportsTools
} from '../../shared/modelCapabilities.js';

describe('tool support levels', () => {
  it('has three states', () => {
    assert.deepEqual([...TOOL_SUPPORT_VALUES], ['none', 'auto', 'required']);
  });

  it('modelSupportsTools is true for auto and required only', () => {
    assert.equal(modelSupportsTools({ supportsTools: 'auto' }), true);
    assert.equal(modelSupportsTools({ supportsTools: 'required' }), true);
    assert.equal(modelSupportsTools({ supportsTools: 'none' }), false);
    // "none" is a non-empty string: a truthiness check would let it through.
    assert.equal(Boolean(TOOL_SUPPORT.NONE), true);
  });

  it('is false for a model without the setting, or without a model', () => {
    assert.equal(modelSupportsTools({}), false);
    assert.equal(modelSupportsTools(undefined), false);
    assert.equal(modelSupportsTools({ supportsTools: true }), false);
  });

  it('modelCanRequireToolUse is true for required only', () => {
    assert.equal(modelCanRequireToolUse({ supportsTools: 'required' }), true);
    assert.equal(modelCanRequireToolUse({ supportsTools: 'auto' }), false);
    assert.equal(modelCanRequireToolUse({ supportsTools: 'none' }), false);
    assert.equal(modelCanRequireToolUse(undefined), false);
  });
});

describe('matchesModelFilter', () => {
  const model = { supportsTools: 'auto', supportsVision: true };

  it('keeps every model when there is no filter', () => {
    assert.equal(matchesModelFilter(model, undefined), true);
    assert.equal(matchesModelFilter(model, {}), true);
    assert.equal(matchesModelFilter(model, []), true);
  });

  it('compares a property to the value as is', () => {
    assert.equal(matchesModelFilter(model, { supportsVision: true }), true);
    assert.equal(matchesModelFilter(model, { supportsVision: false }), false);
    assert.equal(matchesModelFilter(model, { supportsTools: 'auto' }), true);
    assert.equal(matchesModelFilter(model, { supportsTools: 'required' }), false);
  });

  it('accepts any entry of an array', () => {
    assert.equal(matchesModelFilter(model, { supportsTools: ['auto', 'required'] }), true);
    assert.equal(
      matchesModelFilter({ supportsTools: 'none' }, { supportsTools: ['auto', 'required'] }),
      false
    );
  });

  it('needs every key to match', () => {
    assert.equal(
      matchesModelFilter(model, { supportsTools: ['auto', 'required'], supportsVision: false }),
      false
    );
  });
});
