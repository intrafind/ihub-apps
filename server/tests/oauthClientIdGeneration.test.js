// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `generateClientId` turns a client name into the readable part of a client id:
 * lowercase, every run of other characters one underscore, no underscores at
 * either end — and linear in the length of the name.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../configCache.js', () => ({ default: {} }));
jest.unstable_mockModule('../configSync.js', () => ({ announceConfigChange: () => {} }));

const { generateClientId } = await import('../utils/oauthClientManager.js');

const readable = id => id.replace(/^client_/, '').replace(/_[0-9a-f]{8}$/, '');

describe('generateClientId', () => {
  it.each([
    ['  Hello World!! ', 'hello_world'],
    ['___a__b___', 'a_b'],
    ['Claude-Code 2', 'claude_code_2'],
    ['###', '']
  ])('turns %j into %j', (name, expected) => {
    expect(readable(generateClientId(name))).toBe(expected);
  });

  it('handles a long run of underscores without backtracking', () => {
    const started = Date.now();
    const id = generateClientId(`${'_'.repeat(200000)}x${'_'.repeat(200000)}!`);
    expect(readable(id)).toBe('x');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
