import { describe, it, expect } from '@jest/globals';
import {
  CONTENT_ACCESS_TYPES,
  ContentAccessError,
  applyContentAccessChanges,
  collectAncestorGroups,
  collectDescendantGroups,
  describeContentAccess,
  resolveManageableGroups
} from '../../../server/utils/contentAccess.js';

/**
 * Content admins may change which groups can use an app, a prompt, a skill, a
 * tool or a workflow — but only for the groups they belong to and the groups
 * that inherit from those (issue #2365). These tests pin the scope rule and
 * the edits to the group permission lists.
 */

function fixture() {
  return {
    anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: ['public'] } },
    authenticated: {
      id: 'authenticated',
      name: 'Authenticated',
      inherits: ['anonymous'],
      permissions: { apps: [] }
    },
    users: {
      id: 'users',
      name: 'Users',
      inherits: ['authenticated'],
      permissions: { apps: ['chat'] }
    },
    sales: { id: 'sales', name: 'Sales', inherits: ['users'], permissions: { apps: [] } },
    'emea-sales': {
      id: 'emea-sales',
      name: 'EMEA Sales',
      inherits: ['sales'],
      permissions: { apps: [] }
    },
    marketing: {
      id: 'marketing',
      name: 'Marketing',
      inherits: ['users'],
      permissions: { apps: ['Sales-Bot'] }
    },
    admins: { id: 'admins', name: 'Admins', permissions: { apps: ['*'], adminAccess: true } },
    'content-admins': {
      id: 'content-admins',
      name: 'Content Admins',
      inherits: ['authenticated'],
      permissions: { apps: [], contentAdmin: true }
    }
  };
}

describe('CONTENT_ACCESS_TYPES', () => {
  it('covers the content lists and leaves models to the platform', () => {
    expect([...CONTENT_ACCESS_TYPES].sort()).toEqual(
      ['apps', 'prompts', 'skills', 'tools', 'workflows'].sort()
    );
    expect(CONTENT_ACCESS_TYPES).not.toContain('models');
  });
});

describe('collectAncestorGroups', () => {
  it('walks inheritance transitively, nearest first', () => {
    expect(collectAncestorGroups(fixture(), 'emea-sales')).toEqual([
      'sales',
      'users',
      'authenticated',
      'anonymous'
    ]);
  });

  it('skips parents that do not exist and survives cycles', () => {
    const groups = {
      a: { id: 'a', inherits: ['b', 'ghost'] },
      b: { id: 'b', inherits: ['a'] }
    };
    expect(collectAncestorGroups(groups, 'a')).toEqual(['b']);
  });
});

describe('collectDescendantGroups', () => {
  it('returns the seeds plus every group inheriting from them', () => {
    const result = collectDescendantGroups(fixture(), ['sales']);
    expect([...result].sort()).toEqual(['emea-sales', 'sales']);
  });

  it('follows inheritance through several levels', () => {
    const result = collectDescendantGroups(fixture(), ['users']);
    expect([...result].sort()).toEqual(['emea-sales', 'marketing', 'sales', 'users']);
  });

  it('ignores seeds that are not defined groups', () => {
    expect(collectDescendantGroups(fixture(), ['nope']).size).toBe(0);
  });
});

describe('resolveManageableGroups', () => {
  it('lets a full admin manage every group, in file order', () => {
    const groups = fixture();
    const result = resolveManageableGroups({ groups, user: { groups: [] }, fullAdmin: true });
    expect(result.scope).toBe('all');
    expect(result.groupIds).toEqual(Object.keys(groups));
  });

  it('scopes a content admin to their groups and the groups inheriting from them', () => {
    const result = resolveManageableGroups({
      groups: fixture(),
      user: { groups: ['content-admins', 'sales', 'authenticated'] },
      fullAdmin: false
    });
    expect(result.scope).toBe('membership');
    // File order, not membership order; marketing and users are out of reach.
    expect(result.groupIds).toEqual(['sales', 'emea-sales', 'content-admins']);
  });

  it('does not treat the implicit authenticated group as membership', () => {
    // Every signed-in user carries `authenticated`; if it counted, every
    // content admin could publish to every group that inherits from it.
    const result = resolveManageableGroups({
      groups: fixture(),
      user: { groups: ['authenticated'] },
      fullAdmin: false
    });
    expect(result.groupIds).toEqual([]);
  });

  it('honours a renamed authenticated group', () => {
    const groups = fixture();
    groups['signed-in'] = { id: 'signed-in', name: 'Signed in', permissions: { apps: [] } };
    const result = resolveManageableGroups({
      groups,
      user: { groups: ['signed-in'] },
      fullAdmin: false,
      implicitGroups: ['signed-in', 'anonymous']
    });
    expect(result.groupIds).toEqual([]);
  });
});

describe('describeContentAccess', () => {
  it('reports direct grants, wildcards and inherited access', () => {
    const groups = fixture();
    const view = describeContentAccess({
      groups,
      type: 'apps',
      contentId: 'chat',
      groupIds: ['users', 'sales', 'admins', 'anonymous']
    });
    expect(view).toEqual([
      {
        id: 'users',
        name: 'Users',
        description: '',
        granted: true,
        wildcard: false,
        inheritedFrom: [],
        effective: true
      },
      {
        id: 'sales',
        name: 'Sales',
        description: '',
        granted: false,
        wildcard: false,
        inheritedFrom: ['users'],
        effective: true
      },
      {
        id: 'admins',
        name: 'Admins',
        description: '',
        granted: false,
        wildcard: true,
        inheritedFrom: [],
        effective: true
      },
      {
        id: 'anonymous',
        name: 'Anonymous',
        description: '',
        granted: false,
        wildcard: false,
        inheritedFrom: [],
        effective: false
      }
    ]);
  });

  it('matches ids case-insensitively, like the runtime permission check', () => {
    const [marketing] = describeContentAccess({
      groups: fixture(),
      type: 'apps',
      contentId: 'sales-bot',
      groupIds: ['marketing']
    });
    expect(marketing.granted).toBe(true);
  });

  it('falls back to the id when a group has no name', () => {
    const groups = { plain: { permissions: {} } };
    const [plain] = describeContentAccess({
      groups,
      type: 'prompts',
      contentId: 'x',
      groupIds: ['plain']
    });
    expect(plain.name).toBe('plain');
    expect(plain.effective).toBe(false);
  });
});

describe('applyContentAccessChanges', () => {
  it('adds the canonical id once and removes it case-insensitively', () => {
    const groups = fixture();
    const changes = applyContentAccessChanges({
      groups,
      type: 'apps',
      contentId: 'Sales-Bot',
      grant: ['sales', 'marketing'],
      revoke: [],
      manageableIds: ['sales', 'marketing']
    });
    // marketing already names it (different casing) — no change there.
    expect(changes.map(change => change.groupId)).toEqual(['sales']);
    expect(groups.sales.permissions.apps).toEqual(['Sales-Bot']);
    expect(groups.marketing.permissions.apps).toEqual(['Sales-Bot']);

    const revoked = applyContentAccessChanges({
      groups,
      type: 'apps',
      contentId: 'sales-bot',
      grant: [],
      revoke: ['marketing'],
      manageableIds: ['marketing']
    });
    expect(revoked).toHaveLength(1);
    expect(revoked[0].action).toBe('revoke');
    expect(groups.marketing.permissions.apps).toEqual([]);
  });

  it('keeps the other permissions of the group untouched', () => {
    const groups = fixture();
    applyContentAccessChanges({
      groups,
      type: 'prompts',
      contentId: 'summary',
      grant: ['content-admins'],
      revoke: [],
      manageableIds: ['content-admins']
    });
    expect(groups['content-admins'].permissions).toEqual({
      apps: [],
      contentAdmin: true,
      prompts: ['summary']
    });
  });

  it('records a before/after snapshot per changed group', () => {
    const groups = fixture();
    const [change] = applyContentAccessChanges({
      groups,
      type: 'apps',
      contentId: 'chat',
      grant: ['sales'],
      revoke: [],
      manageableIds: ['sales']
    });
    expect(change.before.permissions.apps).toEqual([]);
    expect(change.after.permissions.apps).toEqual(['chat']);
    expect(change.after).toBe(groups.sales);
  });

  it('refuses a group outside the caller scope without touching anything', () => {
    const groups = fixture();
    expect(() =>
      applyContentAccessChanges({
        groups,
        type: 'apps',
        contentId: 'chat',
        grant: ['sales', 'marketing'],
        revoke: [],
        manageableIds: ['sales']
      })
    ).toThrow(ContentAccessError);
    // The valid part of the request must not have been applied either.
    expect(groups.sales.permissions.apps).toEqual([]);
  });

  it('answers 403 for a foreign group, 404 for an unknown one and 400 for a wildcard revoke', () => {
    const status = options => {
      try {
        applyContentAccessChanges({
          groups: fixture(),
          type: 'apps',
          contentId: 'chat',
          grant: [],
          revoke: [],
          manageableIds: ['sales', 'admins'],
          ...options
        });
      } catch (error) {
        return error.status;
      }
      return 200;
    };
    expect(status({ grant: ['marketing'] })).toBe(403);
    expect(status({ grant: ['ghost'] })).toBe(404);
    expect(status({ revoke: ['admins'] })).toBe(400);
    expect(status({ grant: ['sales'], revoke: ['sales'] })).toBe(400);
    expect(status({ grant: 'sales' })).toBe(400);
    expect(status({ type: 'models', grant: ['sales'] })).toBe(400);
  });

  it('never uses request input as a property name', () => {
    const groups = fixture();
    expect(() =>
      applyContentAccessChanges({
        groups,
        type: '__proto__',
        contentId: 'chat',
        grant: ['sales'],
        revoke: [],
        manageableIds: ['sales']
      })
    ).toThrow(ContentAccessError);
    expect(Object.prototype.polluted).toBeUndefined();
    expect(groups.sales.permissions).toEqual({ apps: [] });
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'refuses the group id "%s" before looking it up',
    groupId => {
      const groups = fixture();
      let status;
      try {
        applyContentAccessChanges({
          groups,
          type: 'apps',
          contentId: 'chat',
          grant: [groupId],
          revoke: [],
          // Even a scope that (wrongly) lists the id must not get through.
          manageableIds: [groupId, 'sales']
        });
      } catch (error) {
        status = error.status;
      }
      expect(status).toBe(400);
      expect(Object.prototype.permissions).toBeUndefined();
      expect(Object.getPrototypeOf({}).apps).toBeUndefined();
    }
  );

  it('treats a grant to a wildcard group as already satisfied', () => {
    const groups = fixture();
    const changes = applyContentAccessChanges({
      groups,
      type: 'apps',
      contentId: 'chat',
      grant: ['admins'],
      revoke: [],
      manageableIds: ['admins']
    });
    expect(changes).toEqual([]);
    expect(groups.admins.permissions.apps).toEqual(['*']);
  });
});
