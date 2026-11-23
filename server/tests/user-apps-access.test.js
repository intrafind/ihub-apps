// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who may do what with a personal app (feature `userApps`, design section 5).
 *
 * The first block is the table of section 5, one assertion per cell. The
 * blocks after it are the modifiers that apply on top of the table: the
 * strongest role, the three conditions of sharing and of publishing, shares
 * of an owner who may no longer hold or share, an inactive owner, a promoted
 * and a switched-off app, a personal API key, and the owner lookup of 6.2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_ACCESS,
  OFFER_TTL_MS,
  UNKNOWN_OWNER,
  canHoldUserApps,
  effectiveUserAppState,
  hasDirectShare,
  isOwnerSnapshotStale,
  lookupUserAppOwner,
  mayCreateUserApps,
  mayShareUserApps,
  memberRoleFor,
  openOffer,
  ownerLookupFromRequest,
  ownerSnapshotNeedsRefresh,
  principalMemberKeys,
  satisfiesUserAppLevel,
  userAppOwnerSnapshot,
  userAppPermissions
} from '../services/userApps/userAppAccess.js';
import { resolveOwnerPrincipal } from '../services/scheduler/tasks/ownerPrincipal.js';
import configCache from '../configCache.js';
import { userAppSettings } from '../services/userApps/userAppSettings.js';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const APP_ID = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';

const may = { userApps: true, userAppSharing: true };
const person = (id, extra = {}) => ({
  id,
  name: id,
  groups: ['users'],
  permissions: { ...may },
  ...extra
});

const ALICE = person('alice'); // owner
const CAROL = person('carol'); // "Can edit"
const BOB = person('bob'); // "Can use", direct
const GINA = person('gina', { groups: ['users', 'hr'] }); // "Can use", through a group
const EVE = person('eve'); // "Can use", through everyone (on a second record)
const DAVE = person('dave'); // receiver of the offer
const ROOT = person('root', { groups: ['admins'], isAdmin: true }); // full admin, no member
const CONNIE = person('connie', { isContentAdmin: true }); // content admin, no member
const MALLORY = person('mallory'); // no share

const record = (extra = {}) => ({
  id: APP_ID,
  ownership: 'user',
  owner: { id: 'alice', name: 'Alice' },
  ownerPrincipal: { userId: 'alice', groups: ['users'], authMode: 'local', recorded: true },
  ownerPrincipalAt: '2026-11-20T09:00:00Z',
  pendingOwner: {
    id: 'dave',
    name: 'Dave',
    offeredAt: '2026-11-19T10:00:00Z',
    offeredBy: { id: 'alice', name: 'Alice' }
  },
  members: [
    { type: 'user', id: 'carol', name: 'Carol', role: 'editor' },
    { type: 'user', id: 'bob', name: 'Bob', role: 'user' },
    { type: 'group', id: 'hr', name: 'HR', role: 'user' }
  ],
  state: 'active',
  publishedAs: null,
  disabled: null,
  revision: 3,
  ...extra
});

const SETTINGS = userAppSettings({ userApps: { sharing: { allowPublish: true } } });
const OWNER_OK = { active: true, mayHold: true, mayShare: true, blocked: false, stale: false };

/** The permission block of `user` on `rec`, with everything in order unless said otherwise. */
function permissionsOf(user, rec = record(), context = {}) {
  return userAppPermissions(rec, user, {
    groups: user.groups || [],
    isAdmin: user.isAdmin === true,
    owner: OWNER_OK,
    settings: SETTINGS,
    now: NOW,
    ...context
  });
}

/** The seven columns of the table of section 5. */
function row(permissions) {
  return {
    view: permissions.canView,
    chat: permissions.canUse,
    edit: permissions.canEdit,
    members: permissions.canShare,
    offer: permissions.canOffer,
    publish: permissions.canPublish,
    delete: permissions.canDelete
  };
}

const NOTHING = {
  view: false,
  chat: false,
  edit: false,
  members: false,
  offer: false,
  publish: false,
  delete: false
};
const USE_ONLY = { ...NOTHING, view: true, chat: true };
const VIEW_ONLY = { ...NOTHING, view: true };

describe('the table of section 5', () => {
  it('owner: everything', () => {
    const permissions = permissionsOf(ALICE);
    assert.deepEqual(row(permissions), {
      view: true,
      chat: true,
      edit: true,
      members: true,
      offer: true,
      publish: true,
      delete: true
    });
    assert.equal(permissions.role, 'owner');
    assert.equal(permissions.isOwner, true);
  });

  it('"Can edit": view, chat, edit and members; no offer, no publish, no delete', () => {
    const permissions = permissionsOf(CAROL);
    assert.deepEqual(row(permissions), {
      view: true,
      chat: true,
      edit: true,
      members: true,
      offer: false,
      publish: false,
      delete: false
    });
    assert.equal(permissions.role, 'editor');
  });

  it('"Can use", direct: view and chat', () => {
    const permissions = permissionsOf(BOB);
    assert.deepEqual(row(permissions), USE_ONLY);
    assert.equal(permissions.role, 'user');
  });

  it('"Can use", through a group: view and chat', () => {
    assert.deepEqual(row(permissionsOf(GINA)), USE_ONLY);
    assert.equal(permissionsOf(GINA).role, 'user');
  });

  it('"Can use", through everyone: view and chat', () => {
    const shared = record({ members: [{ type: 'everyone', id: null, role: 'user' }] });
    assert.deepEqual(row(permissionsOf(EVE, shared)), USE_ONLY);
    assert.equal(permissionsOf(EVE, shared).role, 'user');
  });

  it('receiver of an open offer: view and chat, and may accept', () => {
    const permissions = permissionsOf(DAVE);
    assert.deepEqual(row(permissions), USE_ONLY);
    assert.equal(permissions.role, 'offered');
    assert.equal(permissions.canAcceptOffer, true);
    for (const other of [ALICE, CAROL, BOB, ROOT]) {
      assert.equal(permissionsOf(other).canAcceptOffer, false, other.id);
    }
  });

  it('only a share that names the caller can be left', () => {
    assert.equal(permissionsOf(BOB).canLeave, true);
    assert.equal(permissionsOf(CAROL).canLeave, true);
    assert.equal(permissionsOf(GINA).canLeave, false);
    const shared = record({ members: [{ type: 'everyone', id: null, role: 'user' }] });
    assert.equal(permissionsOf(EVE, shared).canLeave, false);
    for (const other of [ALICE, DAVE, ROOT]) {
      assert.equal(permissionsOf(other).canLeave, false, other.id);
    }
  });

  it('full admin, not a member: view, chat, offer and delete; never edit or members', () => {
    const permissions = permissionsOf(ROOT);
    assert.deepEqual(row(permissions), {
      view: true,
      chat: true,
      edit: false,
      members: false,
      offer: true,
      publish: false,
      delete: true
    });
    assert.equal(permissions.role, 'admin');
  });

  it('content admin, not a member: nothing', () => {
    const permissions = userAppPermissions(record(), CONNIE, {
      groups: CONNIE.groups,
      isAdmin: false,
      isContentAdmin: true,
      owner: OWNER_OK,
      settings: SETTINGS,
      now: NOW
    });
    assert.deepEqual(row(permissions), NOTHING);
    assert.equal(permissions, NO_ACCESS);
  });

  it('signed-in user without a share: nothing', () => {
    assert.deepEqual(row(permissionsOf(MALLORY)), NOTHING);
    assert.equal(permissionsOf(MALLORY).role, null);
  });

  it('anonymous, OAuth client, agent and authorization-code token: nothing, whatever names them', () => {
    const everyone = record({ members: [{ type: 'everyone', id: null, role: 'editor' }] });
    const excluded = {
      anonymous: { id: 'anonymous', groups: ['anonymous'], permissions: { ...may } },
      'no user': undefined,
      'OAuth client': person('client-1', { isOAuthClient: true }),
      agent: person('agent-1', { isAgent: true }),
      'authorization-code token of the owner': person('alice', {
        authMode: 'oauth_authorization_code'
      }),
      'authorization-code token of an admin': person('root', {
        authMode: 'oauth_authorization_code',
        isAdmin: true
      })
    };
    for (const [name, user] of Object.entries(excluded)) {
      for (const rec of [record(), everyone]) {
        const permissions = userAppPermissions(rec, user, {
          groups: user?.groups || [],
          isAdmin: user?.isAdmin === true,
          owner: OWNER_OK,
          settings: SETTINGS,
          now: NOW
        });
        assert.deepEqual(row(permissions), NOTHING, name);
      }
      assert.equal(canHoldUserApps(user), false, name);
    }
  });
});

describe('modifier: the strongest role wins, and the group "anonymous" is no target', () => {
  it('an editor through a group outranks a direct "Can use"', () => {
    const rec = record({
      members: [
        { type: 'user', id: 'gina', role: 'user' },
        { type: 'group', id: 'hr', role: 'editor' }
      ]
    });
    assert.equal(memberRoleFor(rec, GINA, GINA.groups), 'editor');
    assert.equal(permissionsOf(GINA, rec).canEdit, true);
  });

  it('a member entry for the group "anonymous" reaches nobody', () => {
    const rec = record({
      pendingOwner: null,
      members: [{ type: 'group', id: 'anonymous', role: 'editor' }]
    });
    const inheriting = person('ines', { groups: ['users', 'anonymous'] });
    assert.equal(memberRoleFor(rec, inheriting, inheriting.groups), null);
    assert.deepEqual(row(permissionsOf(inheriting, rec)), NOTHING);
    assert.equal(
      principalMemberKeys(inheriting, inheriting.groups).includes('group:anonymous'),
      false
    );
  });

  it('a membership outranks the offer and the admin view as a role', () => {
    const rec = record({ members: [{ type: 'user', id: 'dave', role: 'editor' }] });
    assert.equal(permissionsOf(DAVE, rec).role, 'editor');
    assert.equal(permissionsOf(DAVE, rec).canAcceptOffer, true);
    const adminMember = record({ members: [{ type: 'user', id: 'root', role: 'user' }] });
    const permissions = permissionsOf(ROOT, adminMember);
    assert.equal(permissions.role, 'user');
    assert.equal(permissions.canDelete, true, 'a full admin still deletes');
    assert.equal(permissions.canEdit, false);
  });

  it('a share that names a user reaches that user only', () => {
    assert.equal(hasDirectShare(record(), BOB), true);
    assert.equal(hasDirectShare(record(), GINA), false, 'through a group is not direct');
    assert.equal(hasDirectShare(record(), ALICE), false);
  });
});

describe('modifier: sharing needs three things', () => {
  it('the caller is owner or editor', () => {
    for (const user of [BOB, GINA, DAVE, ROOT, MALLORY]) {
      assert.equal(permissionsOf(user).canShare, false, user.id);
    }
  });

  it('the caller holds userAppSharing', () => {
    const withoutSharing = { userApps: true, userAppSharing: false };
    assert.equal(permissionsOf({ ...CAROL, permissions: withoutSharing }).canShare, false);
    assert.equal(permissionsOf({ ...CAROL, permissions: withoutSharing }).canEdit, true);
    assert.equal(mayShareUserApps({ ...CAROL, permissions: withoutSharing }), false);
  });

  it('the owner holds userAppSharing too: a member update by an editor is refused without it', () => {
    const ownerMayNotShare = { ...OWNER_OK, mayShare: false };
    const permissions = permissionsOf(CAROL, record(), { owner: ownerMayNotShare });
    assert.equal(permissions.canShare, false);
    assert.equal(satisfiesUserAppLevel(permissions, 'share'), false);
  });

  it('an owner without userAppSharing keeps the app and cannot share or publish it', () => {
    const owner = { ...ALICE, permissions: { userApps: true, userAppSharing: false } };
    const permissions = permissionsOf(owner, record(), {
      owner: ownerLookupFromRequest(owner, SETTINGS)
    });
    assert.deepEqual(row(permissions), {
      view: true,
      chat: true,
      edit: true,
      members: false,
      offer: true,
      publish: false,
      delete: true
    });
    assert.equal(permissions.suspended, null);
  });
});

describe('modifier: publishing needs three things', () => {
  it('the caller is the owner: an editor and a full admin never publish', () => {
    assert.equal(permissionsOf(ALICE).canPublish, true);
    assert.equal(permissionsOf(CAROL).canPublish, false);
    assert.equal(permissionsOf(ROOT).canPublish, false);
  });

  it('the owner holds userAppSharing', () => {
    const owner = { ...ALICE, permissions: { userApps: true, userAppSharing: false } };
    assert.equal(permissionsOf(owner).canPublish, false);
  });

  it('the setting sharing.allowPublish is on, and it is off by default', () => {
    assert.equal(
      permissionsOf(ALICE, record(), { settings: userAppSettings({}) }).canPublish,
      false
    );
    assert.equal(permissionsOf(ALICE, record(), { settings: undefined }).canPublish, false);
  });

  it('only for an app that is active, not switched off and not of a blocked owner', () => {
    assert.equal(permissionsOf(ALICE, record({ state: 'promoted' })).canPublish, false);
    assert.equal(permissionsOf(ALICE, record({ disabled: { at: 'x' } })).canPublish, false);
    assert.equal(
      permissionsOf(ALICE, record(), { owner: { ...OWNER_OK, blocked: true } }).canPublish,
      false
    );
  });
});

describe('modifier: shares count only while the owner may hold and share', () => {
  const cases = {
    'the owner lost userApps': { ...OWNER_OK, mayHold: false },
    'the owner lost userAppSharing': { ...OWNER_OK, mayShare: false }
  };

  for (const [name, owner] of Object.entries(cases)) {
    it(`${name}: every member sees the app and can do nothing else`, () => {
      for (const user of [CAROL, BOB, GINA, DAVE]) {
        const permissions = permissionsOf(user, record(), { owner });
        assert.deepEqual(row(permissions), VIEW_ONLY, user.id);
        assert.equal(permissions.suspended, 'ownerMayNotShare', user.id);
      }
      assert.deepEqual(row(permissionsOf(MALLORY, record(), { owner })), NOTHING);
    });

    it(`${name}: a full admin still reads and chats`, () => {
      const permissions = permissionsOf(ROOT, record(), { owner });
      assert.equal(permissions.canUse, true);
      assert.equal(permissions.suspended, null);
    });
  }

  it('the owner is on blockedOwners: nobody chats, and the owner is locked out of changes', () => {
    const owner = { ...OWNER_OK, blocked: true };
    for (const user of [CAROL, BOB, GINA, DAVE]) {
      const permissions = permissionsOf(user, record(), { owner });
      assert.deepEqual(row(permissions), VIEW_ONLY, user.id);
      assert.equal(permissions.suspended, 'ownerBlocked', user.id);
    }
    const own = permissionsOf(ALICE, record(), { owner });
    assert.equal(own.canUse, false, 'a blocked owner cannot chat either');
    assert.equal(own.canView, true, 'the owner still sees the app');
    // Locked out: no edit, no members, no delete (ticket #3897).
    assert.equal(own.canEdit, false);
    assert.equal(own.canShare, false);
    assert.equal(own.canDelete, false);
    assert.equal(own.canPublish, false);
    assert.equal(satisfiesUserAppLevel(own, 'edit'), false);
    assert.equal(satisfiesUserAppLevel(own, 'delete'), false);
    // ... but cannot hand the app past the block, and an earlier offer of the
    // owner cannot be accepted. An admin may still offer it.
    assert.equal(own.canOffer, false);
    assert.equal(permissionsOf(DAVE, record(), { owner }).canAcceptOffer, false);
    assert.equal(permissionsOf(ROOT, record(), { owner }).canOffer, true);
    const byAdmin = record({
      pendingOwner: { ...record().pendingOwner, offeredBy: { id: 'root', name: 'Root' } }
    });
    assert.equal(permissionsOf(DAVE, byAdmin, { owner }).canAcceptOffer, true);
    assert.equal(own.suspended, 'ownerBlocked');
    // An admin keeps every admin ability, and still never edits.
    const admin = permissionsOf(ROOT, record(), { owner });
    assert.equal(admin.canUse, false);
    assert.equal(admin.canDelete, true);
    assert.equal(admin.canOffer, true);
    assert.equal(admin.canEdit, false);
    // An editor of the blocked owner cannot edit or share either.
    const editor = permissionsOf(CAROL, record(), { owner });
    assert.equal(editor.canEdit, false);
    assert.equal(editor.canShare, false);
  });

  it('a blocked person cannot create, and an unblocked one with the permission can', () => {
    const blocking = userAppSettings({ userApps: { blockedOwners: ['alice'] } });
    assert.equal(mayCreateUserApps(ALICE, blocking), false);
    assert.equal(mayCreateUserApps(BOB, blocking), true);
    assert.equal(mayCreateUserApps({ ...BOB, permissions: { userApps: false } }, blocking), false);
    assert.equal(mayCreateUserApps(person('client', { isOAuthClient: true }), blocking), false);
  });

  it('without an owner lookup no share grants anything', () => {
    for (const user of [CAROL, BOB]) {
      const permissions = userAppPermissions(record(), user, { groups: user.groups, now: NOW });
      assert.deepEqual(row(permissions), VIEW_ONLY, user.id);
    }
    assert.equal(UNKNOWN_OWNER.mayShare, false);
  });

  it('while the shares are suspended the receiver accepts only an offer of a full admin', () => {
    const owner = { ...OWNER_OK, mayHold: false };
    // The owner's own offer would hand the app past the missing permission.
    const ownOffer = permissionsOf(DAVE, record(), { owner });
    assert.equal(ownOffer.canUse, false);
    assert.equal(ownOffer.canAcceptOffer, false);
    const byAdmin = record({
      pendingOwner: { ...record().pendingOwner, offeredBy: { id: 'root', name: 'Root' } }
    });
    const adminOffer = permissionsOf(DAVE, byAdmin, { owner });
    assert.equal(adminOffer.canUse, false);
    assert.equal(adminOffer.canAcceptOffer, true);
  });
});

describe('modifier: the owner is inactive', () => {
  const owner = { ...OWNER_OK, active: false };

  it('editors lose "Edit" and "Members" and are read-only; chat stays', () => {
    const permissions = permissionsOf(CAROL, record(), { owner });
    assert.deepEqual(row(permissions), USE_ONLY);
    assert.equal(permissions.readOnly, true);
    assert.equal(permissions.role, 'editor');
  });

  it('"Can use" members keep chatting, and a full admin can offer the app', () => {
    assert.deepEqual(row(permissionsOf(BOB, record(), { owner })), USE_ONLY);
    assert.equal(permissionsOf(ROOT, record(), { owner }).canOffer, true);
  });
});

describe('modifier: a promoted app', () => {
  const promoted = record({
    state: 'promoted',
    pendingOwner: null,
    publishedAs: { appId: 'job-ad-writer', at: '2026-11-19T10:00:00Z', by: { id: 'alice' } }
  });

  it('nobody edits, shares, offers or publishes; chat and delete stay', () => {
    const own = permissionsOf(ALICE, promoted);
    assert.deepEqual(row(own), { ...USE_ONLY, delete: true });
    assert.equal(own.readOnly, true);
    assert.deepEqual(row(permissionsOf(CAROL, promoted)), USE_ONLY);
    assert.deepEqual(row(permissionsOf(BOB, promoted)), USE_ONLY);
    assert.deepEqual(row(permissionsOf(ROOT, promoted)), { ...USE_ONLY, delete: true });
  });

  it('retired for a caller: that caller sees the pointer and cannot chat', () => {
    const permissions = permissionsOf(BOB, promoted, { retired: true });
    assert.deepEqual(row(permissions), VIEW_ONLY);
    assert.equal(permissionsOf(ALICE, promoted, { retired: true }).canDelete, true);
  });

  it('is active again when its company app no longer exists', () => {
    assert.equal(effectiveUserAppState(promoted), 'promoted');
    assert.equal(effectiveUserAppState(promoted, { publishedAppExists: false }), 'active');
    const permissions = permissionsOf(ALICE, promoted, { publishedAppExists: false });
    assert.equal(permissions.canEdit, true);
    assert.equal(permissions.readOnly, false);
  });
});

describe('modifier: a switched-off app', () => {
  const off = record({ disabled: { at: '2026-11-19T10:00:00Z', by: { id: 'root' }, reason: 'x' } });

  it('only a full admin chats', () => {
    assert.equal(permissionsOf(ROOT, off).canUse, true);
    for (const user of [ALICE, CAROL, BOB, GINA, DAVE]) {
      assert.equal(permissionsOf(user, off).canUse, false, user.id);
    }
  });

  it('owner and members still see it; the owner can delete and cannot edit, share or offer', () => {
    const own = permissionsOf(ALICE, off);
    assert.deepEqual(row(own), { ...VIEW_ONLY, delete: true });
    assert.equal(own.readOnly, true);
    assert.deepEqual(row(permissionsOf(CAROL, off)), VIEW_ONLY);
    assert.deepEqual(row(permissionsOf(BOB, off)), VIEW_ONLY);
    assert.equal(permissionsOf(DAVE, off).canAcceptOffer, false);
    assert.equal(permissionsOf(ROOT, off).canOffer, false);
  });
});

describe('modifier: a personal API key reaches only the apps its user owns', () => {
  const key = user => ({ ...user, authMode: 'oauth_personal_key' });

  it('acts as its user on an own app', () => {
    const permissions = permissionsOf(key(ALICE));
    assert.equal(permissions.role, 'owner');
    assert.equal(permissions.canUse, true);
    assert.equal(permissions.canEdit, true);
    assert.equal(permissions.canDelete, true);
  });

  it('has no access to an app shared with its user, as editor, user or receiver', () => {
    for (const user of [CAROL, BOB, GINA, DAVE]) {
      assert.equal(permissionsOf(key(user)), NO_ACCESS, user.id);
      assert.deepEqual(principalMemberKeys(key(user), user.groups), [], user.id);
    }
  });

  it('cannot be an admin', () => {
    assert.equal(permissionsOf(key(ROOT)), NO_ACCESS);
    const ownedByRoot = record({ owner: { id: 'root', name: 'Root' }, pendingOwner: null });
    assert.equal(permissionsOf(key(ROOT), ownedByRoot).role, 'owner');
  });
});

describe('the offer', () => {
  it('lapses 30 days after it was made; a lapsed offer is none', () => {
    const offeredAt = Date.parse(record().pendingOwner.offeredAt);
    assert.equal(openOffer(record(), offeredAt + OFFER_TTL_MS - 1)?.id, 'dave');
    assert.equal(openOffer(record(), offeredAt + OFFER_TTL_MS), null);
    const late = permissionsOf(DAVE, record(), { now: offeredAt + OFFER_TTL_MS });
    assert.equal(late, NO_ACCESS);
    assert.equal(openOffer(record({ pendingOwner: null }), NOW), null);
  });
});

describe('access levels', () => {
  it('map onto the permission block', () => {
    const own = permissionsOf(ALICE);
    for (const level of ['view', 'use', 'edit', 'share', 'own', 'delete', 'offer']) {
      assert.equal(satisfiesUserAppLevel(own, level), true, level);
      assert.equal(satisfiesUserAppLevel(NO_ACCESS, level), false, level);
    }
    const admin = permissionsOf(ROOT);
    assert.equal(satisfiesUserAppLevel(admin, 'own'), false, 'an admin is not the owner');
    assert.equal(satisfiesUserAppLevel(admin, 'delete'), true);
    assert.equal(satisfiesUserAppLevel(admin, 'offer'), true);
    assert.equal(satisfiesUserAppLevel(own, 'publish'), false, 'an unknown level never passes');
  });
});

describe('the owner lookup (6.2)', () => {
  const resolved = permissions => () => ({
    ok: true,
    user: { id: 'alice', groups: ['users'], permissions }
  });

  it('an active owner with both permissions', () => {
    const owner = lookupUserAppOwner(record(), {
      settings: SETTINGS,
      resolve: resolved(may),
      now: NOW
    });
    assert.deepEqual(
      {
        active: owner.active,
        mayHold: owner.mayHold,
        mayShare: owner.mayShare,
        blocked: owner.blocked
      },
      { active: true, mayHold: true, mayShare: true, blocked: false }
    );
    assert.equal(owner.principal.id, 'alice');
  });

  it('reads the two permissions from the principal as resolved now', () => {
    const noSharing = lookupUserAppOwner(record(), {
      settings: SETTINGS,
      resolve: resolved({ userApps: true, userAppSharing: false }),
      now: NOW
    });
    assert.equal(noSharing.mayHold, true);
    assert.equal(noSharing.mayShare, false);
    const nothing = lookupUserAppOwner(record(), {
      settings: SETTINGS,
      resolve: resolved({}),
      now: NOW
    });
    assert.equal(nothing.mayHold, false);
    assert.equal(nothing.mayShare, false);
  });

  it('a deactivated, deleted or unresolvable owner is inactive and has no principal', () => {
    for (const code of ['OWNER_DEACTIVATED', 'OWNER_DELETED', 'OWNER_LOOKUP_FAILED']) {
      const owner = lookupUserAppOwner(record(), {
        settings: SETTINGS,
        resolve: () => ({ ok: false, code }),
        now: NOW
      });
      assert.equal(owner.active, false, code);
      assert.equal(owner.principal, null, code);
      assert.equal(owner.reason, code);
      // The app stays usable as plain chat (8.5): the unknown answer does not suspend shares.
      assert.deepEqual(row(permissionsOf(BOB, record(), { owner })), USE_ONLY, code);
      assert.equal(permissionsOf(CAROL, record(), { owner }).canEdit, false, code);
    }
    const thrown = lookupUserAppOwner(record(), {
      settings: SETTINGS,
      resolve: () => {
        throw new Error('users.json unreadable');
      },
      now: NOW
    });
    assert.equal(thrown.active, false);
  });

  it('knows a blocked owner from the settings', () => {
    const settings = userAppSettings({ userApps: { blockedOwners: ['alice'] } });
    assert.equal(
      lookupUserAppOwner(record(), { settings, resolve: resolved(may), now: NOW }).blocked,
      true
    );
    assert.equal(ownerLookupFromRequest(ALICE, settings).blocked, true);
  });

  it('an identity-provider owner is stale after 30 days, a local owner never', () => {
    const oidc = age =>
      record({
        ownerPrincipal: { userId: 'alice', groups: ['users'], authMode: 'oidc', recorded: false },
        ownerPrincipalAt: new Date(NOW - age * 24 * 60 * 60 * 1000).toISOString()
      });
    assert.equal(isOwnerSnapshotStale(oidc(29), SETTINGS, NOW), false);
    assert.equal(isOwnerSnapshotStale(oidc(31), SETTINGS, NOW), true);
    const local = record({ ownerPrincipalAt: '2020-01-01T00:00:00Z' });
    assert.equal(isOwnerSnapshotStale(local, SETTINGS, NOW), false);
    const never = userAppSettings({ userApps: { limits: { ownerSnapshotMaxAgeDays: 0 } } });
    assert.equal(isOwnerSnapshotStale(oidc(400), never, NOW), false);

    const owner = lookupUserAppOwner(oidc(31), {
      settings: SETTINGS,
      resolve: resolved(may),
      now: NOW
    });
    assert.equal(owner.stale, true);
    // Staleness does not suspend the shares: members still open the app.
    assert.deepEqual(row(permissionsOf(BOB, oidc(31), { owner })), USE_ONLY);
  });

  it('a request of the owner rewrites the snapshot when the groups differ or after a day', () => {
    const fresh = record();
    assert.equal(ownerSnapshotNeedsRefresh(fresh, { ...ALICE, authMode: 'local' }, NOW), false);
    assert.equal(
      ownerSnapshotNeedsRefresh(
        fresh,
        { ...ALICE, authMode: 'local', groups: ['users', 'hr'] },
        NOW
      ),
      true
    );
    const old = record({ ownerPrincipalAt: '2026-11-19T09:59:00Z' });
    assert.equal(ownerSnapshotNeedsRefresh(old, { ...ALICE, authMode: 'local' }, NOW), true);
    assert.equal(ownerSnapshotNeedsRefresh(record({ ownerPrincipal: null }), ALICE, NOW), true);
  });

  describe('a request with the personal API key of the owner', () => {
    const KEY = {
      ...ALICE,
      authMode: 'oauth_personal_key',
      isPersonalApiKey: true,
      // The groups the key was created with.
      groups: ['users', 'authenticated']
    };
    const PLATFORM = { auth: {} };
    const usersJson = internalGroups => ({
      found: true,
      record: { id: 'alice', passwordHash: '$2b$12$x', internalGroups, active: true }
    });

    it('never rewrites a stored snapshot', () => {
      const old = record({ ownerPrincipalAt: '2026-11-01T00:00:00Z' });
      assert.equal(ownerSnapshotNeedsRefresh(record(), KEY, NOW), false);
      assert.equal(ownerSnapshotNeedsRefresh(old, KEY, NOW), false);
      // Without any snapshot the key's request stores one.
      assert.equal(ownerSnapshotNeedsRefresh(record({ ownerPrincipal: null }), KEY, NOW), true);
    });

    it('records a local account as local, with the groups of users.json', () => {
      const snapshot = userAppOwnerSnapshot(KEY, {
        platform: PLATFORM,
        lookupUser: () => usersJson(['hr'])
      });
      assert.equal(snapshot.authMode, 'local');
      assert.ok(snapshot.groups.includes('hr'));
      assert.ok(!snapshot.groups.includes('users'));
    });

    it('keeps the key snapshot for an account without a local record', () => {
      const snapshot = userAppOwnerSnapshot(KEY, {
        platform: PLATFORM,
        lookupUser: () => ({ found: true, record: { id: 'alice', authMethods: ['oidc'] } })
      });
      assert.equal(snapshot.authMode, 'oauth_personal_key');
    });

    it('a group removal in users.json still suspends the shares after a key request', t => {
      // users.json now has alice in a group without the two permissions.
      const lookupUser = () => usersJson(['restricted']);
      const platform = {
        auth: {},
        groups: {
          groups: {
            users: { id: 'users', permissions: { userApps: true, userAppSharing: true } },
            restricted: { id: 'restricted', permissions: {} }
          }
        }
      };
      // The permissions come from the cached groups, not from contents/ on disk.
      const before = configCache.cache.get('config/groups.json');
      configCache.cache.set('config/groups.json', { data: platform.groups });
      t.after(() => {
        if (before) configCache.cache.set('config/groups.json', before);
        else configCache.cache.delete('config/groups.json');
      });
      const snapshot = userAppOwnerSnapshot(KEY, { platform, lookupUser });
      const stored = record({ ownerPrincipal: snapshot });
      const owner = lookupUserAppOwner(stored, {
        settings: SETTINGS,
        now: NOW,
        resolve: task => {
          const result = resolveOwnerPrincipal(task, { platform, lookupUser });
          // Report the groups the lookup used, as resolved now.
          return result.ok
            ? {
                ok: true,
                user: {
                  ...result.user,
                  permissions: result.user.groups.includes('users') ? may : {}
                }
              }
            : result;
        }
      });
      assert.equal(owner.principal.groups.includes('users'), false);
      assert.equal(permissionsOf(BOB, stored, { owner }).suspended, 'ownerMayNotShare');
      assert.equal(permissionsOf(BOB, stored, { owner }).canUse, false);
    });
  });
});
