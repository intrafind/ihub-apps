// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The project access policy, settings and model constants (#1036, spec 1
 * §2, §4, §7) — pure functions, no storage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_ACCESS,
  canHoldProjects,
  memberRoleFor,
  memberTargetKey,
  principalMemberKeys,
  projectPermissions,
  satisfiesLevel
} from '../services/projects/projectAccess.js';
import {
  MAX_FILES_CEILING,
  isUserProjectsConfigured,
  projectSettings,
  projectsClientConfig
} from '../services/projects/projectSettings.js';
import {
  enabledItemKinds,
  getItemKind,
  isItemKindEnabled,
  registerItemKind
} from '../services/projects/kinds/registry.js';
import '../services/projects/kinds/linkKinds.js';
import {
  adminProjectSchema,
  membersUpdateSchema,
  normalizeProjectLink,
  projectLinksSchema,
  userProjectCreateSchema
} from '../validators/projectSchema.js';
import {
  isAdminProjectId,
  isUserProjectId,
  mintItemId,
  mintProjectId,
  usageOf
} from '../services/projects/ProjectRepository.js';
import { installationsFor } from './helpers/installedIFinder.js';
import configCache from '../configCache.js';

const ADA = {
  id: 'u-ada',
  name: 'Ada',
  groups: ['authenticated'],
  permissions: { projects: true }
};
const GRACE = { id: 'u-grace', name: 'Grace', groups: ['authenticated'] };
const CAROL = { id: 'u-carol', name: 'Carol', groups: ['engineers'] };
const ANON = { id: 'anonymous', anonymous: true, groups: ['anonymous'] };

function userProject(overrides = {}) {
  return {
    id: 'prj_test',
    ownership: 'user',
    owner: { id: ADA.id, name: ADA.name },
    members: [],
    items: [],
    ...overrides
  };
}

describe('who may hold projects', () => {
  it('admits signed-in people and personal API keys only', () => {
    assert.equal(canHoldProjects(ADA), true);
    assert.equal(canHoldProjects({ ...ADA, authMode: 'oauth_personal_key' }), true);
    assert.equal(canHoldProjects(ANON), false);
    assert.equal(canHoldProjects(undefined), false);
    assert.equal(canHoldProjects({ ...ADA, isOAuthClient: true }), false);
    assert.equal(canHoldProjects({ ...ADA, isAgent: true }), false);
    assert.equal(canHoldProjects({ ...ADA, authMode: 'oauth_authorization_code' }), false);
  });

  it('indexes member targets like prompt shares', () => {
    assert.equal(memberTargetKey({ type: 'user', id: 'u-1' }), 'user:u-1');
    assert.equal(memberTargetKey({ type: 'group', id: 'legal' }), 'group:legal');
    assert.equal(memberTargetKey({ type: 'everyone' }), 'everyone');
    assert.deepEqual(principalMemberKeys(GRACE, ['authenticated', 'anonymous']), [
      'user:u-grace',
      'everyone',
      'group:authenticated'
    ]);
    assert.deepEqual(principalMemberKeys(ANON, ['anonymous']), []);
  });
});

describe('roles on a user project', () => {
  it('gives the owner everything', () => {
    const p = projectPermissions(userProject(), ADA);
    assert.equal(p.role, 'owner');
    assert.ok(p.canUse && p.canEdit && p.canShare && p.canDelete && p.canTransfer);
    assert.equal(satisfiesLevel(p, 'own'), true);
  });

  it('gives a stranger nothing, and answers no-access for anonymous callers', () => {
    assert.deepEqual(projectPermissions(userProject(), GRACE), NO_ACCESS);
    assert.deepEqual(projectPermissions(userProject(), ANON), NO_ACCESS);
    assert.deepEqual(projectPermissions(null, ADA), NO_ACCESS);
  });

  it('lets an editor change items, instructions and members but not delete', () => {
    const project = userProject({ members: [{ type: 'user', id: GRACE.id, role: 'editor' }] });
    const p = projectPermissions(project, GRACE);
    assert.equal(p.role, 'editor');
    assert.ok(p.canUse && p.canEdit && p.canShare);
    assert.equal(p.canDelete, false);
    assert.equal(p.canTransfer, false);
    assert.equal(satisfiesLevel(p, 'edit'), true);
    assert.equal(satisfiesLevel(p, 'own'), false);
  });

  it('lets a user read and chat only', () => {
    const project = userProject({ members: [{ type: 'everyone', role: 'user' }] });
    const p = projectPermissions(project, GRACE);
    assert.equal(p.role, 'user');
    assert.equal(p.canUse, true);
    assert.equal(p.canEdit, false);
    assert.equal(p.canShare, false);
    assert.equal(satisfiesLevel(p, 'use'), true);
    assert.equal(satisfiesLevel(p, 'edit'), false);
  });

  it('reaches group members through inheritance and takes the strongest role', () => {
    const project = userProject({
      members: [
        { type: 'group', id: 'authenticated', role: 'user' },
        { type: 'group', id: 'engineers', role: 'editor' }
      ]
    });
    assert.equal(memberRoleFor(project, CAROL, ['engineers', 'authenticated']), 'editor');
    assert.equal(memberRoleFor(project, GRACE, ['authenticated']), 'user');
    assert.equal(memberRoleFor(project, GRACE, []), null);
  });

  it('never reaches the anonymous group', () => {
    const project = userProject({ members: [{ type: 'group', id: 'anonymous', role: 'editor' }] });
    assert.equal(memberRoleFor(project, GRACE, ['anonymous']), null);
  });

  it('makes a project read-only for members when the owner is gone', () => {
    const project = userProject({ members: [{ type: 'user', id: GRACE.id, role: 'editor' }] });
    const p = projectPermissions(project, GRACE, { ownerActive: false });
    assert.equal(p.canUse, true);
    assert.equal(p.canEdit, false);
    assert.equal(p.readOnly, true);
  });

  it('lets a full admin read and delete for compliance, never edit', () => {
    const p = projectPermissions(userProject(), GRACE, { isAdmin: true });
    assert.equal(p.role, 'admin');
    assert.equal(p.canView, true);
    assert.equal(p.canEdit, false);
    assert.equal(p.canDelete, true);
    assert.equal(p.canTransfer, true);
  });
});

describe('admin projects', () => {
  const admin = { id: 'faq', ownership: 'admin', enabled: true, items: [] };

  it('is reachable through a link and editable by content admins only', () => {
    assert.deepEqual(projectPermissions(admin, GRACE), NO_ACCESS);
    const linked = projectPermissions(admin, GRACE, { linked: true });
    assert.equal(linked.role, 'linked');
    assert.equal(linked.canUse, true);
    assert.equal(linked.canEdit, false);
    assert.equal(linked.readOnly, true);
    const editor = projectPermissions(admin, GRACE, { isContentAdmin: true });
    assert.equal(editor.role, 'admin');
    assert.ok(editor.canEdit && editor.canDelete);
    assert.equal(editor.canShare, false);
  });

  it('is usable through a link by anonymous and delegated callers, never editable', () => {
    assert.deepEqual(projectPermissions(admin, ANON), NO_ACCESS);
    const anonymous = projectPermissions(admin, ANON, { linked: true });
    assert.equal(anonymous.role, 'linked');
    assert.equal(anonymous.canUse, true);
    assert.equal(anonymous.canEdit, false);
    assert.deepEqual(projectPermissions(admin, ANON, { isContentAdmin: true }), NO_ACCESS);
    const delegated = { id: 'u-del', authMode: 'oauth_authorization_code', groups: ['users'] };
    assert.equal(projectPermissions(admin, delegated, { linked: true }).canUse, true);
    assert.deepEqual(projectPermissions(userProject(), delegated), NO_ACCESS);
  });

  it('is unusable through a link while disabled', () => {
    const p = projectPermissions({ ...admin, enabled: false }, GRACE, { linked: true });
    assert.equal(p.canView, true);
    assert.equal(p.canUse, false);
  });
});

describe('settings', () => {
  it('clamps the files limit to the hard ceiling and applies defaults', () => {
    const s = projectSettings({ projects: { limits: { maxFiles: 500, maxProjectsPerUser: -3 } } });
    assert.equal(s.limits.maxFiles, MAX_FILES_CEILING);
    assert.equal(s.limits.maxProjectsPerUser, 0);
    assert.equal(s.limits.maxFileBytes, 20 * 1024 * 1024);
    assert.equal(s.sharing.allowEveryone, false);
    assert.equal(s.tierPolicy, 'ihub');
    assert.equal(projectSettings({ projects: { tierPolicy: 'both' } }).tierPolicy, 'both');
    assert.equal(projectSettings({ projects: { tierPolicy: 'x' } }).tierPolicy, 'ihub');
  });

  it('needs both flags for user projects', () => {
    assert.equal(isUserProjectsConfigured({}), false);
    assert.equal(isUserProjectsConfigured({ userProjects: true }), true);
    assert.equal(isUserProjectsConfigured({ userProjects: true, projects: false }), false);
  });

  it('folds storage availability into the client config', () => {
    const off = projectsClientConfig({ userProjects: true }, {}, { storageAvailable: false });
    assert.equal(off.enabled, false);
    assert.equal(off.userProjects, false);
    const on = projectsClientConfig({ userProjects: true }, {}, { storageAvailable: true });
    assert.equal(on.enabled, true);
    assert.equal(on.userProjects, true);
    assert.deepEqual(on.tiers, ['ihub']);
  });
});

describe('item kinds', () => {
  it('registers the four link kinds with their references', () => {
    for (const id of ['url', 'page', 'ifinder-document', 'ifinder-query']) {
      const kind = getItemKind(id);
      assert.ok(kind, id);
      assert.equal(kind.storage.ihub, 'link');
    }
    assert.equal(
      getItemKind('url').refSchema.safeParse({ url: 'https://example.com' }).success,
      true
    );
    assert.equal(
      getItemKind('url').refSchema.safeParse({ url: 'javascript:alert(1)' }).success,
      false
    );
    assert.equal(getItemKind('page').refSchema.safeParse({ pageId: 'faq' }).data.language, 'en');
    assert.equal(getItemKind('ifinder-query').refSchema.safeParse({}).data.query, '');
  });

  it('hides iFinder kinds without a configured integration and honours the admin switch', () => {
    assert.equal(isItemKindEnabled('url', { platform: {} }), true);
    // The iFinder kinds follow the iFinder installation (integrations.json).
    configCache.setCacheEntry('config/integrations.json', installationsFor({}));
    assert.equal(isItemKindEnabled('ifinder-document', { platform: {} }), false);
    configCache.setCacheEntry(
      'config/integrations.json',
      installationsFor({ iFinder: { baseUrl: 'https://f' } })
    );
    assert.equal(isItemKindEnabled('ifinder-document', { platform: {} }), true);
    configCache.setCacheEntry('config/integrations.json', installationsFor({}));
    assert.equal(
      isItemKindEnabled('url', { platform: {}, settings: { kinds: { url: false } } }),
      false
    );
    assert.ok(enabledItemKinds({ platform: {} }).every(kind => kind.picker?.type));
  });

  it('refuses a kind without the pieces the project code needs', () => {
    assert.throws(() => registerItemKind({ id: 'bad kind' }), TypeError);
    assert.throws(
      () => registerItemKind({ id: 'x', storage: { ihub: 'text' }, credentials: 'none' }),
      TypeError
    );
  });
});

describe('schemas and ids', () => {
  it('mints prefixed ids and tells the two ownerships apart', () => {
    const id = mintProjectId();
    assert.ok(isUserProjectId(id));
    assert.ok(!isAdminProjectId(id));
    assert.ok(isAdminProjectId('faq'));
    assert.ok(!isAdminProjectId('prj_x'));
    assert.ok(!isAdminProjectId('../x'));
    assert.ok(mintItemId().startsWith('itm_'));
  });

  it('normalizes links', () => {
    assert.deepEqual(normalizeProjectLink('faq'), { id: 'faq', mode: 'auto', write: false });
    assert.deepEqual(normalizeProjectLink({ id: 'faq', mode: 'tools', write: true }), {
      id: 'faq',
      mode: 'tools',
      write: true
    });
    assert.equal(
      projectLinksSchema.safeParse(['faq', { id: 'docs', mode: 'context' }]).success,
      true
    );
    assert.equal(projectLinksSchema.safeParse([{ id: 'docs', mode: 'vector' }]).success, false);
  });

  it('validates the request bodies', () => {
    assert.equal(userProjectCreateSchema.safeParse({ name: ' Case ' }).data.name, 'Case');
    assert.equal(userProjectCreateSchema.safeParse({}).success, false);
    assert.equal(
      membersUpdateSchema.safeParse({ members: [{ type: 'user', id: 'u', role: 'owner' }] })
        .success,
      false
    );
    assert.equal(
      membersUpdateSchema.safeParse({ members: [{ type: 'everyone' }] }).data.members[0].role,
      'user'
    );
    const admin = adminProjectSchema.safeParse({ id: 'faq', name: { en: 'FAQ' } });
    assert.equal(admin.success, true);
    assert.equal(admin.data.ownership, 'admin');
    assert.equal(admin.data.enabled, true);
    assert.equal(
      adminProjectSchema.safeParse({
        id: 'faq',
        name: { en: 'FAQ' },
        items: [
          { id: 'a', kind: 'url', name: 'x', storage: 'link', provenance: { origin: 'linked' } },
          { id: 'a', kind: 'url', name: 'y', storage: 'link', provenance: { origin: 'linked' } }
        ]
      }).success,
      false,
      'duplicate item ids are refused'
    );
  });

  it('sums the original bytes of text items', () => {
    assert.deepEqual(
      usageOf([
        { text: { original: { bytes: 10 } } },
        { storage: 'link' },
        { text: { original: {} } }
      ]),
      { items: 3, bytes: 10 }
    );
  });
});
