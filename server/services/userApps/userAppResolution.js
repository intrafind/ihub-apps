// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the server knows about one personal app for one caller: the stored
 * record, the caller's standing (`userAppAccess.js`), what the ceiling grants
 * them (`ceiling.js`), and the bodies the read routes answer.
 *
 * This is the half of the resolver that needs the store of personal apps. It
 * is loaded by `resolveApp.js` when the first ID of the personal shape
 * arrives, so the routes of the chat do not carry it for admin apps.
 *
 * No request field, header or query parameter takes part in a decision here:
 * only the ID, the principal, the stored record and the configuration.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 6.2, 7 and 9.1.
 *
 * @module services/userApps/userAppResolution
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { canUserAccessResource, isAdmin } from '../../utils/authorization.js';
import logger from '../../utils/logger.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { logAudit } from '../AuditLogService.js';
import { getLocalizedString } from '../../utils/localize.js';
import installedIntegrationService from '../integrations/InstalledIntegrationService.js';
import { isWebSearchAvailableTo } from '../tools/webSearchResolver.js';
import { isUserAppId } from '../../../shared/userAppContent.js';
import { MAX_SHARED_LISTED, getUserAppRepository } from './UserAppRepository.js';
import { effectiveUserApp, isRunnerOwner } from './ceiling.js';
import {
  canHoldUserApps,
  effectiveGroups,
  lookupUserAppOwner,
  ownerLookupFromRequest,
  ownerSnapshotNeedsRefresh,
  principalMemberKeys,
  userAppPermissions,
  openOffer
} from './userAppAccess.js';
import { currentUserAppSettings, isUserAppsEnabled } from './userAppSettings.js';
import { reducedUserAppView, retiredUserAppView, userAppEtag, userAppView } from './userAppView.js';

const COMPONENT = 'UserApps';

/** Most chat/revision pairs remembered for the "a chat ran the app" audit entry. */
const MAX_REMEMBERED_RUNS = 5000;

/**
 * Whether a config app has this ID (`configCache.getApps(true)`, IDs compared
 * without regard to case, as every app lookup compares them).
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isConfigAppId(id) {
  if (typeof id !== 'string' || id === '') return false;
  return Boolean(findByIdCaseInsensitive(configCache.getApps(true)?.data || [], id));
}

/** The company app a promoted record points to, as far as the config cache knows it. */
function companyAppOf(record, user) {
  const appId = record?.publishedAs?.appId;
  if (record?.state !== 'promoted' || !appId) {
    return { exists: true, visible: null, usable: false };
  }
  const exists = isConfigAppId(appId);
  const visible = findByIdCaseInsensitive(configCache.getApps()?.data || [], appId) || null;
  return {
    exists,
    visible,
    // Retired is decided per person: the company app is visible and this
    // caller's groups grant it.
    usable: Boolean(visible) && canUserAccessResource(user, 'apps', visible.id)
  };
}

/**
 * The caller's standing towards one stored personal app: the owner lookup,
 * the permission block and whether the app is retired for this caller.
 * Reads the configuration and `users.json`, no store.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {Object} [options]
 * @param {ReturnType<typeof currentUserAppSettings>} [options.settings]
 * @param {string[]} [options.groups] - The caller's effective groups.
 * @returns {{settings: Object, owner: ReturnType<typeof lookupUserAppOwner>,
 *   permissions: ReturnType<typeof userAppPermissions>, retired: boolean,
 *   companyApp: Object|null, publishedAppExists: boolean}}
 */
export function userAppStanding(record, user, { settings, groups } = {}) {
  const effectiveSettings = settings || currentUserAppSettings();
  const owner = isRunnerOwner(record, user)
    ? ownerLookupFromRequest(user, effectiveSettings)
    : lookupUserAppOwner(record, { settings: effectiveSettings });
  const company = companyAppOf(record, user);
  const retired = company.usable === true;
  const permissions = userAppPermissions(record, user, {
    groups: groups || effectiveGroups(user),
    isAdmin: isAdmin(user),
    owner,
    settings: effectiveSettings,
    retired,
    publishedAppExists: company.exists
  });
  return {
    settings: effectiveSettings,
    owner,
    permissions,
    retired,
    companyApp: retired ? company.visible : null,
    publishedAppExists: company.exists
  };
}

/** The global skills a principal's groups grant, by ID. */
async function grantedSkillIds(user) {
  if (!user) return [];
  try {
    const { data } = await configCache.getSkillsForUser(user);
    return (data || []).map(skill => String(skill.name || skill.id)).filter(Boolean);
  } catch (error) {
    logger.warn('Could not read the skills granted to a user; granting none', {
      component: COMPONENT,
      userId: user?.id || null,
      error: error.message
    });
    return [];
  }
}

/**
 * What the ceiling needs to know about the installation and about two
 * principals (`ceiling.js` describes the shape).
 *
 * @param {Object} principals
 * @param {Object|null} principals.owner - The owner's principal, or null.
 * @param {Object} principals.runner - The person chatting, or the person saving.
 * @returns {Promise<{models: Object[], installations: Object[], features: {skills: boolean,
 *   integrations: boolean}, webSearch: {owner: boolean, runner: boolean},
 *   skills: {owner: string[], runner: string[]}}>}
 *
 * @example
 * const catalog = await userAppCatalog({ owner: owner.principal, runner: req.user });
 * const denied = checkCapabilitiesForSave(content, { actor: req.user, owner: owner.principal, settings, catalog });
 */
export async function userAppCatalog({ owner, runner }) {
  const features = configCache.getFeatures() || {};
  const same = Boolean(owner) && owner === runner;
  const runnerSkills = await grantedSkillIds(runner);
  const webSearchFor = user => {
    try {
      return Boolean(user) && isWebSearchAvailableTo(user);
    } catch {
      return false;
    }
  };
  const runnerSearch = webSearchFor(runner);
  const installationNames = await installationDisplayNames();
  return {
    models: (configCache.getModels(true)?.data || []).map(model => ({
      id: model.id,
      enabled: model.enabled !== false,
      modelType: model.modelType || 'chat'
    })),
    installations: (configCache.getIntegrations()?.data?.installed || []).map(instance => ({
      id: instance.id,
      definition: instance.definition,
      enabled: instance.enabled !== false,
      name: installationNames.get(instance.id) ?? null
    })),
    features: {
      skills: isFeatureEnabled('skills', features),
      integrations: isFeatureEnabled('integrations', features)
    },
    webSearch: { owner: same ? runnerSearch : webSearchFor(owner), runner: runnerSearch },
    skills: { owner: same ? runnerSkills : await grantedSkillIds(owner), runner: runnerSkills }
  };
}

/**
 * The display name of every installation: the label an admin gave it, else the
 * name of its definition. A text per language or a plain string, as stored;
 * the client picks the language. A definition that cannot be read gives no name.
 *
 * @returns {Promise<Map<string, Object|string>>}
 */
async function installationDisplayNames() {
  const names = new Map();
  const installed = configCache.getIntegrations()?.data?.installed || [];
  if (installed.length === 0) return names;
  try {
    await installedIntegrationService.registry.ensureLoaded();
    for (const instance of installed) {
      const definition = installedIntegrationService.registry.get(instance.definition)?.definition;
      const name = instance.label || definition?.name;
      if (name) names.set(instance.id, name);
    }
  } catch (error) {
    logger.warn('Could not read the names of the connected systems', {
      component: COMPONENT,
      error: error.message
    });
  }
  return names;
}

/** What a view may add to the context of `userAppView`; see {@link registerUserAppViewExtension}. */
let viewExtension = null;

/**
 * Let another module add to the full view of a personal app: `publish` (what
 * a publish would write, sent to the owner) and `publishedAs` (the company
 * app as the caller may read it). One extension; a later call replaces it.
 *
 * @param {((context: {record: Object, user: Object, permissions: Object, effective: Object,
 *   settings: Object}) => {publish?: Object, publishedAs?: Object}|null|undefined)|null} extension
 */
export function registerUserAppViewExtension(extension) {
  viewExtension = typeof extension === 'function' ? extension : null;
}

function viewExtras(context) {
  if (!viewExtension) return {};
  try {
    const extras = viewExtension(context) || {};
    return {
      ...(extras.publish ? { publish: extras.publish } : {}),
      ...(extras.publishedAs ? { publishedAs: extras.publishedAs } : {})
    };
  } catch (error) {
    logger.warn('The view extension of personal apps failed', {
      component: COMPONENT,
      appId: context.record?.id,
      error: error.message
    });
    return {};
  }
}

/** The per-request memo of {@link inspectUserApp}: one decision per request and ID. */
const requestMemo = new WeakMap();

function memoOf(req) {
  if (!req || typeof req !== 'object') return null;
  if (!requestMemo.has(req)) requestMemo.set(req, new Map());
  return requestMemo.get(req);
}

/**
 * The standing of a caller plus what the ceiling grants them. `catalogs`
 * caches the catalog per owner, so a list looks each owner up once.
 */
async function withCeiling(record, user, standing, catalogs) {
  const ownerKey = standing.permissions.isOwner ? '' : String(record.owner?.id ?? '');
  let catalog = catalogs?.get(ownerKey);
  if (!catalog) {
    catalog = await userAppCatalog({
      owner: standing.permissions.isOwner ? user : standing.owner.principal,
      runner: user
    });
    catalogs?.set(ownerKey, catalog);
  }
  const effective = effectiveUserApp(record, {
    runner: user,
    owner: standing.owner.principal,
    settings: standing.settings,
    catalog,
    now: Date.now()
  });
  return { status: 'ok', record, effective, ...standing };
}

/**
 * Remove an offer that lapsed, and record it (design section 10, "lapsed on
 * read"). The revision stays: a lapsed offer already reads as none. Never
 * throws; an offer that was answered or replaced meanwhile is left alone.
 *
 * @returns {Promise<Object|null>} The record without the offer, or null when nothing was removed.
 */
async function removeLapsedOffer(repo, record, { req, user }) {
  try {
    const cleared = await repo.clearOffer(record.id, {
      bumpRevision: false,
      authorize: loaded => Boolean(loaded.pendingOwner) && !openOffer(loaded)
    });
    if (!cleared?.offer) return null;
    logAudit({
      req,
      ...(req ? {} : { actor: user }),
      action: 'update',
      resource: 'userAppShare',
      resourceId: record.id,
      summary: `The offer of a personal app to ${cleared.offer.name || cleared.offer.id} lapsed`,
      details: {
        offer: 'lapsed',
        from: cleared.record.owner?.id ?? null,
        to: cleared.offer.id,
        by: user?.id ?? null,
        revision: Number(cleared.record.revision) || 1,
        contentHash: cleared.record.contentHash || null
      }
    });
    return cleared.record;
  } catch (error) {
    logger.debug('A lapsed offer of a personal app was not removed', {
      component: COMPONENT,
      appId: record.id,
      error: error.message
    });
    return null;
  }
}

/**
 * Store the release of a promoted record whose company app no longer exists
 * (design 8.2, "Released by itself"): `state: 'active'`, `publishedAs: null`.
 * Derived only, the release would come undone as soon as any app with that
 * ID existed again, and the record would point at somebody else's app. The
 * revision stays: the record already reads as active. Never throws.
 *
 * @returns {Promise<Object|null>} The released record, or null when nothing was written.
 */
async function storeRelease(repo, record) {
  try {
    const released = await repo.mutate(
      record.id,
      current => ({ ...current, state: 'active', publishedAs: null }),
      {
        bumpRevision: false,
        authorize: loaded =>
          loaded.state === 'promoted' && !isConfigAppId(loaded.publishedAs?.appId)
      }
    );
    return released?.state === 'active' ? released : null;
  } catch (error) {
    logger.debug('The release of a personal app was not stored', {
      component: COMPONENT,
      appId: record.id,
      error: error.message
    });
    return null;
  }
}

async function inspect(appId, user, { req, repository, catalogs }) {
  if (!isUserAppId(appId)) return { status: 'notPersonal' };
  const repo = repository || getUserAppRepository();

  // A config app has the ID: the file was placed by hand or by an import.
  // Without a personal record of the same ID it is an ordinary admin app;
  // with one, the ID answers for nobody.
  if (isConfigAppId(appId)) {
    const twin = repo.isAvailable() ? await repo.get(appId).catch(() => null) : null;
    if (!twin) return { status: 'configApp' };
    logger.error('A config app and a personal app have the same ID; neither answers', {
      component: COMPONENT,
      appId
    });
    return { status: 'clash' };
  }

  if (!isUserAppsEnabled()) return { status: 'disabled' };
  if (!canHoldUserApps(user)) return { status: 'notFound' };
  if (!repo.isAvailable()) return { status: 'unavailable' };

  let record;
  try {
    record = await repo.get(appId);
  } catch (error) {
    logger.warn('A personal app could not be read', {
      component: COMPONENT,
      appId,
      error: error.message
    });
    return { status: 'unavailable' };
  }
  if (!record) return { status: 'notFound' };

  let standing = userAppStanding(record, user);
  if (!standing.permissions.canView) return { status: 'notFound' };

  // An offer nobody answered in time is removed when the app is next read.
  if (record.pendingOwner && !openOffer(record)) {
    const cleared = await removeLapsedOffer(repo, record, { req, user });
    if (cleared) {
      record = cleared;
      standing = userAppStanding(record, user);
      if (!standing.permissions.canView) return { status: 'notFound' };
    }
  }

  // The company app was deleted: store the release, so the record cannot
  // point at a later app of the same ID.
  if (record.state === 'promoted' && standing.publishedAppExists === false) {
    const released = await storeRelease(repo, record);
    if (released) {
      record = released;
      standing = userAppStanding(record, user);
      if (!standing.permissions.canView) return { status: 'notFound' };
    }
  }

  // A request of the owner keeps the stored snapshot of their groups fresh.
  if (standing.permissions.isOwner && ownerSnapshotNeedsRefresh(record, user)) {
    await repo.refreshOwnerPrincipal(user).catch(error => {
      logger.warn('Could not refresh the owner snapshot of a personal app', {
        component: COMPONENT,
        appId,
        error: error.message
      });
    });
  }

  return withCeiling(record, user, standing, catalogs);
}

/**
 * Everything the server knows about one personal-shaped ID for one caller.
 * Memoised on `req` for the rest of the request.
 *
 * @param {string} appId
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {Object} [options]
 * @param {Object} [options.req] - The request, as the memo's key.
 * @param {Object} [options.repository] - Defaults to the process-wide one.
 * @param {Map} [options.catalogs] - A catalog cache per owner, for a list.
 * @returns {Promise<{status: 'notPersonal'|'configApp'|'clash'|'disabled'|'unavailable'|'notFound'}
 *   | {status: 'ok', record: Object, effective: Object, settings: Object, owner: Object,
 *      permissions: Object, retired: boolean, companyApp: Object|null,
 *      publishedAppExists: boolean}>}
 *   `ok` means the caller may see the app; whether they may use it is in
 *   `permissions.canUse`.
 */
export function inspectUserApp(appId, user, { req, repository, catalogs } = {}) {
  const memo = memoOf(req);
  const key = String(appId);
  if (memo?.has(key)) return memo.get(key);
  const pending = inspect(appId, user, { req, repository, catalogs });
  memo?.set(key, pending);
  return pending;
}

/**
 * The personal half of `resolveAppForChat` (`resolveApp.js`): what an
 * interactive chat request may run under an ID of the personal shape.
 *
 * @param {string} appId - An ID of the personal shape.
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {Object} [options]
 * @param {Object} [options.req] - The request; the decision is memoised on it.
 * @param {Object} [options.repository] - Defaults to the process-wide one.
 * @returns {Promise<{app: Object, userApp: {record: Object, permissions: Object,
 *   capabilities: Object[], approval: {mode: string, chatGrants: boolean}}} | null | undefined>}
 *   The app as the ceiling built it for this caller; `null` when the caller
 *   gets nothing under this ID; `undefined` when the ID belongs to a config
 *   app and to no personal app, so the lookup of admin apps decides.
 */
export async function resolveUserApp(appId, user, { req, repository } = {}) {
  const state = await inspectUserApp(appId, user, { req, repository });
  if (state.status === 'configApp' || state.status === 'notPersonal') return undefined;
  // Visible but not usable (switched off, a blocked owner, shares that do
  // not count, retired for this caller) is no app for the chat.
  if (state.status !== 'ok' || !state.permissions.canUse) return null;
  return {
    app: state.effective.app,
    userApp: {
      record: state.record,
      permissions: state.permissions,
      capabilities: state.effective.capabilities,
      approval: state.effective.approval
    }
  };
}

/**
 * Whether the caller reads the full body: they may use the app, or they are
 * the receiver of an offer they may accept and read what they would own
 * (design 8.3), also while they may not chat with it.
 */
function readsFull(permissions) {
  return permissions?.canUse === true || permissions?.canAcceptOffer === true;
}

function fullView(state, user) {
  return userAppView(state.record, {
    permissions: state.permissions,
    effective: state.effective,
    owner: state.owner,
    publishedAppExists: state.publishedAppExists,
    ...viewExtras({
      record: state.record,
      user,
      permissions: state.permissions,
      effective: state.effective,
      settings: state.settings
    })
  });
}

function reducedView(state) {
  const view = reducedUserAppView(state.record, {
    permissions: state.permissions,
    owner: state.owner,
    publishedAppExists: state.publishedAppExists
  });
  // The reason an owner cannot use their own published app: the company app.
  // Retired means that app is visible, so it is switched on. The keys are
  // those of the full view (design 9.1).
  if (state.retired && state.companyApp) {
    view.publishedAs = {
      appId: state.companyApp.id,
      name: state.companyApp.name ?? null,
      enabled: state.companyApp.enabled !== false,
      at: state.record.publishedAs?.at ?? null
    };
  }
  return view;
}

/**
 * The body of `GET /api/apps/{appId}` for a personal-shaped ID, or null when
 * the answer is the 404 of an unknown ID.
 *
 * - The caller may use the app: the app with who owns it and what the caller
 *   may do (`userAppView`).
 * - The app is retired for the caller (it was published and they may use the
 *   company app): the pointer to that app, and nothing of the personal app.
 * - The caller may see it and not use it (switched off, the owner's shares do
 *   not count): the reduced body, without instructions and capabilities.
 *
 * A config app that happens to have a personal-shaped ID is not answered
 * here: `configApp` is true and the route goes on as for any admin app.
 *
 * @param {string} appId
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {Object} [options]
 * @param {Object} [options.req]
 * @param {Object} [options.repository]
 * @returns {Promise<{configApp: true} | {configApp: false, body: Object, etag: string|null,
 *   kind: 'full'|'reduced'|'retired'} | null>}
 */
export async function readUserAppFor(appId, user, { req, repository } = {}) {
  const state = await inspectUserApp(appId, user, { req, repository });
  if (state.status === 'configApp') return { configApp: true };
  if (state.status !== 'ok') return null;
  if (state.retired) {
    return {
      configApp: false,
      kind: 'retired',
      etag: null,
      body: retiredUserAppView(state.record, {
        appId: state.companyApp?.id,
        name: state.companyApp?.name
      })
    };
  }
  // The receiver of an offer they may accept reads what they would own
  // (design 8.3), also while they may not chat with it.
  if (!readsFull(state.permissions)) {
    return {
      configApp: false,
      kind: 'reduced',
      etag: userAppEtag(state.record),
      body: reducedView(state)
    };
  }
  // A full admin who is neither owner nor member reads someone's private
  // instructions: that is audited on every path, not only on the admin routes
  // (design 10).
  if (state.permissions.role === 'admin') auditAdminRead(state.record, { req, user });
  return {
    configApp: false,
    kind: 'full',
    etag: userAppEtag(state.record),
    body: fullView(state, user)
  };
}

/**
 * The audit entry of a full admin's read of the content of a personal app
 * they are no member of: the entry the admin route writes. Never throws.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} options
 * @param {Object} [options.req] - The request.
 * @param {Object} options.user - The admin.
 */
function auditAdminRead(record, { req, user }) {
  try {
    const name =
      getLocalizedString(record.content?.name, record.language || 'en', 'en', record.id) ||
      record.id;
    logAudit({
      req,
      ...(req ? {} : { actor: user }),
      action: 'read',
      resource: 'userApp',
      resourceId: record.id,
      summary: `Read the content of personal app "${name}" of ${record.owner?.name || record.owner?.id || 'unknown'}`,
      details: {
        revision: Number(record.revision) || 1,
        contentHash: record.contentHash || null,
        ownerId: record.owner?.id ?? null,
        what: 'the content'
      }
    });
  } catch (error) {
    logger.warn('The audit entry of an admin read of a personal app was not written', {
      component: COMPONENT,
      appId: record.id,
      error: error.message
    });
  }
}

/**
 * A stored personal app as a response carries it for one caller: the body
 * `GET /api/apps/{appId}` answers, and the `ETag`. For the routes that write
 * an app and answer with it: they pass the record the repository returned.
 * For a caller for whom the app is retired that is the pointer to the company
 * app, as `GET` answers it; an owner who publishes an app they can use at once
 * gets it from `_publish`.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {Object} [options]
 * @param {ReturnType<typeof currentUserAppSettings>} [options.settings]
 * @returns {Promise<{body: Object, etag: string,
 *   permissions: ReturnType<typeof userAppPermissions>}>} The full body when
 *   the caller may use the app, the retired one when it is retired for them,
 *   the reduced one otherwise.
 *
 * @example
 * const record = await repo.update(appId, merged, { actor, expectedRevision });
 * const { body, etag } = await userAppResponse(record, req.user);
 * res.setHeader('ETag', etag);
 * res.json(body);
 */
export async function userAppResponse(record, user, { settings } = {}) {
  const state = await withCeiling(record, user, userAppStanding(record, user, { settings }), null);
  let body;
  if (state.retired && state.companyApp) {
    body = retiredUserAppView(state.record, {
      appId: state.companyApp.id,
      name: state.companyApp.name
    });
  } else body = readsFull(state.permissions) ? fullView(state, user) : reducedView(state);
  return {
    body,
    etag: userAppEtag(record),
    permissions: state.permissions
  };
}

/**
 * The personal apps of `GET /api/apps?scope=…`.
 *
 * `mine`: the apps the caller owns, and apps offered to them (with
 * `permissions.role: 'offered'`). `shared`: the apps that reach the caller
 * through a member entry, newest first, at most 200. `personal`: both.
 *
 * An app the caller may use is listed as `GET /api/apps/{appId}` answers it.
 * One they may see and not use is listed with the reduced body; a shared app
 * that is retired for the caller is left out, because the company app is in
 * their list of apps.
 *
 * With the feature off, for a principal that cannot hold personal apps and
 * while the store is unavailable the list is empty. A request of an owner
 * refreshes that owner's snapshots.
 *
 * @param {Object} user - `req.user` with resolved permissions.
 * @param {'mine'|'shared'|'personal'} scope
 * @param {Object} [options]
 * @param {Object} [options.repository]
 * @returns {Promise<Object[]>}
 */
export async function listUserAppsFor(user, scope, { repository } = {}) {
  const repo = repository || getUserAppRepository();
  if (!isUserAppsEnabled() || !canHoldUserApps(user) || !repo.isAvailable()) return [];

  const settings = currentUserAppSettings();
  const groups = effectiveGroups(user);
  const wantsMine = scope === 'mine' || scope === 'personal';
  const wantsShared = scope === 'shared' || scope === 'personal';

  let owned = [];
  if (wantsMine) {
    owned = await repo.listOwned(user.id);
    if (owned.some(record => ownerSnapshotNeedsRefresh(record, user))) {
      await repo.refreshOwnerPrincipal(user).catch(() => {});
    }
    owned.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  // The markers hold shares and open offers alike; the role tells them apart.
  const reached = await repo.listSharedWith(principalMemberKeys(user, groups), { limit: 0 });

  const catalogs = new Map();
  const mine = [];
  const shared = [];
  const seen = new Set();
  const describe = async record => {
    if (!record || seen.has(record.id) || isConfigAppId(record.id)) return null;
    seen.add(record.id);
    const standing = userAppStanding(record, user, { settings, groups });
    if (!standing.permissions.canView) return null;
    return withCeiling(record, user, standing, catalogs);
  };

  for (const record of owned) {
    const state = await describe(record);
    if (state) mine.push(readsFull(state.permissions) ? fullView(state, user) : reducedView(state));
  }
  for (const record of reached) {
    const state = await describe(record);
    if (!state) continue;
    // An offer to a person the app is already shared with: they keep the role of the share, and
    // the app is listed with their own apps, where the offer is answered.
    const offered =
      state.permissions.role === 'offered' || state.permissions.canAcceptOffer === true;
    if (offered ? !wantsMine : !wantsShared) continue;
    if (!offered && state.retired) continue;
    const item = readsFull(state.permissions) ? fullView(state, user) : reducedView(state);
    if (offered) mine.push(item);
    else if (shared.length < MAX_SHARED_LISTED) shared.push(item);
  }
  return [...mine, ...shared];
}

/** The chat/revision pairs an "a chat ran the app" entry was written for. */
const auditedRuns = new Set();

/**
 * Record that a chat turn ran a personal app: `lastUsedAt` (at most once a
 * day per app) and one audit entry per chat and revision, so an admin can
 * answer "which text did this chat run with". Later turns of the same chat
 * with the same revision write nothing; after a restart one duplicate entry
 * is possible and harmless. Never throws.
 *
 * @param {Object} options
 * @param {Object} options.req - The chat request.
 * @param {string} options.chatId
 * @param {{record: Object, permissions: Object}|null|undefined} options.userApp - `userApp` of
 *   `resolveAppForChat`; nothing happens for an admin app.
 * @param {Object} [options.repository]
 * @returns {Promise<boolean>} Whether an audit entry was written.
 */
export async function noteUserAppRun({ req, chatId, userApp, repository }) {
  const record = userApp?.record;
  if (!record?.id) return false;
  try {
    await (repository || getUserAppRepository()).touchLastUsed(record.id);
  } catch (error) {
    logger.debug('Could not record the use of a personal app', {
      component: COMPONENT,
      appId: record.id,
      error: error.message
    });
  }
  const key = `${chatId}\u0000${record.id}\u0000${record.revision}`;
  if (auditedRuns.has(key)) return false;
  if (auditedRuns.size >= MAX_REMEMBERED_RUNS) auditedRuns.clear();
  auditedRuns.add(key);
  const role = userApp.permissions?.role || null;
  logAudit({
    req,
    action: 'execute',
    resource: 'userApp',
    resourceId: record.id,
    summary: `Chat ran a personal app as ${role || 'unknown'}`,
    details: {
      chatId,
      ownerId: record.owner?.id ?? null,
      role,
      revision: Number(record.revision) || 1,
      contentHash: record.contentHash || null
    }
  });
  return true;
}

/** Forget the remembered chat/revision pairs. For tests. */
export function resetUserAppRunMemory() {
  auditedRuns.clear();
}
