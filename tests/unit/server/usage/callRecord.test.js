// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import {
  buildCallRecord,
  buildFeedbackRecord,
  errorCodeOf,
  outcomeOf,
  reportGroupsOf,
  resolveSurface
} from '../../../../server/services/usage/callRecord.js';

describe('resolveSurface', () => {
  it('takes the surface the caller named', () => {
    expect(resolveSurface({ surface: 'agent' })).toBe('agent');
  });
  it('maps the magic prompt purpose', () => {
    expect(resolveSurface({ purpose: 'magic-prompt', kind: 'utility' })).toBe('magic');
  });
  it('treats a scheduled run as a task whatever ran it', () => {
    expect(resolveSurface({}, { kind: 'chat', trigger: { type: 'schedule' } })).toBe('task');
  });
  it('maps run kinds', () => {
    expect(resolveSurface({}, { kind: 'chat' })).toBe('chat');
    expect(resolveSurface({}, { kind: 'subagent' })).toBe('chat');
    expect(resolveSurface({}, { kind: 'agent' })).toBe('agent');
    expect(resolveSurface({}, { kind: 'workflow' })).toBe('workflow');
    expect(resolveSurface({}, { kind: 'inference' })).toBe('api');
    expect(resolveSurface({ kind: 'utility' })).toBe('system');
    expect(resolveSurface({})).toBe('system');
  });
});

describe('outcomeOf / errorCodeOf', () => {
  it('classifies errors', () => {
    expect(outcomeOf(null)).toBe('ok');
    expect(outcomeOf(null, { aborted: true })).toBe('aborted');
    expect(outcomeOf({ code: 'QUOTA_EXCEEDED' })).toBe('quota');
    expect(outcomeOf({ code: 'RATE_LIMITED' })).toBe('rate_limited');
    expect(outcomeOf({ code: 'ABORTED' })).toBe('aborted');
    expect(outcomeOf({ name: 'AbortError' })).toBe('aborted');
    expect(outcomeOf({ code: 'PROVIDER_ERROR' })).toBe('error');
  });
  it('keeps codes and drops messages', () => {
    expect(errorCodeOf(null)).toBe(null);
    expect(errorCodeOf({ code: 'TIMEOUT', message: 'secret prompt text' })).toBe('TIMEOUT');
    expect(errorCodeOf({ code: 'not a code!', message: 'x' })).toBe('UNKNOWN');
  });
});

describe('reportGroupsOf', () => {
  it('drops the implicit groups and duplicates', () => {
    expect(reportGroupsOf({ groups: ['sales', 'authenticated', 'anonymous', 'sales'] })).toEqual([
      'sales'
    ]);
    expect(reportGroupsOf(null)).toEqual([]);
  });
});

describe('buildCallRecord', () => {
  const base = {
    ts: '2026-11-04T10:00:00.000Z',
    surface: 'chat',
    uid: 'alice',
    groups: ['sales'],
    appId: 'chat',
    modelId: 'gpt',
    provider: 'openai',
    conversationId: 'c1',
    requestId: 'req-1',
    outcome: 'ok',
    latencyMs: 1234.4,
    ttftMs: 200,
    toolCalls: 2
  };

  it('writes a v2 llm_call record with provider usage', () => {
    const record = buildCallRecord({
      ...base,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        cacheReadTokens: 80,
        reasoningTokens: 5,
        source: 'provider'
      }
    });
    expect(record).toEqual({
      v: 2,
      ts: base.ts,
      type: 'llm_call',
      surf: 'chat',
      st: 'ok',
      pt: 100,
      ct: 20,
      src: 'provider',
      uid: 'alice',
      grp: ['sales'],
      app: 'chat',
      model: 'gpt',
      prov: 'openai',
      cid: 'c1',
      rid: 'req-1',
      cr: 80,
      rt: 5,
      lat: 1234,
      ttft: 200,
      tc: 2
    });
  });

  it('records a failed call without usage as zero estimated tokens and its code', () => {
    const record = buildCallRecord({
      ...base,
      uid: null,
      groups: [],
      usage: null,
      outcome: 'error',
      errorCode: 'TIMEOUT',
      ttftMs: null
    });
    expect(record).toMatchObject({ pt: 0, ct: 0, src: 'estimate', st: 'error', err: 'TIMEOUT' });
    expect(record).not.toHaveProperty('uid');
    expect(record).not.toHaveProperty('grp');
    expect(record).not.toHaveProperty('ttft');
    expect(record).not.toHaveProperty('cr');
  });

  it('falls back to system/error for unknown surfaces and outcomes', () => {
    const record = buildCallRecord({ ...base, surface: 'bogus', outcome: 'bogus', usage: null });
    expect(record.surf).toBe('system');
    expect(record.st).toBe('error');
  });
});

describe('buildFeedbackRecord', () => {
  it('writes a v2 feedback record', () => {
    expect(
      buildFeedbackRecord({
        ts: 't',
        uid: 'u',
        groups: ['g'],
        appId: 'a',
        modelId: 'm',
        rating: 4
      })
    ).toEqual({
      v: 2,
      ts: 't',
      type: 'feedback',
      uid: 'u',
      grp: ['g'],
      app: 'a',
      model: 'm',
      rating: 4
    });
  });
});
