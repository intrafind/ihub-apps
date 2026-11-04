// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../../../../server/configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => ({}),
    getModels: () => ({ data: [] }),
    getGroups: () => ({ data: { groups: {} } })
  }
}));
jest.mock('../../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
jest.mock('../../../../server/utils/authorization.js', () => ({
  enhanceUserGroups: user => user,
  enhanceUserWithPermissions: user => user,
  getDefaultAnonymousGroups: () => ['anonymous']
}));
jest.mock('../../../../server/services/chatFiles/ChatFileRepository.js', () => ({
  getChatFileRepository: () => ({ isAvailable: () => false })
}));
jest.mock('../../../../server/services/chat/chatOwner.js', () => ({
  GUEST_OWNER_PREFIX: 'guest:',
  resolveChatOwner: async () => null
}));
jest.mock('../../../../server/services/loop/RunLog.js', () => ({
  __esModule: true,
  default: { identityMode: () => 'default' }
}));
jest.mock('../../../../server/services/quota/limitResolver.js', () => ({ isLimited: () => true }));
jest.mock('../../../../server/services/quota/resetSchedule.js', () => ({
  WINDOWS: ['day', 'week', 'month']
}));

const mockLedgerUsers = [
  { userKey: 'alice', name: 'Alice', groups: ['sales'] },
  { userKey: 'bob', name: 'Bob', groups: ['it'] },
  { userKey: 'carol', name: 'Carol', groups: [] }
];
const mockBuckets = {
  alice: [
    { id: 'allModels:month', used: 85, limit: 100, resetAt: '2026-12-01T00:00:00.000Z' },
    { id: 'allModels:day', used: 10, limit: 100, resetAt: '2026-11-05T00:00:00.000Z' }
  ],
  bob: [{ id: 'model:gpt:day', used: 120, limit: 100, resetAt: '2026-11-05T00:00:00.000Z' }],
  carol: [{ id: 'model:gpt:day', used: 5, limit: 0, resetAt: '2026-11-05T00:00:00.000Z' }]
};
jest.mock('../../../../server/services/quota/QuotaLedger.js', () => ({
  getQuotaLedger: () => ({ listUsers: async () => mockLedgerUsers })
}));
jest.mock('../../../../server/services/quota/quotaService.js', () => ({
  WARNING_THRESHOLD: 0.8,
  getCurrentWindows: () => ({}),
  usersMap: () => ({}),
  getUserLimits: () => ({ fileStorageBytes: {} }),
  buildBuckets: ({ counts }) => mockBuckets[counts.userKey] || []
}));

import { listNearLimitUsers } from '../../../../server/services/quota/quotaAdmin.js';

describe('listNearLimitUsers', () => {
  it('lists buckets at or above 80 %, soonest reset first', async () => {
    const result = await listNearLimitUsers();
    expect(result.threshold).toBe(0.8);
    expect(result.items.map(i => [i.userKey, i.bucket.id])).toEqual([
      ['bob', 'model:gpt:day'],
      ['alice', 'allModels:month']
    ]);
    expect(result.items[0]).toMatchObject({ name: 'Bob', groups: ['it'] });
  });

  it('takes another threshold and a row limit', async () => {
    const result = await listNearLimitUsers({ threshold: 0.05, limit: 2 });
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
    // A blocked model (limit 0) is not "near" a limit.
    expect(result.items.some(i => i.userKey === 'carol')).toBe(false);
  });
});
