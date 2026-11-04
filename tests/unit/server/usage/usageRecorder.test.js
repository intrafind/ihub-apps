// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

let mockPlatform = {};
let mockFeatures = {};
const mockAppended = [];

jest.mock('../../../../server/configCache.js', () => ({
  __esModule: true,
  default: { getPlatform: () => mockPlatform, getFeatures: () => mockFeatures }
}));
jest.mock('../../../../server/featureRegistry.js', () => ({
  isFeatureEnabled: (id, features) => features[id] ?? true
}));
jest.mock('../../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
jest.mock('../../../../server/telemetry.js', () => ({ recordTokenUsage: () => {} }));
jest.mock('../../../../server/telemetry/metrics.js', () => ({ recordFeedbackEvent: () => {} }));
jest.mock('../../../../server/services/UserFingerprint.js', () => ({
  fingerprint: async id => `usr_${id}`,
  fingerprintConversation: async id => `conv_${id}`
}));
jest.mock('../../../../server/services/UsageEventLog.js', () => ({
  appendUsageRecord: record => mockAppended.push(record)
}));
jest.mock('../../../../server/services/quota/quotaService.js', () => ({
  quotaUserKey: user => (user?.id && user.id !== 'anonymous' ? String(user.id) : 'anonymous')
}));

import {
  recordLlmCall,
  recordFeedback,
  resolveIdentity
} from '../../../../server/services/usage/usageRecorder.js';

const user = { id: 'alice', groups: ['sales', 'authenticated'] };
const call = {
  user,
  surface: 'chat',
  appId: 'chat',
  modelId: 'gpt',
  provider: 'openai',
  conversationId: 'chat-1',
  usage: { promptTokens: 10, completionTokens: 2, source: 'provider' },
  outcome: 'ok',
  latencyMs: 50,
  toolCalls: 0
};

beforeEach(() => {
  mockAppended.length = 0;
  mockPlatform = {};
  mockFeatures = {};
});

describe('resolveIdentity', () => {
  it('identified: the real user and conversation', async () => {
    await expect(
      resolveIdentity({ user, conversationId: 'c', mode: 'identified' })
    ).resolves.toEqual({ uid: 'alice', cid: 'c' });
  });
  it('anonymous: fingerprints of both, the same for every chat of a user', async () => {
    await expect(
      resolveIdentity({ user, conversationId: 'c', mode: 'anonymous' })
    ).resolves.toEqual({ uid: 'usr_alice', cid: 'conv_c' });
  });
  it('pseudonymous: the session stands in for the user', async () => {
    await expect(
      resolveIdentity({ user, conversationId: 'c', mode: 'pseudonymous' })
    ).resolves.toEqual({ uid: 'c', cid: 'c' });
  });
  it('no user: no uid', async () => {
    await expect(
      resolveIdentity({ user: null, conversationId: 'c', mode: 'identified' })
    ).resolves.toEqual({ uid: null, cid: 'c' });
  });
});

describe('recordLlmCall', () => {
  it('writes a v2 record with the groups at call time', async () => {
    mockPlatform = { features: { usageTrackingMode: 'identified' } };
    const record = await recordLlmCall(call);
    expect(mockAppended).toHaveLength(1);
    expect(record).toMatchObject({
      v: 2,
      type: 'llm_call',
      uid: 'alice',
      grp: ['sales'],
      cid: 'chat-1',
      surf: 'chat',
      st: 'ok',
      pt: 10,
      ct: 2
    });
  });

  it('writes nothing when usage tracking is off', async () => {
    mockFeatures = { usageTracking: false };
    await expect(recordLlmCall(call)).resolves.toBe(null);
    expect(mockAppended).toHaveLength(0);
  });

  it('never throws', async () => {
    await expect(recordLlmCall(null)).resolves.toBe(null);
  });
});

describe('recordFeedback', () => {
  it('writes a feedback record', async () => {
    mockPlatform = { features: { usageTrackingMode: 'anonymous' } };
    const record = await recordFeedback({ user, appId: 'chat', modelId: 'gpt', rating: 5 });
    expect(record).toMatchObject({ type: 'feedback', uid: 'usr_alice', rating: 5, grp: ['sales'] });
  });
});
