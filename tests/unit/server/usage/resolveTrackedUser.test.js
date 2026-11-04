// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../../../../server/services/UserFingerprint.js', () => ({
  resolveUserId: async (id, mode) => (mode === 'anonymous' && id ? `usr_${id}` : id)
}));
jest.mock('../../../../server/services/UsageEventLog.js', () => ({ logUsageEvent: () => {} }));
jest.mock('../../../../server/utils/sharedJsonFile.js', () => ({
  createSharedJsonFile: () => ({ read: async () => ({}), update: async () => {} })
}));
jest.mock('../../../../server/utils/contentsPath.js', () => ({
  getContentsPath: (...s) => `/tmp/${s.join('/')}`
}));
jest.mock('../../../../shared/tokenEstimator.js', () => ({ estimateTokens: () => 0 }));
jest.mock('../../../../server/telemetry.js', () => ({ recordTokenUsage: () => {} }));
jest.mock('../../../../server/telemetry/metrics.js', () => ({
  recordMagicPromptUsage: () => {},
  recordFeedbackEvent: () => {}
}));
jest.mock('../../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

import { resolveTrackedUser } from '../../../../server/usageTracker.js';

const user = { id: 'alice' };

describe('resolveTrackedUser', () => {
  it('uses the real user id in identified mode, not the chat session', async () => {
    await expect(resolveTrackedUser({ sessionId: 'chat-1', user }, 'identified')).resolves.toBe(
      'alice'
    );
  });

  it('fingerprints the real user id in anonymous mode', async () => {
    const a = await resolveTrackedUser({ sessionId: 'chat-1', user }, 'anonymous');
    const b = await resolveTrackedUser({ sessionId: 'chat-2', user }, 'anonymous');
    expect(a).toBe('usr_alice');
    expect(b).toBe(a);
  });

  it('keeps the session id in pseudonymous mode', async () => {
    await expect(resolveTrackedUser({ sessionId: 'chat-1', user }, 'pseudonymous')).resolves.toBe(
      'chat-1'
    );
  });

  it('falls back to the session id without a user', async () => {
    await expect(resolveTrackedUser({ sessionId: 'chat-1' }, 'identified')).resolves.toBe('chat-1');
  });
});
