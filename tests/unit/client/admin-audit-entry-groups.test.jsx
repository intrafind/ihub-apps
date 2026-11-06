// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The audit entry detail view breaks a login's groups down by where they came
 * from: the identity provider (and what each provider group mapped to), manual
 * assignment, and the groups added automatically.
 */
import { describe, it, expect } from '@jest/globals';
import {
  describeAuditEntryGroups,
  otherAuditEntryDetails
} from '../../../client/src/features/admin/utils/auditEntryGroups';

const loginEntry = {
  action: 'login',
  actor: { id: 'user_1', groups: ['admins', 'users', 'finance', 'authenticated'] },
  details: {
    groups: {
      external: [
        { name: 'entra-admins-guid', mappedTo: ['admins', 'users'] },
        { name: 'unknown-guid', mappedTo: [] }
      ],
      manual: ['finance']
    }
  }
};

describe('describeAuditEntryGroups', () => {
  it('splits a login into provider, manual and automatic groups', () => {
    expect(describeAuditEntryGroups(loginEntry)).toEqual({
      effective: ['admins', 'users', 'finance', 'authenticated'],
      hasSources: true,
      external: [
        { name: 'entra-admins-guid', mappedTo: ['admins', 'users'] },
        { name: 'unknown-guid', mappedTo: [] }
      ],
      externalTotal: 2,
      mappedCount: 1,
      mapped: ['admins', 'users'],
      manual: ['finance'],
      automatic: ['authenticated']
    });
  });

  it('keeps the total the server recorded when it capped the list', () => {
    const entry = {
      ...loginEntry,
      details: { groups: { ...loginEntry.details.groups, externalTotal: 350 } }
    };
    expect(describeAuditEntryGroups(entry).externalTotal).toBe(350);
  });

  it('shows only the effective groups for entries without a breakdown', () => {
    const result = describeAuditEntryGroups({ actor: { groups: ['users'] } });
    expect(result.hasSources).toBe(false);
    expect(result.effective).toEqual(['users']);
  });

  it('returns null when an entry has no groups at all', () => {
    expect(describeAuditEntryGroups({ actor: { groups: [] } })).toBeNull();
    expect(describeAuditEntryGroups({ admin: 'legacy' })).toBeNull();
  });

  it('ignores malformed provider groups', () => {
    const result = describeAuditEntryGroups({
      actor: { groups: [] },
      details: { groups: { external: [null, { name: '' }, { name: 'g', mappedTo: 'x' }] } }
    });
    expect(result.external).toEqual([{ name: 'g', mappedTo: [] }]);
    expect(result.manual).toEqual([]);
  });
});

describe('otherAuditEntryDetails', () => {
  it('leaves out the group breakdown', () => {
    expect(otherAuditEntryDetails(loginEntry)).toBeNull();
    expect(otherAuditEntryDetails({ details: { groups: {}, reason: 'x' } })).toEqual({
      reason: 'x'
    });
    expect(otherAuditEntryDetails({})).toBeNull();
  });
});
