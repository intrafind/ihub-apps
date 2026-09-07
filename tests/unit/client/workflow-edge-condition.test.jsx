import { describe, it, expect } from '@jest/globals';
import { coerceLiteral } from '../../../client/src/features/workflows/editor/panels/EdgeConfigPanel.jsx';
import { DAGScheduler } from '../../../server/services/workflow/DAGScheduler.js';

describe('coerceLiteral', () => {
  it('types the literals a comparison actually needs', () => {
    expect(coerceLiteral('3')).toBe(3);
    expect(coerceLiteral('-2.5')).toBe(-2.5);
    expect(coerceLiteral('true')).toBe(true);
    expect(coerceLiteral('false')).toBe(false);
    expect(coerceLiteral('null')).toBeNull();
  });

  it('leaves anything that is not a clean literal as text', () => {
    expect(coerceLiteral('error')).toBe('error');
    expect(coerceLiteral('1.2.3')).toBe('1.2.3');
    expect(coerceLiteral('12px')).toBe('12px');
    expect(coerceLiteral('True')).toBe('True');
    expect(coerceLiteral('')).toBe('');
  });
});

describe('the coerced value matches how the engine compares', () => {
  const scheduler = new DAGScheduler();

  const followed = (value, data) =>
    scheduler.evaluateCondition(
      { condition: { type: 'equals', field: 'data.count', value } },
      null,
      { data }
    );

  it('follows an edge comparing against a number', () => {
    // The engine uses strict equality, so an uncoerced '3' would never match.
    expect(followed(coerceLiteral('3'), { count: 3 })).toBe(true);
    expect(followed('3', { count: 3 })).toBe(false);
  });

  it('follows an edge comparing against a boolean', () => {
    expect(
      scheduler.evaluateCondition(
        { condition: { type: 'equals', field: 'data.done', value: coerceLiteral('true') } },
        null,
        { data: { done: true } }
      )
    ).toBe(true);
  });

  it('still matches plain text exactly', () => {
    expect(
      scheduler.evaluateCondition(
        { condition: { type: 'equals', field: 'data.status', value: coerceLiteral('error') } },
        null,
        { data: { status: 'error' } }
      )
    ).toBe(true);
  });
});
