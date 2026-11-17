// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin rescue (`hasAnyAdmin`) must see the same sign-in methods as the
 * lockout guards. With proxy sign-in switched on only through
 * PROXY_AUTH_ENABLED=true, the guards count a proxy admin; if the rescue did
 * not, it would hand admin to the next proxy user after the last local admin
 * was removed.
 */

import { jest, describe, test, expect, afterEach } from '@jest/globals';

let platform = {};
let users = {};

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform }
}));
const realAuthorization = await import('../utils/authorization.js');

jest.unstable_mockModule('../utils/authorization.js', () => ({
  ...realAuthorization,
  loadGroupsConfiguration: () => ({
    groups: { admins: { id: 'admins', permissions: { adminAccess: true } } }
  })
}));
jest.unstable_mockModule('../utils/userManager.js', () => ({
  loadUsers: () => ({ users }),
  saveUsers: jest.fn()
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { hasAnyAdmin, isLastAdmin } = await import('../utils/adminRescue.js');

const ORIGINAL = process.env.PROXY_AUTH_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PROXY_AUTH_ENABLED;
  else process.env.PROXY_AUTH_ENABLED = ORIGINAL;
});

describe('admin rescue and PROXY_AUTH_ENABLED', () => {
  const proxyAdmin = {
    id: 'u1',
    username: 'proxy-admin',
    active: true,
    internalGroups: ['admins'],
    authMethods: ['proxy']
  };

  test('counts a proxy admin when proxy sign-in is on only through the env var', () => {
    platform = { localAuth: { enabled: false }, proxyAuth: { enabled: false } };
    users = { u1: proxyAdmin };

    process.env.PROXY_AUTH_ENABLED = 'true';
    expect(hasAnyAdmin('/unused')).toBe(true);

    delete process.env.PROXY_AUTH_ENABLED;
    expect(hasAnyAdmin('/unused')).toBe(false);
  });

  test('isLastAdmin counts the same admins', () => {
    platform = { localAuth: { enabled: true }, proxyAuth: { enabled: false } };
    users = {
      u1: proxyAdmin,
      u2: {
        id: 'u2',
        username: 'local',
        active: true,
        internalGroups: ['admins'],
        authMethods: ['local']
      }
    };

    process.env.PROXY_AUTH_ENABLED = 'true';
    expect(isLastAdmin('u2', '/unused')).toBe(false);

    delete process.env.PROXY_AUTH_ENABLED;
    expect(isLastAdmin('u2', '/unused')).toBe(true);
  });
});

describe('admin rescue and the lockout guards count admins with one rule', () => {
  test('a malformed record counts as no admin, as countUsableAdmins counts it', () => {
    // A record that is not an object used to throw inside hasAnyAdmin, whose
    // catch answered "an admin exists" while the guards counted none.
    platform = { localAuth: { enabled: true } };
    users = {
      broken: null,
      u1: { id: 'u1', username: 'x', active: true, internalGroups: 'admins', passwordHash: 'h' }
    };
    expect(hasAnyAdmin('/unused')).toBe(false);

    users = {
      ...users,
      u2: { id: 'u2', active: true, internalGroups: ['admins'], passwordHash: 'h' }
    };
    expect(hasAnyAdmin('/unused')).toBe(true);
  });

  test('an enabled LDAP provider or NTLM whose default groups grant admin counts', () => {
    users = {};
    platform = {
      ldapAuth: { enabled: true, providers: [{ name: 'ad', defaultGroups: ['admins'] }] }
    };
    expect(hasAnyAdmin('/unused')).toBe(true);
    platform = { ntlmAuth: { enabled: true, defaultGroups: ['admins'] } };
    expect(hasAnyAdmin('/unused')).toBe(true);
    platform = { ntlmAuth: { enabled: false, defaultGroups: ['admins'] } };
    expect(hasAnyAdmin('/unused')).toBe(false);
  });
});
