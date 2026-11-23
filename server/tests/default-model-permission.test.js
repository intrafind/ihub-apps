// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The default-model token (`@default`, `shared/modelPermissions.js`) in a
 * group's model permissions: it grants the model that is the platform default
 * at the time of the check, and only that one.
 *
 * Covers the runtime permissions (`getPermissionsForUser`,
 * `enhanceUserWithPermissions`, `filterResourcesByPermissions`), the access
 * views (`describeGrantRoutes`, `describeContentAccess`, `describeAudience`),
 * the access check and the restrict plan.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let mockModels = [];

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getModels: () => ({ data: mockModels }),
    getPlatform: () => ({}),
    getGroupsConfiguration: () => ({ data: null })
  }
}));

const {
  currentDefaultModelId,
  enhanceUserWithPermissions,
  filterResourcesByPermissions,
  getPermissionsForUser
} = await import('../utils/authorization.js');
const { describeAudience, describeContentAccess, describeGrantRoutes } =
  await import('../utils/contentAccess.js');
const { checkAccess, planRestriction, resolveSubject } = await import('../utils/accessCheck.js');
const { grantsAsDefaultModel, resolveModelPermissionList } =
  await import('../../shared/modelPermissions.js');

const groupPermissions = {
  groups: {
    anonymous: { apps: ['chat'], models: ['@default'] },
    hr: { apps: ['chat'], models: ['hr-model'] },
    admins: { apps: ['*'], models: ['*'] },
    mixed: { models: ['@default', 'hr-model'] }
  }
};

const models = (defaultId = 'flash') => [
  { id: 'flash', enabled: true, default: defaultId === 'flash' },
  { id: 'hr-model', enabled: true, default: defaultId === 'hr-model' },
  { id: 'big', enabled: true, default: defaultId === 'big' }
];

beforeEach(() => {
  mockModels = models('flash');
});

describe('shared/modelPermissions', () => {
  it('resolves the token to the default model id', () => {
    expect(resolveModelPermissionList(['@default', 'x'], 'flash')).toEqual(['flash', 'x']);
    expect(resolveModelPermissionList(['@default'], null)).toEqual([]);
    expect(resolveModelPermissionList(['a'], 'flash')).toEqual(['a']);
  });

  it('grants only the default model, ignoring case', () => {
    expect(grantsAsDefaultModel(['@default'], 'FLASH', 'flash')).toBe(true);
    expect(grantsAsDefaultModel(['@default'], 'big', 'flash')).toBe(false);
    expect(grantsAsDefaultModel(['flash'], 'flash', 'flash')).toBe(false);
  });
});

describe('getPermissionsForUser with @default', () => {
  it('grants the current default model', () => {
    const permissions = getPermissionsForUser(['anonymous'], groupPermissions);
    expect(permissions.models.has('flash')).toBe(true);
  });

  it('does not grant any other model', () => {
    const permissions = getPermissionsForUser(['anonymous'], groupPermissions);
    expect(permissions.models.has('big')).toBe(false);
    expect(permissions.models.has('hr-model')).toBe(false);
    expect(permissions.models.has('*')).toBe(false);
  });

  it('follows when another model becomes the default', () => {
    mockModels = models('big');
    const permissions = getPermissionsForUser(['anonymous'], groupPermissions);
    expect(permissions.models.has('big')).toBe(true);
    expect(permissions.models.has('flash')).toBe(false);
  });

  it('promotes the first enabled chat model when none is flagged', () => {
    mockModels = [
      { id: 'tts', enabled: true, modelType: 'tts' },
      { id: 'off', enabled: false },
      { id: 'first-chat', enabled: true }
    ];
    expect(currentDefaultModelId()).toBe('first-chat');
    const permissions = getPermissionsForUser(['anonymous'], groupPermissions);
    expect([...permissions.models]).toEqual(['first-chat']);
  });

  it('grants nothing when no model is configured', () => {
    mockModels = [];
    const permissions = getPermissionsForUser(['anonymous'], groupPermissions);
    expect(permissions.models.size).toBe(0);
  });

  it('leaves a wildcard group unaffected', () => {
    const permissions = getPermissionsForUser(['admins', 'anonymous'], groupPermissions);
    expect(permissions.models.has('*')).toBe(true);
    expect(filterResourcesByPermissions(mockModels, permissions.models)).toHaveLength(3);
  });

  it('unions with named models of the same and other groups', () => {
    const permissions = getPermissionsForUser(['hr', 'mixed'], groupPermissions);
    expect([...permissions.models].sort()).toEqual(['flash', 'hr-model']);
  });

  it('takes a default model id given by the caller', () => {
    const permissions = getPermissionsForUser(['anonymous'], groupPermissions, {
      defaultModelId: 'hr-model'
    });
    expect([...permissions.models]).toEqual(['hr-model']);
  });

  it('filters the model list a user sees down to the default model', () => {
    const permissions = getPermissionsForUser(['anonymous'], groupPermissions);
    expect(filterResourcesByPermissions(mockModels, permissions.models).map(m => m.id)).toEqual([
      'flash'
    ]);
  });
});

describe('enhanceUserWithPermissions with @default', () => {
  it('gives an OAuth client nothing from the token: its own list is the grant', () => {
    const user = enhanceUserWithPermissions(
      { id: 'client', isOAuthClient: true, allowedModels: ['big'], groups: [] },
      {},
      {}
    );
    expect([...user.permissions.models]).toEqual(['big']);
  });
});

describe('access views with @default', () => {
  const groups = {
    anonymous: { name: 'Anonymous', permissions: { models: ['@default'] } },
    authenticated: { name: 'Authenticated', inherits: ['anonymous'], permissions: { models: [] } },
    users: { name: 'Users', inherits: ['authenticated'], permissions: { models: ['*'] } },
    hr: { name: 'HR', inherits: ['authenticated'], permissions: { models: ['hr-model'] } }
  };

  it('names the route kind "default" for the default model', () => {
    expect(
      describeGrantRoutes({
        groups,
        type: 'models',
        contentId: 'flash',
        groupId: 'hr',
        defaultModelId: 'flash'
      })
    ).toEqual([
      { groupId: 'anonymous', kind: 'default', path: ['hr', 'authenticated', 'anonymous'] }
    ]);
  });

  it('gives no route for another model, or without a default model', () => {
    expect(
      describeGrantRoutes({
        groups,
        type: 'models',
        contentId: 'big',
        groupId: 'hr',
        defaultModelId: 'flash'
      })
    ).toEqual([]);
    expect(
      describeGrantRoutes({ groups, type: 'models', contentId: 'flash', groupId: 'hr' })
    ).toEqual([]);
  });

  it('never treats the token as a grant of another type', () => {
    const appGroups = { a: { permissions: { apps: ['@default'] } } };
    expect(
      describeGrantRoutes({
        groups: appGroups,
        type: 'apps',
        contentId: 'flash',
        groupId: 'a',
        defaultModelId: 'flash'
      })
    ).toEqual([]);
  });

  it('marks the group row and counts it as effective', () => {
    const [row] = describeContentAccess({
      groups,
      type: 'models',
      contentId: 'flash',
      groupIds: ['anonymous'],
      defaultModelId: 'flash'
    });
    expect(row).toMatchObject({
      granted: false,
      wildcard: false,
      defaultModel: true,
      effective: true
    });
  });

  it('says anonymous visitors and every signed-in user get the default model', () => {
    expect(
      describeAudience({
        groups,
        type: 'models',
        contentId: 'flash',
        anonymousGroups: ['anonymous'],
        defaultModelId: 'flash'
      })
    ).toEqual({ allSignedIn: true, anonymous: true });
    expect(
      describeAudience({
        groups,
        type: 'models',
        contentId: 'hr-model',
        anonymousGroups: ['anonymous'],
        defaultModelId: 'flash'
      })
    ).toEqual({ allSignedIn: false, anonymous: false });
  });

  it('grants the default model in the access check, worked out from the models', () => {
    const subject = resolveSubject({
      groups,
      groupId: 'anonymous',
      anonymousAllowed: true,
      anonymousGroups: ['anonymous']
    });
    const allowed = checkAccess({
      type: 'models',
      item: { id: 'flash', enabled: true },
      subject,
      groups,
      models: models('flash')
    });
    expect(allowed.verdict).toBe('available');
    expect(allowed.reasons.find(reason => reason.code === 'granted').routes[0].kind).toBe(
      'default'
    );

    const refused = checkAccess({
      type: 'models',
      item: { id: 'big', enabled: true },
      subject,
      groups,
      models: models('flash')
    });
    expect(refused.verdict).toBe('unavailable');
  });

  it('leaves @default alone on restrict and names the groups that keep the default model', () => {
    const plan = planRestriction({
      groups: {
        ...groups,
        users: {
          name: 'Users',
          inherits: ['authenticated'],
          permissions: { models: ['*', '@default'] }
        }
      },
      type: 'models',
      contentId: 'flash',
      allIds: ['flash', 'hr-model', 'big'],
      defaultModelId: 'flash',
      anonymousGroups: ['anonymous']
    });
    expect(plan.updatedGroups.users.permissions.models).toEqual(['hr-model', 'big', '@default']);
    expect(plan.updatedGroups.anonymous.permissions.models).toEqual(['@default']);
    expect(plan.defaultModelGroups).toEqual(['anonymous', 'users']);
    expect(plan.audienceAfter).toEqual({ allSignedIn: true, anonymous: true });
  });

  it('names no default-model groups when the restricted model is not the default', () => {
    const plan = planRestriction({
      groups,
      type: 'models',
      contentId: 'big',
      allIds: ['flash', 'hr-model', 'big'],
      defaultModelId: 'flash'
    });
    expect(plan.defaultModelGroups).toEqual([]);
    expect(plan.audienceAfter.allSignedIn).toBe(false);
  });
});
