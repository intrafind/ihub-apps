// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a response says about a personal app. Every view is built from an
 * allow-list of fields: nothing is spread from the stored record, so a field
 * the record gains later is not sent until it is listed here.
 *
 * `ownerPrincipal` (the owner's e-mail address and groups), `contentHash` and
 * the `publishing` mark are in no view.
 *
 * Pure: every function takes what it needs and reads no store.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 9.1 and 9.2.
 *
 * @module services/userApps/userAppView
 */
import { USER_APP_RUN_KEYS, USER_APP_SCHEMA_DEFAULTS } from '../../../shared/userAppContent.js';
import { effectiveUserAppState, openOffer } from './userAppAccess.js';

/** The keys of the app object a view passes on: what the ceiling may write, and nothing else. */
const APP_OBJECT_KEYS = Object.freeze([
  ...USER_APP_RUN_KEYS,
  ...Object.keys(USER_APP_SCHEMA_DEFAULTS)
]);

/** The roles that see the member list, what was requested and every reason. */
const FULL_VIEW_ROLES = Object.freeze(['owner', 'editor', 'offered', 'admin']);

/** The reasons a person with "Can use" is told. Everything else reads `unavailable`. */
const MEMBER_REASONS = Object.freeze(['youMayNot']);

/**
 * The ETag of a personal app: its revision, quoted.
 *
 * @param {{revision: number}} record
 * @returns {string}
 *
 * @example
 * res.setHeader('ETag', userAppEtag(record)); // → "7" (with the quotes)
 */
export function userAppEtag(record) {
  return `"${Number(record?.revision) || 1}"`;
}

/**
 * The revision an `If-Match` header names.
 *
 * @param {unknown} header - The header value: `"7"`, `W/"7"` or `7`.
 * @returns {number|null} The revision; null when the header is absent, `*` or
 *   not a revision. A route that requires the header treats null as missing.
 */
export function revisionFromIfMatch(header) {
  if (typeof header !== 'string') return null;
  const match = /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(header);
  return match ? Number(match[1]) : null;
}

/**
 * How many users and groups an app is shared with, and whether with everyone.
 *
 * @param {{members?: Array<{type: string}>}} record
 * @returns {{users: number, groups: number, everyone: boolean}}
 */
export function sharedWithCounts(record) {
  const members = Array.isArray(record?.members) ? record.members : [];
  return {
    users: members.filter(member => member.type === 'user').length,
    groups: members.filter(member => member.type === 'group').length,
    everyone: members.some(member => member.type === 'everyone')
  };
}

function person(value) {
  if (!value?.id) return null;
  return { id: String(value.id), name: String(value.name || value.id) };
}

function memberView(member) {
  return {
    type: member.type,
    id: member.type === 'everyone' ? null : String(member.id),
    name: String(member.name || member.id || ''),
    role: member.role === 'editor' ? 'editor' : 'user'
  };
}

function ownerView(record, owner) {
  return { ...person(record.owner), active: owner?.active !== false };
}

function offerView(record, now) {
  const offer = openOffer(record, now);
  if (!offer) return null;
  return {
    id: String(offer.id),
    name: String(offer.name || offer.id),
    offeredAt: offer.offeredAt,
    offeredBy: person(offer.offeredBy)
  };
}

/** Why an app is switched off, as owner and members may read it: without who did it. */
function disabledView(record) {
  if (!record.disabled) return null;
  return { at: record.disabled.at || null, reason: record.disabled.reason || null };
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source && Object.hasOwn(source, key) && source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

/** The text of one language of a localized value: the wanted one, else the first there is. */
function localizedText(value, language) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (language && typeof value[language] === 'string') return value[language];
  return Object.values(value).find(entry => typeof entry === 'string') || '';
}

/**
 * The capability list as one role may read it. The roles of
 * `FULL_VIEW_ROLES` get it as the ceiling computed it. A person with "Can
 * use" gets what the app asks for: granted, or missing with `youMayNot` when
 * it depends on them and `unavailable` otherwise. What the owner may or may
 * not do is not sent to them. A connected system carries its display name
 * (`name`, a text per language or a string) for every role.
 */
function capabilitiesFor(capabilities, full, bindings) {
  const about = new Map((Array.isArray(bindings) ? bindings : []).map(entry => [entry.id, entry]));
  const list = (Array.isArray(capabilities) ? capabilities : []).map(entry => ({
    ...entry,
    name: about.get(entry.id)?.name,
    actions: about.get(entry.id)?.actions
  }));
  // The name of a connected system goes to every role: the notice names it. The name of a
  // project goes to the roles that may edit the app only: it may be one the others cannot see.
  const named = entry =>
    entry.name && (full || !String(entry.id).startsWith('project:')) ? { name: entry.name } : {};
  if (full) {
    return list.map(entry => ({
      id: entry.id,
      ...named(entry),
      requested: entry.requested === true,
      granted: entry.granted === true,
      ...(entry.granted === true || !entry.reason ? {} : { reason: entry.reason }),
      // The functions the app stores for a connected system, so an editor can
      // keep a binding that is withheld right now.
      ...(Array.isArray(entry.actions) ? { actions: [...entry.actions] } : {})
    }));
  }
  return list
    .filter(entry => entry.requested === true || entry.granted === true)
    .map(entry =>
      entry.granted === true
        ? { id: entry.id, ...named(entry), granted: true }
        : {
            id: entry.id,
            ...named(entry),
            granted: false,
            reason: MEMBER_REASONS.includes(entry.reason) ? entry.reason : 'unavailable'
          }
    );
}

/** The settings of `capabilities` the app object of a run does not carry as the author wrote them. */
const AUTHORED_CAPABILITY_KEYS = Object.freeze(['models', 'webSearchSettings']);

/**
 * `{ capabilities: { models, webSearchSettings } }` as stored, or undefined
 * when the author set neither. For the callers who may edit the app.
 */
function authoredSettings(content) {
  const stored = content?.capabilities;
  if (!stored || typeof stored !== 'object') return undefined;
  const capabilities = {};
  for (const key of AUTHORED_CAPABILITY_KEYS) {
    if (stored[key] !== undefined) capabilities[key] = structuredClone(stored[key]);
  }
  return Object.keys(capabilities).length > 0 ? { capabilities } : undefined;
}

/**
 * A personal app as `GET /api/apps/{appId}`, the list with `scope` and every
 * write route answer it: the app object of the ceiling plus who owns it, what
 * the caller may do and what was withheld.
 *
 * Which fields a caller gets follows `permissions.role` (design 9.1): the
 * member list, `capabilities[].requested` and every reason go to the owner,
 * "Can edit", the receiver of an offer and a full admin; `pendingOwner` to
 * the owner, the receiver and a full admin; `publish` to the owner;
 * `publishedAs` to the owner, "Can edit" and a full admin.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} context
 * @param {ReturnType<typeof import('./userAppAccess.js').userAppPermissions>} context.permissions
 * @param {{app: Object, capabilities: Array<{id: string, requested: boolean, granted: boolean,
 *   reason?: string}>, approval: {mode: string, chatGrants: boolean}}} context.effective
 *   The result of `effectiveUserApp` (the ceiling) for this caller.
 * @param {{active: boolean}} [context.owner] - The owner lookup.
 * @param {Object} [context.publish] - What a publish would write
 *   (`{ startsEnabled, capabilities, dropped }`); sent to the owner only.
 * @param {Object} [context.publishedAs] - The company app of a promoted app
 *   as the caller may read it (`{ appId, name, enabled }`); the stored
 *   `{ appId, at, by }` when omitted.
 * @param {boolean} [context.publishedAppExists=true] - See `effectiveUserAppState`.
 * @param {number} [context.now] - Clock in milliseconds, for tests.
 * @returns {Object}
 */
export function userAppView(
  record,
  {
    permissions,
    effective,
    owner,
    publish,
    publishedAs,
    publishedAppExists = true,
    now = Date.now()
  } = {}
) {
  const role = permissions?.role || null;
  // The receiver of an offer reads what an owner reads before they answer, also when the app
  // reaches them only as "Can use".
  const full = FULL_VIEW_ROLES.includes(role) || permissions?.canAcceptOffer === true;
  const state = effectiveUserAppState(record, { publishedAppExists });
  const view = {
    ...pick(effective?.app, APP_OBJECT_KEYS),
    id: record.id,
    ownership: 'user',
    language: record.language || null,
    owner: ownerView(record, owner),
    permissions: { ...permissions },
    sharedWith: sharedWithCounts(record),
    capabilities: capabilitiesFor(effective?.capabilities, full, effective?.bindings),
    approval: {
      mode: effective?.approval?.mode || 'always',
      chatGrants: effective?.approval?.chatGrants === true
    },
    state,
    disabled: disabledView(record),
    revision: Number(record.revision) || 1,
    updatedAt: record.updatedAt || null,
    updatedBy: person(record.updatedBy)
  };
  if (full) {
    view.members = (record.members || []).map(memberView);
    // What the author stored where the app object of a run has less: the ceiling cuts
    // the models to what this caller may use, so the editor cannot rebuild the list from it.
    const authored = authoredSettings(record.content);
    if (authored) view.authored = authored;
  }
  // The receiver of an offer may already be a member; the offer reaches them all the same.
  if (
    role === 'owner' ||
    role === 'offered' ||
    role === 'admin' ||
    permissions?.canAcceptOffer === true
  ) {
    view.pendingOwner = offerView(record, now);
  }
  if (role === 'owner' && publish) view.publish = publish;
  if ((role === 'owner' || role === 'editor' || role === 'admin') && state === 'promoted') {
    view.publishedAs = publishedAs || {
      appId: record.publishedAs?.appId || null,
      at: record.publishedAs?.at || null,
      by: person(record.publishedAs?.by)
    };
  }
  return view;
}

/**
 * The body for a caller who may see an app and not use it: switched off, or
 * the owner's shares do not count at the moment. No instructions and no
 * capabilities. The reason is in `disabled` or in `permissions.suspended`.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} context
 * @param {ReturnType<typeof import('./userAppAccess.js').userAppPermissions>} context.permissions
 * @param {{active: boolean}} [context.owner] - The owner lookup.
 * @param {boolean} [context.publishedAppExists=true]
 * @returns {{id: string, ownership: 'user', name: Object, icon: string, color: string,
 *   owner: Object, state: string, permissions: Object, disabled: Object|null}}
 */
export function reducedUserAppView(record, { permissions, owner, publishedAppExists = true } = {}) {
  return {
    id: record.id,
    ownership: 'user',
    name: record.content?.name || {},
    icon: record.content?.icon || null,
    color: record.content?.color || null,
    owner: ownerView(record, owner),
    state: effectiveUserAppState(record, { publishedAppExists }),
    permissions: { ...permissions },
    disabled: disabledView(record)
  };
}

/**
 * The body for a caller for whom a promoted app is retired: the pointer to
 * the company app, and nothing of the personal app. `enabled` is always true:
 * retired means the caller can see the company app, so it is switched on. It
 * is there so the body has the keys of design 9.1.
 *
 * @param {Object} record - Stored personal app.
 * @param {{appId: string, name: Object|string}} companyApp - The company app
 *   the caller may use.
 * @returns {{id: string, ownership: 'user', state: 'retired',
 *   publishedAs: {appId: string, name: Object|string, enabled: true}}}
 */
export function retiredUserAppView(record, companyApp) {
  return {
    id: record.id,
    ownership: 'user',
    state: 'retired',
    publishedAs: {
      appId: companyApp?.appId || null,
      name: companyApp?.name ?? null,
      enabled: true
    }
  };
}

/** The switches an app asks for, by name: what the admin list shows. */
function requestedCapabilities(content) {
  const capabilities = content?.capabilities || {};
  const names = [];
  if (capabilities.upload === true) names.push('upload');
  if (capabilities.webSearch === true) names.push('webSearch');
  if (capabilities.skills === true) names.push('skills');
  if (Array.isArray(capabilities.integrations) && capabilities.integrations.length > 0) {
    names.push('integrations');
  }
  return names;
}

/**
 * One item of `GET /api/admin/user-apps` (design 9.2).
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} [context]
 * @param {{active: boolean, stale: boolean}} [context.owner] - The owner lookup.
 * @param {boolean} [context.clash=false] - A config app has the same ID.
 * @param {boolean|null} [context.publishedAppEnabled=null] - Whether the
 *   company app of a promoted app is switched on; null when it is gone.
 * @param {boolean} [context.publishedAppExists=true]
 * @param {number} [context.membersWithoutCompanyApp] - For a promoted app: how
 *   many members shared by name cannot use the company app.
 * @param {number} [context.now] - Clock in milliseconds, for tests.
 * @returns {Object}
 */
export function adminUserAppListItem(
  record,
  {
    owner,
    clash = false,
    publishedAppEnabled = null,
    publishedAppExists = true,
    membersWithoutCompanyApp,
    now = Date.now()
  } = {}
) {
  const state = effectiveUserAppState(record, { publishedAppExists });
  return {
    id: record.id,
    name: localizedText(record.content?.name, record.language),
    icon: record.content?.icon || null,
    color: record.content?.color || null,
    owner: {
      ...person(record.owner),
      active: owner?.active !== false,
      rightsCheckedAt: record.ownerPrincipalAt || null,
      stale: owner?.stale === true
    },
    pendingOwner: offerView(record, now),
    state,
    disabled: record.disabled
      ? {
          at: record.disabled.at || null,
          by: person(record.disabled.by),
          reason: record.disabled.reason || null
        }
      : null,
    clash: clash === true,
    publishedAs:
      state === 'promoted' && record.publishedAs
        ? {
            appId: record.publishedAs.appId,
            at: record.publishedAs.at || null,
            by: person(record.publishedAs.by),
            enabled: publishedAppEnabled
          }
        : null,
    sharedWith: sharedWithCounts(record),
    ...(state === 'promoted' && membersWithoutCompanyApp !== undefined
      ? { membersWithoutCompanyApp }
      : {}),
    capabilities: requestedCapabilities(record.content),
    // The If-Match of an action started from the list: it then refuses a
    // change made since the list was read, without a read of the content.
    revision: Number(record.revision) || 1,
    updatedAt: record.updatedAt || null,
    lastUsedAt: record.lastUsedAt || null
  };
}

/**
 * The admin view of one app (`GET /api/admin/user-apps/{appId}`): the list
 * item (which carries the revision) plus the content, the members and what a
 * take-over would write.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} [context] - The context of {@link adminUserAppListItem}, and:
 * @param {number|null} [context.membersWithoutCompanyApp] - For a promoted
 *   app: how many members cannot use the company app.
 * @param {Object} [context.takeOverPreview] - What a take-over would write.
 * @returns {Object}
 */
export function adminUserAppView(record, context = {}) {
  const item = adminUserAppListItem(record, context);
  return {
    ...item,
    content: structuredClone(record.content || {}),
    members: (record.members || []).map(memberView),
    language: record.language || null,
    origin: record.origin || null,
    createdAt: record.createdAt || null,
    createdBy: person(record.createdBy),
    updatedBy: person(record.updatedBy),
    ...(item.state === 'promoted' && context.membersWithoutCompanyApp !== undefined
      ? { membersWithoutCompanyApp: context.membersWithoutCompanyApp }
      : {}),
    ...(context.takeOverPreview ? { takeOverPreview: context.takeOverPreview } : {})
  };
}

/**
 * One stored content state as `GET /api/admin/user-apps/{appId}/revisions`
 * answers it.
 *
 * @param {Object} state - A document of `UserAppRepository.listRevisions`.
 * @returns {{revision: number, contentHash: string, content: Object, savedAt: string|null,
 *   savedBy: {id: string, name: string}|null, deletedAt?: string}}
 */
export function userAppRevisionView(state) {
  return {
    revision: Number(state.revision) || 1,
    contentHash: state.contentHash || null,
    content: structuredClone(state.content || {}),
    savedAt: state.savedAt || null,
    savedBy: person(state.savedBy),
    ...(state.deletedAt ? { deletedAt: state.deletedAt } : {})
  };
}
