// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeEach } from '@jest/globals';
import { scratchDocuments } from './helpers/testStorage.js';

const scratch = await scratchDocuments();
const { IntegrationConnectionService, connectionIdFor } =
  await import('../services/integrations/auth/IntegrationConnectionService.js');

/**
 * `updateConnection` merges a patch into a record. The merge used to be written
 * unconditionally over whatever was stored, so a `lastUsedAt` touch computed from
 * an old copy erased a status another worker had just written (`expired`, revoked,
 * an error). It is now written only over the document it was computed from.
 */
describe('IntegrationConnectionService.updateConnection', () => {
  let service;
  let id;

  beforeEach(async () => {
    await scratch.reset();
    service = new IntegrationConnectionService({ documents: scratch.documents, audit: () => {} });
    id = connectionIdFor('g1', { type: 'user', id: 'ada' });
    await service.createConnection({
      id,
      integration: 'g1',
      principal: { type: 'user', id: 'ada' },
      kind: 'oauth-user',
      status: 'active',
      secretRef: 'tokenstore:g1/ada'
    });
  });

  it('keeps a status written between its read and its write', async () => {
    const docs = scratch.documents;
    const realGet = docs.get.bind(docs);
    let raced = false;
    docs.get = async (...args) => {
      const doc = await realGet(...args);
      if (!raced) {
        raced = true;
        // Another worker marks the connection expired after this read.
        await service.putConnection({ ...doc.data, status: 'expired', error: 'refresh_failed' });
      }
      return doc;
    };
    try {
      await service.updateConnection(id, { lastUsedAt: '2026-01-01T00:00:00.000Z' });
    } finally {
      docs.get = realGet;
    }

    const stored = await service.getConnection(id);
    expect(stored.status).toBe('expired');
    expect(stored.error).toBe('refresh_failed');
    expect(stored.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is a no-op for a record that does not exist', async () => {
    expect(
      await service.updateConnection('conn_' + 'a'.repeat(16), { status: 'active' })
    ).toBeNull();
  });
});
