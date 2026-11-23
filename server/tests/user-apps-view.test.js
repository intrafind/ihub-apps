// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a response says about a personal app (feature `userApps`, design
 * sections 9.1 and 9.2).
 *
 * The view is built for each role from a record with every field set, and its
 * key set is compared with a fixed list per role: a field the record gains
 * later is not sent until someone lists it here. `ownerPrincipal`,
 * `contentHash` and the `publishing` mark are in no view.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  adminUserAppListItem,
  adminUserAppView,
  reducedUserAppView,
  retiredUserAppView,
  revisionFromIfMatch,
  sharedWithCounts,
  userAppEtag,
  userAppRevisionView,
  userAppView
} from '../services/userApps/userAppView.js';
import { userAppPermissions } from '../services/userApps/userAppAccess.js';
import { userAppSettings } from '../services/userApps/userAppSettings.js';
import { personalAppBase, PERSONAL_UPLOAD_ON } from '../../shared/userAppContent.js';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const APP_ID = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';
const SECRET_EMAIL = 'anna.schmidt@example.com';

const content = {
  name: { de: 'Stellenanzeigen schreiben' },
  description: { de: 'Schreibt Stellenanzeigen' },
  system: { de: 'Du schreibst Stellenanzeigen.' },
  icon: 'document-text',
  color: '#4F46E5',
  variables: [],
  starterPrompts: [],
  preferredModel: 'gpt-4o',
  capabilities: {
    upload: true,
    webSearch: true,
    skills: false,
    integrations: [{ id: 'jira', actions: ['search_issues'] }]
  }
};

/** A record with every field of section 4.3 set. */
const record = (extra = {}) => ({
  version: 1,
  id: APP_ID,
  ownership: 'user',
  owner: { id: 'anna', name: 'Anna Schmidt' },
  ownerPrincipal: {
    userId: 'anna',
    username: 'anna',
    name: 'Anna Schmidt',
    email: SECRET_EMAIL,
    groups: ['users', 'secret-group'],
    authMode: 'oidc',
    provider: 'entra',
    recorded: true
  },
  ownerPrincipalAt: '2026-11-18T08:12:00Z',
  pendingOwner: {
    id: 'dave',
    name: 'Dave',
    offeredAt: '2026-11-19T10:00:00Z',
    offeredBy: { id: 'anna', name: 'Anna Schmidt' }
  },
  members: [
    { type: 'user', id: 'carol', name: 'Carol', role: 'editor' },
    { type: 'user', id: 'ben', name: 'Ben', role: 'user' },
    { type: 'group', id: 'hr', name: 'HR', role: 'user' }
  ],
  language: 'de',
  origin: 'generated',
  content,
  state: 'active',
  publishedAs: null,
  publishing: { appId: 'in-flight' },
  disabled: null,
  revision: 7,
  contentHash: 'sha256:abc',
  createdAt: '2026-11-01T10:00:00Z',
  createdBy: { id: 'anna', name: 'Anna Schmidt' },
  updatedAt: '2026-11-20T09:00:00Z',
  updatedBy: { id: 'carol', name: 'Carol' },
  membersUpdatedAt: '2026-11-02T10:00:00Z',
  membersUpdatedBy: { id: 'anna', name: 'Anna Schmidt' },
  lastUsedAt: '2026-11-19T10:00:00Z',
  ...extra
});

/** What the ceiling answers for a runner who lacks web search. */
const effective = () => ({
  app: {
    ...personalAppBase(APP_ID),
    name: content.name,
    description: content.description,
    system: content.system,
    icon: content.icon,
    color: content.color,
    variables: [],
    starterPrompts: [],
    upload: PERSONAL_UPLOAD_ON,
    websearch: { enabled: false },
    toolApproval: { default: 'always' },
    // Keys the ceiling never writes. The view must not pass them on.
    projects: ['secret-project'],
    ownerPrincipal: { email: SECRET_EMAIL }
  },
  capabilities: [
    { id: 'upload', requested: true, granted: true },
    { id: 'webSearch', requested: true, granted: false, reason: 'youMayNot' },
    { id: 'skills', requested: false, granted: false, reason: 'notRequested' },
    { id: 'integration:jira', requested: true, granted: false, reason: 'ownerMayNot' },
    { id: 'preferredModel', requested: true, granted: false, reason: 'offOnInstallation' }
  ],
  approval: { mode: 'always', chatGrants: false }
});

const may = { userApps: true, userAppSharing: true };
const USERS = {
  owner: { id: 'anna', groups: ['users'], permissions: may },
  editor: { id: 'carol', groups: ['users'], permissions: may },
  user: { id: 'ben', groups: ['users'], permissions: may },
  offered: { id: 'dave', groups: ['users'], permissions: may },
  admin: { id: 'root', groups: ['admins'], permissions: may, isAdmin: true }
};
const SETTINGS = userAppSettings({ userApps: { sharing: { allowPublish: true } } });
const OWNER = { active: true, mayHold: true, mayShare: true, blocked: false, stale: false };

function viewFor(role, rec = record(), context = {}) {
  const user = USERS[role];
  const permissions = userAppPermissions(rec, user, {
    groups: user.groups,
    isAdmin: user.isAdmin === true,
    owner: OWNER,
    settings: SETTINGS,
    now: NOW
  });
  assert.equal(permissions.role, role);
  return userAppView(rec, {
    permissions,
    effective: effective(),
    owner: OWNER,
    publish: { startsEnabled: false, capabilities: ['upload'], dropped: [] },
    now: NOW,
    ...context
  });
}

/** The keys of the app object, as the ceiling writes them in this fixture. */
const APP_KEYS = [
  'id',
  'type',
  'enabled',
  'sendChatHistory',
  'allowEmptyContent',
  'inputMode',
  'features',
  'name',
  'description',
  'system',
  'icon',
  'color',
  'variables',
  'starterPrompts',
  'upload',
  'websearch',
  'toolApproval'
];
/** The fields every caller who may use the app gets. */
const COMMON_KEYS = [
  ...APP_KEYS,
  'ownership',
  'language',
  'owner',
  'permissions',
  'sharedWith',
  'capabilities',
  'approval',
  'state',
  'disabled',
  'revision',
  'updatedAt',
  'updatedBy'
];
const KEYS_BY_ROLE = {
  owner: [...COMMON_KEYS, 'members', 'pendingOwner', 'publish'],
  editor: [...COMMON_KEYS, 'members'],
  offered: [...COMMON_KEYS, 'members', 'pendingOwner'],
  admin: [...COMMON_KEYS, 'members', 'pendingOwner'],
  user: [...COMMON_KEYS]
};

describe('the view per role has exactly the fields of 9.1', () => {
  for (const [role, keys] of Object.entries(KEYS_BY_ROLE)) {
    it(`${role}`, () => {
      assert.deepEqual(Object.keys(viewFor(role)).sort(), [...keys].sort());
    });
  }

  it('a promoted app adds publishedAs for owner, "Can edit" and a full admin only', () => {
    const promoted = record({
      state: 'promoted',
      pendingOwner: null,
      publishedAs: {
        appId: 'stellenanzeigen-schreiben',
        at: '2026-11-19T10:00:00Z',
        by: { id: 'anna', name: 'Anna Schmidt' }
      }
    });
    for (const role of ['owner', 'editor', 'admin']) {
      const view = viewFor(role, promoted);
      assert.equal(view.state, 'promoted');
      assert.deepEqual(view.publishedAs, promoted.publishedAs, role);
    }
    assert.equal(Object.hasOwn(viewFor('user', promoted), 'publishedAs'), false);
    // The route may pass what the caller is allowed to know about the company app.
    const enriched = viewFor('owner', promoted, {
      publishedAs: { appId: 'stellenanzeigen-schreiben', name: { de: 'X' }, enabled: false }
    });
    assert.equal(enriched.publishedAs.enabled, false);
    // Released by itself: the company app is gone, so there is nothing to point at.
    const released = viewFor('owner', promoted, { publishedAppExists: false });
    assert.equal(released.state, 'active');
    assert.equal(Object.hasOwn(released, 'publishedAs'), false);
  });
});

describe('what no view contains', () => {
  it('never ownerPrincipal, contentHash, the publishing mark or a key the ceiling does not write', () => {
    for (const role of Object.keys(USERS)) {
      const text = JSON.stringify(viewFor(role));
      for (const secret of [
        SECRET_EMAIL,
        'secret-group',
        'ownerPrincipal',
        'contentHash',
        'sha256:abc',
        'in-flight',
        'secret-project',
        'membersUpdatedBy',
        'createdBy',
        'lastUsedAt'
      ]) {
        assert.equal(text.includes(secret), false, `${role}: ${secret}`);
      }
    }
    const admin = JSON.stringify(adminUserAppView(record(), { owner: OWNER, now: NOW }));
    for (const secret of [
      SECRET_EMAIL,
      'secret-group',
      'ownerPrincipal"',
      'sha256:abc',
      'in-flight'
    ]) {
      assert.equal(admin.includes(secret), false, `admin view: ${secret}`);
    }
  });
});

describe('what a person with "Can use" is told', () => {
  it('counts instead of the member list', () => {
    const view = viewFor('user');
    assert.equal(Object.hasOwn(view, 'members'), false);
    assert.deepEqual(view.sharedWith, { users: 2, groups: 1, everyone: false });
    assert.equal(JSON.stringify(view).includes('"HR"'), false, 'no member name is sent');
  });

  it('the granted capabilities, and for a missing one only youMayNot or unavailable', () => {
    const view = viewFor('user');
    assert.deepEqual(view.capabilities, [
      { id: 'upload', granted: true },
      { id: 'webSearch', granted: false, reason: 'youMayNot' },
      { id: 'integration:jira', granted: false, reason: 'unavailable' },
      { id: 'preferredModel', granted: false, reason: 'unavailable' }
    ]);
    const text = JSON.stringify(view.capabilities);
    for (const reason of ['ownerMayNot', 'ownerInactive', 'ownerStale', 'offOnInstallation']) {
      assert.equal(text.includes(reason), false, reason);
    }
    assert.equal(text.includes('requested'), false);
  });

  it('the instructions, the owner and how tool calls are approved', () => {
    const view = viewFor('user');
    assert.deepEqual(view.system, content.system);
    assert.deepEqual(view.owner, { id: 'anna', name: 'Anna Schmidt', active: true });
    assert.deepEqual(view.approval, { mode: 'always', chatGrants: false });
    assert.equal(view.permissions.role, 'user');
    assert.equal(view.revision, 7);
    assert.deepEqual(view.updatedBy, { id: 'carol', name: 'Carol' });
  });
});

describe('what owner, "Can edit", the receiver and a full admin are told', () => {
  it('the member list, what was requested and every reason', () => {
    for (const role of ['owner', 'editor', 'offered', 'admin']) {
      const view = viewFor(role);
      assert.equal(view.members.length, 3, role);
      assert.deepEqual(view.capabilities, [
        { id: 'upload', requested: true, granted: true },
        { id: 'webSearch', requested: true, granted: false, reason: 'youMayNot' },
        { id: 'skills', requested: false, granted: false, reason: 'notRequested' },
        { id: 'integration:jira', requested: true, granted: false, reason: 'ownerMayNot' },
        { id: 'preferredModel', requested: true, granted: false, reason: 'offOnInstallation' }
      ]);
    }
  });

  it('a connected system has its name for every role, and its stored functions for these four', () => {
    const bindings = [
      { id: 'integration:jira', name: { en: 'Jira', de: 'Jira DE' }, actions: ['search', 'read'] }
    ];
    const jira = role =>
      viewFor(role, record(), { effective: { ...effective(), bindings } }).capabilities.find(
        entry => entry.id === 'integration:jira'
      );
    for (const role of ['owner', 'editor', 'offered', 'admin']) {
      assert.deepEqual(
        jira(role),
        {
          id: 'integration:jira',
          name: { en: 'Jira', de: 'Jira DE' },
          requested: true,
          granted: false,
          reason: 'ownerMayNot',
          actions: ['search', 'read']
        },
        role
      );
    }
    // "Can use": the name for the notice, and neither the functions nor the owner's reason.
    assert.deepEqual(jira('user'), {
      id: 'integration:jira',
      name: { en: 'Jira', de: 'Jira DE' },
      granted: false,
      reason: 'unavailable'
    });
  });

  it('the open offer goes to owner, receiver and full admin; a lapsed one reads as none', () => {
    assert.deepEqual(viewFor('owner').pendingOwner, {
      id: 'dave',
      name: 'Dave',
      offeredAt: '2026-11-19T10:00:00Z',
      offeredBy: { id: 'anna', name: 'Anna Schmidt' }
    });
    assert.equal(Object.hasOwn(viewFor('editor'), 'pendingOwner'), false);
    const lapsed = viewFor('owner', record(), { now: NOW + 31 * 24 * 60 * 60 * 1000 });
    assert.equal(lapsed.pendingOwner, null);
  });

  it('what a publish would write goes to the owner alone', () => {
    assert.deepEqual(viewFor('owner').publish, {
      startsEnabled: false,
      capabilities: ['upload'],
      dropped: []
    });
    for (const role of ['editor', 'offered', 'admin', 'user']) {
      assert.equal(Object.hasOwn(viewFor(role), 'publish'), false, role);
    }
  });

  it('a switched-off app says when and why, not who', () => {
    const off = record({
      disabled: { at: '2026-11-19T10:00:00Z', by: { id: 'root', name: 'Root' }, reason: 'Review' }
    });
    assert.deepEqual(viewFor('owner', off).disabled, {
      at: '2026-11-19T10:00:00Z',
      reason: 'Review'
    });
  });
});

describe('the reduced and the retired body', () => {
  it('reduced: who and why, without instructions and capabilities', () => {
    const off = record({
      disabled: { at: '2026-11-19T10:00:00Z', by: { id: 'root' }, reason: 'x' }
    });
    const permissions = userAppPermissions(off, USERS.user, {
      groups: ['users'],
      owner: OWNER,
      settings: SETTINGS,
      now: NOW
    });
    const view = reducedUserAppView(off, { permissions, owner: OWNER });
    assert.deepEqual(Object.keys(view).sort(), [
      'color',
      'disabled',
      'icon',
      'id',
      'name',
      'owner',
      'ownership',
      'permissions',
      'state'
    ]);
    assert.equal(view.permissions.canUse, false);
    assert.equal(JSON.stringify(view).includes('Du schreibst'), false);

    const suspended = userAppPermissions(record(), USERS.user, {
      groups: ['users'],
      owner: { ...OWNER, mayShare: false },
      settings: SETTINGS,
      now: NOW
    });
    assert.equal(
      reducedUserAppView(record(), { permissions: suspended, owner: OWNER }).permissions.suspended,
      'ownerMayNotShare'
    );
  });

  it('retired: the pointer to the company app and nothing of the personal app', () => {
    const view = retiredUserAppView(record(), {
      appId: 'stellenanzeigen-schreiben',
      name: { de: 'Stellenanzeigen schreiben' }
    });
    assert.deepEqual(view, {
      id: APP_ID,
      ownership: 'user',
      state: 'retired',
      publishedAs: {
        appId: 'stellenanzeigen-schreiben',
        name: { de: 'Stellenanzeigen schreiben' },
        enabled: true
      }
    });
  });
});

describe('the admin views (9.2)', () => {
  it('a list item has the fields of the example and the owner without the principal', () => {
    const promoted = record({
      state: 'promoted',
      pendingOwner: null,
      publishedAs: {
        appId: 'stellenanzeigen-schreiben',
        at: '2026-11-19T10:00:00Z',
        by: { id: 'anna', name: 'Anna Schmidt' }
      }
    });
    const item = adminUserAppListItem(promoted, {
      owner: { ...OWNER, stale: false },
      publishedAppEnabled: false,
      now: NOW
    });
    assert.deepEqual(item, {
      id: APP_ID,
      name: 'Stellenanzeigen schreiben',
      icon: 'document-text',
      color: '#4F46E5',
      owner: {
        id: 'anna',
        name: 'Anna Schmidt',
        active: true,
        rightsCheckedAt: '2026-11-18T08:12:00Z',
        stale: false
      },
      pendingOwner: null,
      state: 'promoted',
      disabled: null,
      clash: false,
      publishedAs: {
        appId: 'stellenanzeigen-schreiben',
        at: '2026-11-19T10:00:00Z',
        by: { id: 'anna', name: 'Anna Schmidt' },
        enabled: false
      },
      sharedWith: { users: 2, groups: 1, everyone: false },
      capabilities: ['upload', 'webSearch', 'integrations'],
      revision: 7,
      updatedAt: '2026-11-20T09:00:00Z',
      lastUsedAt: '2026-11-19T10:00:00Z'
    });
  });

  it('says who switched an app off, an ID clash, and an inactive or stale owner', () => {
    const off = record({
      disabled: { at: '2026-11-19T10:00:00Z', by: { id: 'root', name: 'Root' }, reason: 'Review' }
    });
    const item = adminUserAppListItem(off, {
      owner: { ...OWNER, active: false, stale: true },
      clash: true,
      now: NOW
    });
    assert.deepEqual(item.disabled.by, { id: 'root', name: 'Root' });
    assert.equal(item.clash, true);
    assert.equal(item.owner.active, false);
    assert.equal(item.owner.stale, true);
    assert.equal(item.pendingOwner.id, 'dave');
  });

  it('the view of one app adds content, members, language, origin and revision', () => {
    const view = adminUserAppView(record(), {
      owner: OWNER,
      takeOverPreview: { capabilities: ['upload'], dropped: [] },
      now: NOW
    });
    assert.deepEqual(view.content, content);
    assert.equal(view.members.length, 3);
    assert.equal(view.language, 'de');
    assert.equal(view.origin, 'generated');
    assert.equal(view.revision, 7);
    assert.deepEqual(view.takeOverPreview, { capabilities: ['upload'], dropped: [] });
    assert.equal(Object.hasOwn(view, 'membersWithoutCompanyApp'), false);

    const promoted = record({ state: 'promoted', publishedAs: { appId: 'x', at: 'y', by: null } });
    assert.equal(
      adminUserAppView(promoted, { owner: OWNER, membersWithoutCompanyApp: 3 })
        .membersWithoutCompanyApp,
      3
    );
  });

  it('a content state is sent with who saved it', () => {
    assert.deepEqual(
      userAppRevisionView({
        version: 1,
        appId: APP_ID,
        revision: 4,
        contentHash: 'sha256:abc',
        content,
        ownerId: 'anna',
        savedAt: '2026-11-20T09:00:00Z',
        savedBy: { id: 'carol', name: 'Carol' }
      }),
      {
        revision: 4,
        contentHash: 'sha256:abc',
        content,
        savedAt: '2026-11-20T09:00:00Z',
        savedBy: { id: 'carol', name: 'Carol' }
      }
    );
  });
});

describe('the ETag', () => {
  it('is the revision, quoted, and If-Match is read back from any of its spellings', () => {
    assert.equal(userAppEtag(record()), '"7"');
    assert.equal(revisionFromIfMatch('"7"'), 7);
    assert.equal(revisionFromIfMatch('W/"7"'), 7);
    assert.equal(revisionFromIfMatch('7'), 7);
    assert.equal(revisionFromIfMatch(userAppEtag(record())), 7);
  });

  it('answers null for a missing header, "*" and anything that is not a revision', () => {
    for (const header of [undefined, null, '', '*', '"abc"', '"7", "8"', '-1', 7]) {
      assert.equal(revisionFromIfMatch(header), null, String(header));
    }
  });

  it('counts members by kind', () => {
    assert.deepEqual(sharedWithCounts({ members: [{ type: 'everyone' }, { type: 'user' }] }), {
      users: 1,
      groups: 0,
      everyone: true
    });
    assert.deepEqual(sharedWithCounts({}), { users: 0, groups: 0, everyone: false });
  });
});
