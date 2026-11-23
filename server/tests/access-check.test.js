// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Unit tests for the pure parts of the access explanation: grant routes with
 * their inheritance chains, the subject a check is about, and the explicit
 * list that replaces a wildcard.
 */

import { describe, expect, it } from '@jest/globals';
import { collectAncestorPaths, describeGrantRoutes } from '../utils/contentAccess.js';
import {
  checkAccess,
  explicitListWithout,
  planRestriction,
  resolveSubject
} from '../utils/accessCheck.js';

// A diamond: emea inherits sales and support, both inherit staff.
const diamond = {
  staff: { name: 'Staff', permissions: { apps: ['*'], models: ['gpt'] } },
  sales: { name: 'Sales', inherits: ['staff'], permissions: { apps: [], models: [] } },
  support: { name: 'Support', inherits: ['staff'], permissions: { apps: ['Chat'] } },
  emea: { name: 'EMEA', inherits: ['sales', 'support'], permissions: { apps: [] } },
  loop: { inherits: ['loop', 'missing'], permissions: {} }
};

describe('collectAncestorPaths', () => {
  it('gives each ancestor once with its shortest chain', () => {
    expect(collectAncestorPaths(diamond, 'emea')).toEqual([
      { groupId: 'sales', path: ['emea', 'sales'] },
      { groupId: 'support', path: ['emea', 'support'] },
      { groupId: 'staff', path: ['emea', 'sales', 'staff'] }
    ]);
  });

  it('survives a self-reference and a missing parent', () => {
    expect(collectAncestorPaths(diamond, 'loop')).toEqual([]);
  });
});

describe('describeGrantRoutes', () => {
  it('names explicit grants case-insensitively and wildcards through inheritance', () => {
    expect(
      describeGrantRoutes({ groups: diamond, type: 'apps', contentId: 'chat', groupId: 'emea' })
    ).toEqual([
      { groupId: 'support', path: ['emea', 'support'], kind: 'explicit' },
      { groupId: 'staff', path: ['emea', 'sales', 'staff'], kind: 'wildcard' }
    ]);
  });

  it('reads the models list too, and nothing for an unknown type', () => {
    expect(
      describeGrantRoutes({ groups: diamond, type: 'models', contentId: 'gpt', groupId: 'sales' })
    ).toEqual([{ groupId: 'staff', path: ['sales', 'staff'], kind: 'explicit' }]);
    expect(
      describeGrantRoutes({ groups: diamond, type: '__proto__', contentId: 'x', groupId: 'sales' })
    ).toEqual([]);
  });
});

describe('resolveSubject', () => {
  it('adds the group of every signed-in user to a group', () => {
    const groups = { ...diamond, authenticated: { permissions: {} } };
    expect(resolveSubject({ groups, groupId: 'sales' }).groups).toEqual(['sales', 'authenticated']);
  });

  it('gives a user without recorded groups the users group, as a local login does', () => {
    const groups = { users: {}, authenticated: {} };
    const subject = resolveSubject({ groups, userRecord: { id: 'u1', username: 'u' } });
    expect(subject.groups).toEqual(['users', 'authenticated']);
  });
});

describe('explicitListWithout', () => {
  it('lists every item but one, keeps extra entries, and drops duplicates by case', () => {
    expect(explicitListWithout(['*', 'Extra', 'chat'], ['Chat', 'b', 'c'], 'CHAT')).toEqual([
      'b',
      'c',
      'Extra'
    ]);
  });
});

describe('planRestriction', () => {
  it('shows the groups a converted wildcard passed the item to', () => {
    const plan = planRestriction({
      groups: diamond,
      type: 'apps',
      contentId: 'translator',
      allIds: ['chat', 'translator']
    });
    expect(plan.candidates).toEqual([
      {
        id: 'staff',
        name: 'Staff',
        itemCount: 1,
        currentCount: 2,
        passesTo: ['sales', 'support', 'emea'],
        selected: true
      }
    ]);
    expect(plan.updatedGroups.staff.permissions.apps).toEqual(['chat']);
    // The input is not changed.
    expect(diamond.staff.permissions.apps).toEqual(['*']);
    expect(plan.groupsAfter.filter(row => row.after)).toEqual([]);
  });
});

describe('checkAccess', () => {
  it('reports a model that is not allowed for the app', () => {
    const result = checkAccess({
      type: 'apps',
      item: { id: 'chat', allowedModels: ['gpt'], preferredModel: 'mistral' },
      subject: { groups: ['staff'], active: true, anonymousOff: false },
      groups: diamond,
      models: [{ id: 'gpt' }, { id: 'mistral' }],
      filterModelsForApp: (models, app) => models.filter(m => app.allowedModels.includes(m.id))
    });
    expect(result.verdict).toBe('available');
    expect(result.reasons.find(r => r.code === 'preferredModelUnavailable')).toEqual({
      code: 'preferredModelUnavailable',
      status: 'warning',
      modelId: 'mistral',
      cause: 'notAllowedForApp'
    });
  });
});
