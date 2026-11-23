// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest } from '@jest/globals';

// Same stubs as loopContainerBody.test.js: the condition evaluator never
// touches the prompt service or the executor registry.
jest.mock('../../../../server/services/PromptService.js', () => ({
  __esModule: true,
  default: {}
}));
jest.mock('../../../../server/services/workflow/executors/index.js', () => ({
  __esModule: true,
  getExecutor: () => ({ async execute() {} })
}));

import { LoopNodeExecutor } from '../../../../server/services/workflow/executors/LoopNodeExecutor.js';

describe('LoopNodeExecutor.evaluateCondition sandbox', () => {
  const executor = new LoopNodeExecutor();

  it('evaluates conditions against a copy of data and index', () => {
    expect(executor.evaluateCondition('data.count < 3', { count: 2 }, 0)).toBe(true);
    expect(executor.evaluateCondition('data.count < 3', { count: 3 }, 0)).toBe(false);
    expect(
      executor.evaluateCondition('index === 4 && data.items.length === 2', { items: [1, 2] }, 4)
    ).toBe(true);
  });

  it('does not let the condition mutate the caller state', () => {
    const data = { count: 1 };
    executor.evaluateCondition('data.count = 99; true', data, 0);
    expect(data.count).toBe(1);
  });

  it('stops the loop (false) on a syntax error or a runaway condition', () => {
    expect(executor.evaluateCondition('data.count <', { count: 1 }, 0)).toBe(false);
    expect(executor.evaluateCondition('while (true) {}', {}, 0)).toBe(false);
  });

  it('gives the condition no way to reach the host through data', () => {
    const escape = "data.constructor.constructor('return typeof process')() === 'undefined'";
    expect(executor.evaluateCondition(escape, { nested: { a: 1 } }, 0)).toBe(true);
    const escapeNested =
      "data.nested.constructor.constructor('return typeof process')() === 'undefined'";
    expect(executor.evaluateCondition(escapeNested, { nested: { a: 1 } }, 0)).toBe(true);
    expect(executor.evaluateCondition("typeof process === 'undefined'", {}, 0)).toBe(true);
  });
});
