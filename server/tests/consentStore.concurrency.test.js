// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest, describe, it, expect, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Concurrent changes to the OAuth consent store.
 *
 * Every change used to be a synchronous load followed by a save with no lock:
 * concurrent grants overwrote each other, a revoke between the load and the save
 * of a `touchConsentLastUsed` (run on every refresh rotation) was resurrected,
 * and an unreadable file turned into an empty store that the next write persisted.
 */

const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-store-'));
const storeFile = path.join(contentsDir, 'data', 'oauth-consent.json');

jest.unstable_mockModule('../utils/contentsPath.js', () => ({
  getContentsPath: (...segments) => path.join(contentsDir, ...segments)
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { grantConsent, revokeConsent, revokeConsentsForUser, touchConsentLastUsed, hasConsent } =
  await import('../utils/consentStore.js');

const onDisk = () => JSON.parse(fs.readFileSync(storeFile, 'utf8')).consents;

beforeEach(() => {
  fs.rmSync(path.join(contentsDir, 'data'), { recursive: true, force: true });
});
afterAll(() => {
  fs.rmSync(contentsDir, { recursive: true, force: true });
});

describe('consent store under concurrent changes', () => {
  it('keeps every grant made at the same time', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => grantConsent('c1', `user-${i}`, ['openid']))
    );
    expect(Object.keys(onDisk())).toHaveLength(10);
  });

  it('a touch racing a revoke does not resurrect the consent', async () => {
    for (let i = 0; i < 10; i++) {
      await grantConsent('c1', 'alice', ['openid']);
      await Promise.all([touchConsentLastUsed('c1', 'alice'), revokeConsent('c1', 'alice')]);
      expect(hasConsent('c1', 'alice', ['openid'])).toBe(false);
      expect(onDisk()['c1:alice']).toBeUndefined();
    }
  });

  it('a user-wide revoke racing a grant leaves no stale or lost entry', async () => {
    await grantConsent('c1', 'bob', ['openid']);
    await Promise.all([revokeConsentsForUser('bob'), grantConsent('c2', 'carol', ['openid'])]);
    const consents = onDisk();
    expect(consents['c1:bob']).toBeUndefined();
    expect(consents['c2:carol']).toBeDefined();
  });

  it('does not overwrite an unreadable store with an empty one', async () => {
    await grantConsent('c1', 'alice', ['openid']);
    fs.writeFileSync(storeFile, '{ not json');

    await expect(grantConsent('c1', 'bob', ['openid'])).rejects.toThrow();
    await expect(revokeConsent('c1', 'alice')).rejects.toThrow();
    expect(fs.readFileSync(storeFile, 'utf8')).toBe('{ not json');
    // reads fail closed
    expect(hasConsent('c1', 'alice', ['openid'])).toBe(false);
  });
});
