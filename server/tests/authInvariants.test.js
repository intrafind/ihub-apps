// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rules that decide whether an installation stays administrable
 * (`utils/authInvariants.js`): which sign-in route a caller keeps, and how
 * many administrators can still sign in. Pure functions; the matrix covers
 * every sign-in method, inherited admin groups, inactive admins, disabled
 * methods and environment overrides.
 */

import { describe, test, expect } from '@jest/globals';
import {
  authConfigChanged,
  countUsableAdmins,
  dependantsOf,
  effectivePlatformConfig,
  groupsResolutionError,
  isUsableAdmin,
  listUsableAdmins,
  routeSurvives,
  signInRouteOf
} from '../utils/authInvariants.js';
import { resolveGroupInheritance } from '../utils/authorization.js';

const groups = resolveGroupInheritance({
  groups: {
    admins: { id: 'admins', permissions: { adminAccess: true } },
    ops: { id: 'ops', inherits: ['admins'], permissions: { adminAccess: false } },
    users: { id: 'users', permissions: { adminAccess: false } }
  }
});

const allOn = {
  localAuth: { enabled: true },
  oidcAuth: { enabled: true, providers: [{ name: 'entra' }, { name: 'old', enabled: false }] },
  ldapAuth: { enabled: true, providers: [{ name: 'corp' }] },
  ntlmAuth: { enabled: true },
  proxyAuth: { enabled: true },
  teamsAuth: { enabled: true }
};

const localAdmin = {
  id: 'u1',
  active: true,
  authMethods: ['local'],
  passwordHash: 'x',
  internalGroups: ['admins']
};

describe('routeSurvives', () => {
  test.each([
    ['local', null, allOn, localAdmin, true],
    ['local', null, { ...allOn, localAuth: { enabled: false } }, localAdmin, false],
    ['local', null, allOn, { ...localAdmin, active: false }, false],
    ['local', null, allOn, { ...localAdmin, passwordHash: undefined }, false],
    ['local', null, allOn, undefined, false],
    ['oidc', 'entra', allOn, undefined, true],
    ['oidc', 'old', allOn, undefined, false],
    ['oidc', 'gone', allOn, undefined, false],
    [
      'oidc',
      'entra',
      { ...allOn, oidcAuth: { enabled: false, providers: [{ name: 'entra' }] } },
      undefined,
      false
    ],
    ['oidc', null, allOn, undefined, true],
    ['oidc', null, { ...allOn, oidcAuth: { enabled: true, providers: [] } }, undefined, false],
    ['ldap', 'corp', allOn, undefined, true],
    ['ldap', 'other', allOn, undefined, false],
    [
      'ldap',
      null,
      { ...allOn, ldapAuth: { enabled: false, providers: [{ name: 'corp' }] } },
      undefined,
      false
    ],
    ['ntlm', null, allOn, undefined, true],
    ['ntlm', null, { ...allOn, ntlmAuth: { enabled: false } }, undefined, false],
    ['proxy', null, allOn, undefined, true],
    ['proxy', null, { ...allOn, proxyAuth: { enabled: false } }, undefined, false],
    ['teams', null, { ...allOn, teamsAuth: { enabled: false } }, undefined, false],
    ['oidc', 'entra', allOn, { active: false }, false],
    ['unknown', null, allOn, localAdmin, false],
    [null, null, allOn, localAdmin, false]
  ])('%s/%s → %s', (mode, provider, platform, record, expected) => {
    expect(routeSurvives({ mode, provider }, platform, record)).toBe(expected);
  });

  test('a string "true" is not an enabled method (fails closed)', () => {
    expect(routeSurvives({ mode: 'local' }, { localAuth: { enabled: 'true' } }, localAdmin)).toBe(
      false
    );
  });
});

describe('signInRouteOf', () => {
  test('reads authMode and authProvider from a token session', () => {
    expect(signInRouteOf({ id: 'a', authMode: 'oidc', authProvider: 'entra' })).toEqual({
      mode: 'oidc',
      provider: 'entra',
      machine: false
    });
  });

  test('falls back to authMethod for proxy sessions', () => {
    expect(signInRouteOf({ id: 'a', authMethod: 'proxy' }).mode).toBe('proxy');
  });

  test.each(['oauth_client_credentials', 'oauth_static_api_key', 'oauth_personal_key'])(
    '%s is a machine principal',
    authMode => {
      expect(signInRouteOf({ id: 'c', authMode }).machine).toBe(true);
    }
  );
});

describe('countUsableAdmins', () => {
  test('counts an active admin whose method is enabled', () => {
    expect(countUsableAdmins({ users: { u1: localAdmin } }, groups, allOn)).toBe(1);
  });

  test('counts an admin through an inherited group', () => {
    const user = { ...localAdmin, internalGroups: ['ops'] };
    expect(isUsableAdmin(user, groups, allOn)).toBe(true);
  });

  test('does not count an inactive admin', () => {
    const user = { ...localAdmin, active: false };
    expect(countUsableAdmins({ users: { u1: user } }, groups, allOn)).toBe(0);
  });

  test('does not count an admin whose only method is disabled', () => {
    const platform = { ...allOn, localAuth: { enabled: false } };
    expect(countUsableAdmins({ users: { u1: localAdmin } }, groups, platform)).toBe(0);
  });

  test('does not count a user without an admin group', () => {
    const user = { ...localAdmin, internalGroups: ['users'] };
    expect(countUsableAdmins({ users: { u1: user } }, groups, allOn)).toBe(0);
  });

  test('counts OIDC and proxy admins while their method is on', () => {
    const users = {
      o: { active: true, authMethods: ['oidc'], internalGroups: ['admins'] },
      p: { active: true, authMethods: ['proxy'], internalGroups: ['admins'] }
    };
    expect(countUsableAdmins({ users }, groups, allOn)).toBe(2);
    expect(countUsableAdmins({ users }, groups, { ...allOn, oidcAuth: { enabled: false } })).toBe(
      1
    );
  });

  test('counts LDAP and NTLM default groups that grant admin access', () => {
    const platform = {
      ldapAuth: { enabled: true, providers: [{ name: 'corp', defaultGroups: ['ops'] }] },
      ntlmAuth: { enabled: true, defaultGroups: ['admins'] }
    };
    expect(listUsableAdmins({ users: {} }, groups, platform)).toEqual(['ldap:corp', 'ntlm']);
    expect(
      countUsableAdmins({ users: {} }, groups, { ...platform, ntlmAuth: { enabled: false } })
    ).toBe(1);
  });

  test('a missing users file has no persisted admins', () => {
    expect(countUsableAdmins(null, groups, allOn)).toBe(0);
  });
});

describe('effectivePlatformConfig', () => {
  test('applies IHUB_PLATFORM__ overrides without changing the stored body', () => {
    const stored = { localAuth: { enabled: false } };
    const effective = effectivePlatformConfig(stored, {
      IHUB_PLATFORM__LOCAL_AUTH__ENABLED: 'true'
    });
    expect(effective.localAuth.enabled).toBe(true);
    expect(stored.localAuth.enabled).toBe(false);
  });

  test('PROXY_AUTH_ENABLED=true turns proxy sign-in on, as the proxy middleware does', () => {
    expect(effectivePlatformConfig({}, { PROXY_AUTH_ENABLED: 'TRUE' }).proxyAuth.enabled).toBe(
      true
    );
  });
});

describe('authConfigChanged', () => {
  test('is false for a change outside the auth blocks', () => {
    expect(
      authConfigChanged(
        { a: 1, localAuth: { enabled: true } },
        { a: 2, localAuth: { enabled: true } }
      )
    ).toBe(false);
  });

  test('is true when an auth block changes', () => {
    expect(
      authConfigChanged({ localAuth: { enabled: true } }, { localAuth: { enabled: false } })
    ).toBe(true);
  });
});

describe('group graph', () => {
  const raw = {
    groups: {
      p: { id: 'p' },
      b: { id: 'b', inherits: ['p'] },
      c: { id: 'c', inherits: ['b'] }
    }
  };

  test('dependantsOf lists direct inheritors only', () => {
    expect(dependantsOf(raw.groups, 'p')).toEqual(['b']);
    expect(dependantsOf(raw.groups, 'b')).toEqual(['c']);
    expect(dependantsOf(raw.groups, 'c')).toEqual([]);
  });

  test('groupsResolutionError names a missing parent', () => {
    expect(groupsResolutionError(raw)).toBeNull();
    const broken = structuredClone(raw);
    delete broken.groups.p;
    expect(groupsResolutionError(broken)).toMatch(/p/);
  });
});
