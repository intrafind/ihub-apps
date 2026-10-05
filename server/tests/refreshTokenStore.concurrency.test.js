import { jest, describe, it, expect, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Concurrent changes to the refresh token store.
 *
 * Every change is a read-modify-write of one file, made by whichever cluster
 * worker received the request, with a bcrypt hash in the middle. Without a
 * lock, rotations overwrote each other — an issued token vanished and the
 * client's next refresh failed — and a token could be redeemed twice. The lock
 * is a file, so concurrent calls in one process exercise it the same way two
 * workers do.
 */

const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-tokens-'));
const storeFile = path.join(contentsDir, 'data', 'oauth-refresh-tokens.json');

jest.unstable_mockModule('../utils/contentsPath.js', () => ({
  getContentsPath: (...segments) => path.join(contentsDir, ...segments)
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const {
  generateRefreshToken,
  storeRefreshToken,
  consumeRefreshToken,
  revokeRefreshTokensFor,
  listRefreshTokenUserIds
} = await import('../utils/refreshTokenStore.js');

const tokensOnDisk = () => Object.keys(JSON.parse(fs.readFileSync(storeFile, 'utf8')).tokens);

afterAll(() => {
  fs.rmSync(contentsDir, { recursive: true, force: true });
});

describe('refresh token store under concurrent changes', () => {
  it('keeps every token issued at the same time', async () => {
    const tokens = Array.from({ length: 8 }, () => generateRefreshToken());

    await Promise.all(
      tokens.map((token, i) => storeRefreshToken(token, { clientId: 'c1', userId: `user-${i}` }))
    );

    expect(tokensOnDisk()).toHaveLength(8);
    expect(listRefreshTokenUserIds('c1').sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `user-${i}`).sort()
    );
  });

  it('lets exactly one of several concurrent redemptions of a token succeed', async () => {
    const token = generateRefreshToken();
    await storeRefreshToken(token, { clientId: 'c2', userId: 'alice' });

    const results = await Promise.all(Array.from({ length: 4 }, () => consumeRefreshToken(token)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ clientId: 'c2', userId: 'alice' });
  });

  it('does not lose a token issued while another one is redeemed (rotation)', async () => {
    const old = generateRefreshToken();
    await storeRefreshToken(old, { clientId: 'c3', userId: 'bob' });
    const fresh = generateRefreshToken();

    const [consumed] = await Promise.all([
      consumeRefreshToken(old),
      storeRefreshToken(fresh, { clientId: 'c3', userId: 'carol' })
    ]);

    expect(consumed).toMatchObject({ userId: 'bob' });
    expect(await consumeRefreshToken(fresh)).toMatchObject({ userId: 'carol' });
  });

  it('revokes a connection’s tokens without touching others written meanwhile', async () => {
    const doomed = generateRefreshToken();
    await storeRefreshToken(doomed, { clientId: 'c4', userId: 'dave' });
    const other = generateRefreshToken();

    const [count] = await Promise.all([
      revokeRefreshTokensFor('c4', 'dave'),
      storeRefreshToken(other, { clientId: 'c4', userId: 'erin' })
    ]);

    expect(count).toBe(1);
    expect(await consumeRefreshToken(doomed)).toBeNull();
    expect(await consumeRefreshToken(other)).toMatchObject({ userId: 'erin' });
  });
});
