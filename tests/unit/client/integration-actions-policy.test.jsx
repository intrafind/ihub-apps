// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The action policy the install wizard saves. Editing an MCP installation
 * while its server lists no tools must not switch every tool on, and a
 * migrated allowlist (`allowedTools`) must not turn into a denylist.
 */
import {
  buildActionsPolicy,
  isAllowlist
} from '../../../client/src/features/admin/components/integrations/actionsPolicy';

const known = [
  { name: 'search', enabledByDefault: true },
  { name: 'create_issue', enabledByDefault: true },
  { name: 'delete_repo', enabledByDefault: true },
  { name: 'experimental', enabledByDefault: false }
];

describe('buildActionsPolicy', () => {
  it('sends the stored policy back unchanged when no actions are known', () => {
    const stored = {
      enabled: ['search'],
      disabled: [],
      overrides: { search: { sideEffect: 'read' } }
    };
    const policy = buildActionsPolicy({ knownActions: [], checkedActions: new Set(), stored });
    expect(policy).toEqual(stored);
    expect(policy.enabled).not.toBe(stored.enabled);

    const denylist = { enabled: ['*'], disabled: ['delete_repo'], overrides: {} };
    expect(
      buildActionsPolicy({ knownActions: [], checkedActions: new Set(), stored: denylist })
    ).toEqual(denylist);
  });

  it('starts a new installation with every default action on', () => {
    expect(buildActionsPolicy({ knownActions: [], checkedActions: new Set() })).toEqual({
      enabled: ['*'],
      disabled: [],
      overrides: {}
    });
  });

  it('keeps a stored allowlist an allowlist: the checked names, nothing disabled', () => {
    const stored = { enabled: ['search', 'create_issue'], disabled: [], overrides: {} };
    const policy = buildActionsPolicy({
      knownActions: known,
      checkedActions: new Set(['search', 'delete_repo']),
      stored
    });
    expect(policy).toEqual({ enabled: ['search', 'delete_repo'], disabled: [], overrides: {} });
  });

  it('keeps allowlisted names the system did not list this time', () => {
    const stored = { enabled: ['search', 'archived_tool'], disabled: [], overrides: {} };
    const policy = buildActionsPolicy({
      knownActions: known,
      checkedActions: new Set(['search']),
      stored
    });
    expect(policy.enabled).toEqual(['search', 'archived_tool']);
  });

  it('builds * plus exceptions for a stored * policy and carries the overrides', () => {
    const stored = { enabled: ['*'], disabled: [], overrides: {} };
    const overrides = { search: { sideEffect: 'read' } };
    const policy = buildActionsPolicy({
      knownActions: known,
      checkedActions: new Set(['search', 'create_issue', 'experimental']),
      stored,
      overrides
    });
    expect(policy).toEqual({
      enabled: ['*', 'experimental'],
      disabled: ['delete_repo'],
      overrides
    });
  });

  it('tells an allowlist from * with exceptions', () => {
    expect(isAllowlist({ enabled: ['search'] })).toBe(true);
    expect(isAllowlist({ enabled: ['*', 'experimental'] })).toBe(false);
    expect(isAllowlist(null)).toBe(false);
    expect(isAllowlist({})).toBe(false);
  });
});
