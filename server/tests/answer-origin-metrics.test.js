// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The counters of where an answer came from (#3668): call outcome and origin,
 * kinds per answer, footer/Sources mismatch, source opens. Every label is a
 * member of a closed set, so a stray value cannot create a new series.
 */
import { jest } from '@jest/globals';
import {
  initializeMetrics,
  recordToolCall,
  recordAnswerBasis,
  recordAnswerOriginMismatch,
  recordSourceAction
} from '../telemetry/metrics.js';
import {
  originsMissingFromBasis,
  recordAnswerOriginMetrics,
  toolCallOutcomeOf
} from '../services/chat/answerOriginMetrics.js';

function fakeMeter() {
  const counters = {};
  const meter = {
    createHistogram: () => ({ record: jest.fn() }),
    createCounter: name => {
      counters[name] = { add: jest.fn() };
      return counters[name];
    },
    createUpDownCounter: () => ({ add: () => {} }),
    createObservableGauge: () => ({ addCallback: () => {} })
  };
  return { provider: { getMeter: () => meter }, counters };
}

let fake;
beforeEach(() => {
  fake = fakeMeter();
  initializeMetrics(fake.provider);
});

const added = name => fake.counters[name].add.mock.calls.map(([value, labels]) => [value, labels]);

describe('ihub.tool.calls', () => {
  test('counts a call by where it looked and what it came to', () => {
    recordToolCall('web', 'results');
    recordToolCall('project', 'empty');
    expect(added('ihub.tool.calls')).toEqual([
      [1, { 'tool.origin': 'web', 'tool.outcome': 'results' }],
      [1, { 'tool.origin': 'project', 'tool.outcome': 'empty' }]
    ]);
  });

  test('a call the server could not place is `none`, and a stray value cannot make a series', () => {
    recordToolCall(undefined, 'results');
    recordToolCall('anything-else', 'whatever');
    expect(added('ihub.tool.calls')).toEqual([
      [1, { 'tool.origin': 'none', 'tool.outcome': 'results' }],
      [1, { 'tool.origin': 'none', 'tool.outcome': 'unknown' }]
    ]);
  });

  test('the outcome is the server-declared count: an empty list alone is not "empty"', () => {
    expect(toolCallOutcomeOf({ resultCount: 3 }, {})).toBe('results');
    expect(toolCallOutcomeOf({ resultCount: 0 }, {})).toBe('empty');
    expect(toolCallOutcomeOf({ readOutcome: 'opened' }, {})).toBe('results');
    expect(toolCallOutcomeOf({ readOutcome: 'empty' }, {})).toBe('empty');
    expect(toolCallOutcomeOf({ sources: { items: [] } }, {})).toBe('unknown');
    expect(toolCallOutcomeOf({ resultCount: 3 }, { failed: true })).toBe('error');
    expect(toolCallOutcomeOf({ error: new Error('x') }, {})).toBe('error');
  });
});

describe('ihub.answer.basis and ihub.answer.origin.mismatch', () => {
  test('buckets an answer by the kinds its basis names; the model alone is none', () => {
    recordAnswerOriginMetrics([{ kind: 'model' }], undefined);
    recordAnswerOriginMetrics([{ kind: 'web' }], undefined);
    recordAnswerOriginMetrics([{ kind: 'web' }, { kind: 'project' }], undefined);
    recordAnswerOriginMetrics(
      [{ kind: 'web' }, { kind: 'project' }, { kind: 'ifinder' }, { kind: 'integration' }],
      undefined
    );
    expect(added('ihub.answer.basis').map(([, labels]) => labels['answer.kinds_bucket'])).toEqual([
      '0',
      '1',
      '2',
      '3+'
    ]);
  });

  test('a source of an origin the basis leaves out is a mismatch', () => {
    const sources = { items: [{ origin: { kind: 'web' } }, { origin: { kind: 'project' } }] };
    expect(originsMissingFromBasis([{ kind: 'web' }], sources)).toEqual(['project']);
    expect(originsMissingFromBasis([{ kind: 'web' }, { kind: 'project' }], sources)).toEqual([]);
    recordAnswerOriginMetrics([{ kind: 'web' }], sources);
    recordAnswerOriginMetrics([{ kind: 'web' }, { kind: 'project' }], sources);
    expect(added('ihub.answer.origin.mismatch')).toEqual([[1, undefined]]);
  });

  test('sources without an origin, or none at all, are never a mismatch', () => {
    expect(originsMissingFromBasis([{ kind: 'web' }], { items: [{ title: 'old' }] })).toEqual([]);
    expect(originsMissingFromBasis([{ kind: 'web' }], undefined)).toEqual([]);
  });

  test('the recorders keep working with the meter missing, and never throw', () => {
    initializeMetrics(null);
    expect(() => recordAnswerBasis(2)).not.toThrow();
    expect(() => recordAnswerOriginMismatch()).not.toThrow();
    expect(() => recordAnswerOriginMetrics(null, null)).not.toThrow();
  });
});

describe('ihub.source.actions', () => {
  test('counts an open by provider and action; the action is one of two', () => {
    recordSourceAction('com.intrafind/ifinder', 'content');
    recordSourceAction('project', 'details');
    recordSourceAction('project', 'delete-everything');
    expect(added('ihub.source.actions')).toEqual([
      [1, { 'source.provider': 'com.intrafind/ifinder', 'source.action': 'content' }],
      [1, { 'source.provider': 'project', 'source.action': 'details' }],
      [1, { 'source.provider': 'project', 'source.action': 'content' }]
    ]);
  });

  test('a long or missing provider cannot make an unbounded label', () => {
    recordSourceAction('x'.repeat(500), 'content');
    recordSourceAction('', 'content');
    const [[, first], [, second]] = added('ihub.source.actions');
    expect(first['source.provider']).toHaveLength(64);
    expect(second['source.provider']).toBe('unknown');
  });
});
