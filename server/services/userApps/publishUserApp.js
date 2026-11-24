// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Publishing a personal app: the owner's "Publish", a full admin's "Take
 * over as app", the release of a published app, and the list of published
 * apps that wait to be switched on.
 *
 * A publish copies the personal app into `contents/apps/<readable-id>.json`.
 * From then on it is an app administrators manage, and the personal app is
 * read-only (`state: 'promoted'`). The copy holds only what the capability
 * ceiling grants **at this moment**: for a publish to the owner, for a
 * take-over to the admin and to the owner. A capability that was saved while
 * it was allowed and has since been taken away does not come back through
 * the copy. Bindings carry their named actions, skills their IDs.
 *
 * {@link toAdminApp} is pure. Everything else reads the configuration and the
 * store of personal apps.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 8.2 and 10.
 *
 * @module services/userApps/publishUserApp
 */
import configCache from '../../configCache.js';
import configStore from '../config/ConfigStore.js';
import { appConfigSchema } from '../../validators/appConfigSchema.js';
import { canUserAccessResource } from '../../utils/authorization.js';
import logger from '../../utils/logger.js';
import { getLocalizedString } from '../../utils/localize.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { resolveOwnerPrincipal } from '../scheduler/tasks/ownerPrincipal.js';
import { cleanAppForSave, newAppDefaults } from '../../../shared/appDefaults.js';
import { appIdProblem, slugifyAppId, uniqueAppId } from '../../../shared/appId.js';
import { isUserAppId } from '../../../shared/userAppContent.js';
import { getUserAppRepository } from './UserAppRepository.js';
import { asServiceError } from './UserAppService.js';
import { INTEGRATION_CAPABILITY_PREFIX, effectiveUserApp, isRunnerOwner } from './ceiling.js';
import { effectiveUserAppState, isCompanyAppOf, lookupUserAppOwner } from './userAppAccess.js';
import { userAppCatalog } from './userAppResolution.js';
import { currentUserAppSettings } from './userAppSettings.js';

const COMPONENT = 'UserAppPublish';

/** Most IDs tried when a file with the chosen ID turns out to exist. */
const MAX_ID_ATTEMPTS = 20;

/** Most published apps `GET /api/admin/user-apps/_waiting` returns. */
const MAX_WAITING_LISTED = 200;

/** The content keys a published app takes over as they are. */
const COPIED_TEXT_KEYS = Object.freeze([
  'name',
  'description',
  'system',
  'prompt',
  'messagePlaceholder'
]);

/**
 * The keys about how the chat looks and starts that a published app takes over
 * as the ceiling built them. The input line is not among them: every personal
 * app has one (with the microphone of the base), so it is copied only when the
 * author set it.
 */
const PUBLISHED_LOOK_KEYS = Object.freeze([
  'greeting',
  'preferredOutputFormat',
  'startForm',
  'variablesPanel',
  'autoStart'
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** The name of a personal app in its own language. */
export function userAppName(record) {
  return (
    getLocalizedString(record?.content?.name, record?.language || 'en', 'en', '') ||
    record?.id ||
    ''
  );
}

/** The label an admin gave an installation, else its ID. */
function installationName(installationId, language) {
  const installed = configCache.getIntegrations()?.data?.installed || [];
  const instance = installed.find(entry => entry?.id === installationId);
  const label = instance?.label;
  if (typeof label === 'string' && label !== '') return label;
  return getLocalizedString(label, language || 'en', 'en', '') || installationId;
}

/**
 * What a published app would be able to do, read from what the ceiling
 * granted (`effectiveUserApp`), and what it would lose.
 *
 * @param {ReturnType<typeof effectiveUserApp>} effective
 * @param {Object} [options]
 * @param {(installationId: string) => string} [options.nameOf] - The display
 *   name of an installation.
 * @returns {{capabilities: Array<Object>, dropped: Array<{id: string, reason: string,
 *   name?: string}>, tools: string[], plain: boolean}} `capabilities` holds
 *   one entry per granted capability: `{ id: 'model', model }`,
 *   `{ id: 'upload' }`, `{ id: 'webSearch' }`, `{ id: 'skills', skills: [ids] }`
 *   and `{ id: 'integration:<installationId>', installationId, name, actions }`.
 *   `tools` names what makes the app one with tools (`webSearch`, `skills`,
 *   `integrations`). `plain` is true when the owner's rights could not be
 *   checked, so nothing that was asked for is granted.
 */
export function projectCapabilities(effective, { nameOf = id => id } = {}) {
  const app = effective?.app || {};
  const capabilities = [];
  const dropped = [];
  for (const entry of effective?.capabilities || []) {
    const binding = entry.id.startsWith(INTEGRATION_CAPABILITY_PREFIX)
      ? entry.id.slice(INTEGRATION_CAPABILITY_PREFIX.length)
      : null;
    if (!entry.granted) {
      if (entry.requested) {
        dropped.push({
          id: entry.id,
          reason: entry.reason,
          ...(binding ? { name: nameOf(binding) } : {})
        });
      }
      continue;
    }
    if (binding) {
      capabilities.push({
        id: entry.id,
        installationId: binding,
        name: nameOf(binding),
        actions: [...(app.integrations?.[binding]?.actions || [])]
      });
    } else if (entry.id === 'model') {
      capabilities.push({ id: 'model', model: app.preferredModel });
    } else if (entry.id === 'skills') {
      capabilities.push({ id: 'skills', skills: [...(app.skills || [])] });
    } else {
      capabilities.push({ id: entry.id });
    }
  }
  const tools = [];
  if (capabilities.some(entry => entry.id === 'webSearch')) tools.push('webSearch');
  if (capabilities.some(entry => entry.id === 'skills')) tools.push('skills');
  if (capabilities.some(entry => entry.installationId)) tools.push('integrations');
  return {
    capabilities,
    dropped,
    tools,
    plain:
      dropped.length > 0 &&
      dropped.every(entry => entry.reason === 'ownerInactive' || entry.reason === 'ownerStale')
  };
}

/**
 * Whether a published app starts switched on.
 *
 * An app without web search, skills and connected systems is visible at
 * once. An app with one of them stays switched off until an administrator
 * switches it on, and with `publishing.adminEnables: 'always'` every app
 * does. There is no setting that lets an app with tools start visible.
 *
 * @param {string[]} tools - `tools` of {@link projectCapabilities}.
 * @param {ReturnType<typeof currentUserAppSettings>} settings
 * @returns {boolean}
 *
 * @example
 * startsEnabled([], settings); // → true with adminEnables 'withTools'
 * startsEnabled(['webSearch'], settings); // → false
 */
export function startsEnabled(tools, settings) {
  if (settings?.publishing?.adminEnables === 'always') return false;
  return !Array.isArray(tools) || tools.length === 0;
}

/**
 * The admin app a personal app becomes.
 *
 * Starts from `newAppDefaults(language)`, takes the content of the app the
 * ceiling built, and writes the granted capabilities as ordinary app config:
 * `preferredModel`, `upload`, `websearch.enabled`, `skillSettings` with
 * `skills` as the list of granted skill IDs (never `*`), `integrations` with
 * the named `actions` of each binding, `features` with projects switched off
 * and `toolApproval.default: 'writes'`. Nothing is copied from the stored
 * record but its language.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} options
 * @param {ReturnType<typeof effectiveUserApp>} options.effective - What the
 *   ceiling grants: for a publish with the owner as runner, for a take-over
 *   with the admin as runner.
 * @param {string} options.id - The ID of the admin app.
 * @param {boolean} options.enabled - Whether the app starts switched on.
 * @param {string} [options.category] - Set by an admin's take-over only.
 * @returns {Object} The app as it is written to `contents/apps/<id>.json`.
 */
export function toAdminApp(record, { effective, id, enabled, category }) {
  const source = effective?.app || {};
  const app = newAppDefaults(record?.language || 'en');
  delete app.category;
  app.id = id;
  app.enabled = enabled === true;

  for (const key of COPIED_TEXT_KEYS) {
    if (source[key]) app[key] = clone(source[key]);
    else if (key !== 'name' && key !== 'description') delete app[key];
  }
  if (source.icon) app.icon = source.icon;
  if (source.color) app.color = source.color;
  app.variables = clone(source.variables) || [];
  app.starterPrompts = clone(source.starterPrompts) || [];
  app.allowEmptyContent = source.allowEmptyContent === true;
  // How the chat looks and starts: copied as the ceiling built it.
  for (const key of PUBLISHED_LOOK_KEYS) {
    if (source[key] !== undefined) app[key] = clone(source[key]);
  }
  if (record?.content?.inputMode && source.inputMode) {
    app.inputMode = { ...(app.inputMode || {}), ...clone(source.inputMode) };
  }

  if (source.preferredModel) app.preferredModel = source.preferredModel;
  if (source.upload?.enabled === true) app.upload = clone(source.upload);
  // The models the app may use, as the ceiling cut them: a list only ever narrows what the
  // people of the company app may use.
  if (Array.isArray(source.allowedModels) && source.allowedModels.length > 0) {
    app.allowedModels = [...source.allowedModels];
  }
  if (source.disallowModelSelection === true) app.disallowModelSelection = true;
  if (source.websearch?.enabled === true) {
    app.websearch = { enabled: true };
    for (const key of ['maxPageReads', 'researchGuidance']) {
      if (source.websearch[key] !== undefined) app.websearch[key] = clone(source.websearch[key]);
    }
  }
  if (source.skillSettings?.enabled === true) {
    app.skillSettings = { enabled: true };
    app.skills = (source.skills || []).filter(skill => typeof skill === 'string' && skill !== '*');
  }
  const bindings = Object.entries(source.integrations || {}).filter(
    ([, binding]) => Array.isArray(binding?.actions) && binding.actions.length > 0
  );
  if (bindings.length > 0) {
    app.integrations = {};
    for (const [installationId, binding] of bindings) {
      app.integrations[installationId] = {
        actions: binding.actions.filter(action => typeof action === 'string' && action !== '*'),
        required: false,
        enabledByDefault: false
      };
    }
  }
  // The personal app ran without projects: a project attached to a chat would
  // hand the knowledge tools to instructions nobody reviewed, and those reads
  // run without a card. The company app starts the same way; an admin switches
  // projects on in the editor (design 8.2).
  app.features = { ...(app.features || {}), projects: false, userProjects: false };
  app.toolApproval = { default: 'writes' };
  if (typeof category === 'string' && category !== '') app.category = category;
  // The stamp that makes this file the record's company app (`isCompanyAppOf`).
  if (isUserAppId(record?.id)) app.sourceUserAppId = record.id;
  return cleanAppForSave(app);
}

/** The IDs of every app file the cache knows, in lower case. */
function configAppIds() {
  return new Set(
    (configCache.getApps(true)?.data || []).map(app => String(app.id || '').toLowerCase())
  );
}

/**
 * The IDs a publish may not give the company app, in lower case: every app
 * file the cache knows, and every ID another personal app still holds. A
 * promoted record whose company app was deleted keeps its ID until it is
 * released, so the ID is not handed to somebody else's app meanwhile.
 *
 * @param {Object} record - The record being published.
 * @param {Object} repo - The repository.
 * @returns {Promise<Set<string>>}
 */
async function takenAppIds(record, repo) {
  const taken = configAppIds();
  let held = [];
  try {
    held = (await repo?.heldCompanyAppIds?.({ exceptAppId: record?.id ?? null })) || [];
  } catch (error) {
    logger.warn('Could not read the app IDs personal apps hold; counting app files only', {
      component: COMPONENT,
      error: error.message
    });
  }
  for (const id of held) taken.add(id);
  return taken;
}

/**
 * The ID a publish would give the company app: the slug of the name, with a
 * number when it is taken.
 *
 * @param {Object} record - Stored personal app.
 * @param {Set<string>} [taken] - IDs in use, lower case.
 * @returns {string}
 */
function suggestedAppId(record, taken = configAppIds()) {
  return uniqueAppId(slugifyAppId(userAppName(record)), id => taken.has(id));
}

/**
 * What the ceiling grants for a publish (`runner` is the owner) or for a
 * take-over (`runner` is the admin).
 */
async function effectiveFor(record, { runner, settings }) {
  const owner = isRunnerOwner(record, runner)
    ? runner
    : lookupUserAppOwner(record, { settings }).principal;
  const catalog = await userAppCatalog({ owner, runner });
  return effectiveUserApp(record, { runner, owner, settings, catalog, now: Date.now() });
}

/**
 * What a publish by the owner would write, for the owner's dialog. Computed
 * from the same ceiling result as the publish itself.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} context
 * @param {ReturnType<typeof effectiveUserApp>} context.effective - The ceiling
 *   for the owner as runner (what the owner's view is built from).
 * @param {ReturnType<typeof currentUserAppSettings>} context.settings
 * @returns {{startsEnabled: boolean, waitsFor: 'tools'|'always'|null, tools: string[],
 *   capabilities: Object[], dropped: Object[], plain: boolean}} `waitsFor`
 *   says why the app starts switched off; null when it is visible at once.
 */
function publishPreview(record, { effective, settings }) {
  const projected = projectCapabilities(effective, {
    nameOf: id => installationName(id, record?.language)
  });
  const visible = startsEnabled(projected.tools, settings);
  return {
    startsEnabled: visible,
    waitsFor: visible ? null : settings?.publishing?.adminEnables === 'always' ? 'always' : 'tools',
    tools: projected.tools,
    capabilities: projected.capabilities,
    dropped: projected.dropped,
    plain: projected.plain
  };
}

/**
 * What a take-over by `admin` would write, for the admin's dialog: the ID the
 * server suggests, every binding with every action by name, every skill by
 * ID, and what is dropped and why.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} context
 * @param {Object} context.admin - `req.user` of the full admin.
 * @param {ReturnType<typeof currentUserAppSettings>} [context.settings]
 * @returns {Promise<{suggestedId: string, capabilities: Object[], dropped: Object[],
 *   plain: boolean}>}
 */
export async function takeOverPreview(record, { admin, settings = currentUserAppSettings() }) {
  const effective = await effectiveFor(record, { runner: admin, settings });
  const projected = projectCapabilities(effective, {
    nameOf: id => installationName(id, record?.language)
  });
  return {
    suggestedId: suggestedAppId(record, await takenAppIds(record, getUserAppRepository())),
    capabilities: projected.capabilities,
    dropped: projected.dropped,
    plain: projected.plain
  };
}

function validationError(error) {
  const issues = error.issues.map(issue => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message
  }));
  return new ServiceError(
    'VALIDATION_FAILED',
    `The app cannot be published: ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`,
    { details: { issues } }
  );
}

function assertValidAdminApp(app) {
  const result = appConfigSchema.safeParse(app);
  if (!result.success) throw validationError(result.error);
}

/** JSON with the keys of every object in code-unit order, for comparing two apps. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Whether a stored app file is the one this publish would write: the whole
 * app, capabilities included, apart from `enabled` and `order` (an admin may
 * have switched it on or moved it). Comparing the texts alone would adopt a
 * file whose capabilities were taken away since it was written.
 */
function isSameApp(existing, app) {
  if (!existing || typeof existing !== 'object') return false;
  const strip = ({ enabled: _enabled, order: _order, ...rest }) => rest;
  return canonical(strip(existing)) === canonical(strip(app));
}

/**
 * Whether another personal app holds `appId`: its publish marked the ID, or
 * it is published as it. A file such a publish wrote is never adopted as
 * this publish's own, even when it has the same content (two apps made from
 * one template).
 */
async function heldByAnother(repo, record, appId) {
  try {
    const held = await repo?.heldCompanyAppIds?.({ exceptAppId: record.id });
    return Boolean(held?.has?.(String(appId).toLowerCase()));
  } catch {
    // Cannot tell: do not adopt.
    return true;
  }
}

async function readAppFile(appId) {
  try {
    return await configStore.readJson(`apps/${appId}.json`);
  } catch {
    return null;
  }
}

/**
 * The shared steps of a publish and a take-over (design 8.2):
 *
 * 1. Build the admin app and validate it with `appConfigSchema`.
 * 2. Put the mark `publishing: { appId }` on the record, under its lock and
 *    against the revision of `If-Match`.
 * 3. Write the file with the create-only call. It never overwrites an app.
 * 4. Mark the record `promoted` and clear an open offer.
 *
 * If the server stops between 3 and 4, a second call finds the mark and the
 * file, skips 3 and finishes 4. If step 4 is refused (the app was changed or
 * changed hands meanwhile), the file of step 3 is removed again.
 *
 * @returns {Promise<{record: Object, app: Object, projected: Object}>}
 */
async function writeCompanyApp(
  record,
  {
    runner,
    by,
    settings,
    expectedRevision,
    authorize,
    enabledFor,
    requestedId,
    category,
    repository
  }
) {
  const repo = repository || getUserAppRepository();
  const effective = await effectiveFor(record, { runner, settings });
  const projected = projectCapabilities(effective, {
    nameOf: id => installationName(id, record.language)
  });
  const enabled = enabledFor(projected);
  const build = id => toAdminApp(record, { effective, id, enabled, category });

  const taken = await takenAppIds(record, repo);
  const marked = record.publishing?.appId;
  let appId = requestedId || null;
  let resumed = false;
  if (marked && (!requestedId || requestedId === marked)) {
    // An earlier call stopped after the file was written: finish it.
    const existing = await readAppFile(marked);
    // Never onto a file that is switched on when this call would not switch it on.
    const fits = existing && (existing.enabled !== true || enabled === true);
    if (
      fits &&
      isSameApp(existing, build(marked)) &&
      !(await heldByAnother(repo, record, marked))
    ) {
      appId = marked;
      resumed = true;
    } else if (!existing && !taken.has(marked.toLowerCase()) && !requestedId) {
      appId = marked;
    }
  }
  if (!resumed && requestedId && taken.has(requestedId.toLowerCase())) {
    throw new ServiceError('CONFLICT', 'An app with this ID already exists', {
      details: { reason: 'idTaken', id: requestedId }
    });
  }
  if (!appId) appId = suggestedAppId(record, taken);

  let app = build(appId);
  assertValidAdminApp(app);

  const mark = async id => {
    try {
      const stored = await repo.mutate(
        record.id,
        current => ({ ...current, publishing: { appId: id } }),
        { expectedRevision, authorize, bumpRevision: false }
      );
      if (!stored) throw new ServiceError('NOT_FOUND', 'App not found');
    } catch (error) {
      throw asServiceError(error);
    }
  };

  let wrote = false;
  if (!resumed) {
    for (let attempt = 0; ; attempt += 1) {
      await mark(appId);
      try {
        await configStore.createJson(`apps/${appId}.json`, app);
        wrote = true;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        // A parallel call of the same publish wrote it: finish with that file.
        const existing = await readAppFile(appId);
        const fits = existing && (existing.enabled !== true || enabled === true);
        if (fits && isSameApp(existing, app) && !(await heldByAnother(repo, record, appId))) {
          break;
        }
        if (requestedId || attempt >= MAX_ID_ATTEMPTS) {
          throw new ServiceError('CONFLICT', 'An app with this ID already exists', {
            details: { reason: 'idTaken', id: appId }
          });
        }
        taken.add(appId.toLowerCase());
        appId = suggestedAppId(record, taken);
        app = build(appId);
        assertValidAdminApp(app);
      }
    }
    await configCache.refreshAppsCache();
  } else {
    app = (await readAppFile(appId)) || app;
  }

  const at = new Date().toISOString();
  let stored;
  try {
    stored = await repo.mutate(
      record.id,
      current => ({
        ...current,
        state: 'promoted',
        publishedAs: { appId, at, by: { id: String(by.id), name: String(by.name || by.id) } },
        publishing: undefined
      }),
      { expectedRevision, authorize }
    );
    if (!stored) throw new ServiceError('NOT_FOUND', 'App not found');
    // `mutate` cannot change an offer: it has its own call.
    if (stored.pendingOwner) {
      const cleared = await repo.clearOffer(record.id);
      if (cleared?.record) stored = cleared.record;
    }
  } catch (error) {
    // The personal app changed, changed hands or was deleted while the file
    // was written, or the record could not be stored: the copy is not what
    // anyone confirmed. Take the file this
    // call wrote away again, so no app stays behind that no record points to,
    // and take the mark off the record, so a later publish does not pick the
    // file up again.
    // Whatever the error: the record does not point at the file unless a
    // parallel call of the same publish stored it, which the check below sees.
    if (wrote && !stored) {
      try {
        // Unless a parallel call of the same publish finished with this file.
        const current = await repo.get(record.id);
        if (current?.publishedAs?.appId !== appId) {
          await configStore.remove(`apps/${appId}.json`);
          await configCache.refreshAppsCache();
          if (current?.publishing?.appId === appId) {
            await repo.mutate(
              record.id,
              loaded =>
                loaded.publishing?.appId === appId ? { ...loaded, publishing: undefined } : null,
              { bumpRevision: false }
            );
          }
        }
      } catch (cleanupError) {
        logger.error('A company app was written, but its personal app could not be marked', {
          component: COMPONENT,
          userAppId: record.id,
          appId,
          error: cleanupError.message
        });
      }
    }
    throw asServiceError(error);
  }
  return { record: stored, app, projected };
}

/**
 * The audit details of the admin app a publish wrote (design 10).
 *
 * @param {Object} record - The personal app.
 * @param {Object} app - The admin app.
 * @param {ReturnType<typeof projectCapabilities>} projected
 * @returns {Object}
 */
export function publishedAppAuditDetails(record, app, projected) {
  return {
    origin: 'personal',
    userAppId: record.id,
    ownerId: record.owner?.id ?? null,
    enabled: app.enabled === true,
    capabilities: projected.capabilities.map(entry => entry.id),
    integrations: Object.entries(app.integrations || {}).map(([id, binding]) => ({
      id,
      actions: [...(binding.actions || [])]
    })),
    skills: [...(app.skills || [])],
    dropped: projected.dropped.map(entry => ({ id: entry.id, reason: entry.reason }))
  };
}

/**
 * The owner publishes their app. The caller checked that the owner may
 * (`permissions.canPublish`).
 *
 * @param {Object} record - Stored personal app, as the gate loaded it.
 * @param {Object} options
 * @param {Object} options.user - `req.user` of the owner.
 * @param {number} options.expectedRevision - The revision of `If-Match`.
 * @param {(record: Object) => boolean} [options.authorize] - Run on the record
 *   under its lock.
 * @param {ReturnType<typeof currentUserAppSettings>} [options.settings]
 * @param {Object} [options.repository]
 * @returns {Promise<{record: Object, app: Object, projected: Object}>} The
 *   personal app, now `promoted`, and the admin app that was written.
 * @throws {ServiceError} `ETAG_MISMATCH`, `VALIDATION_FAILED`,
 *   `USER_APP_ACCESS_CHANGED`.
 */
export function publishUserApp(
  record,
  { user, expectedRevision, authorize, settings = currentUserAppSettings(), repository } = {}
) {
  return writeCompanyApp(record, {
    runner: user,
    by: user,
    settings,
    expectedRevision,
    authorize,
    enabledFor: projected => startsEnabled(projected.tools, settings),
    repository
  });
}

/**
 * A full admin takes a personal app over as an admin app. The app always
 * starts switched off, and a capability the admin may not use is dropped too.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} options
 * @param {Object} options.admin - `req.user` of the full admin.
 * @param {number} options.expectedRevision - The revision of `If-Match`.
 * @param {string} [options.id] - The ID the admin typed; the server picks one otherwise.
 * @param {string} [options.category]
 * @param {ReturnType<typeof currentUserAppSettings>} [options.settings]
 * @param {Object} [options.repository]
 * @returns {Promise<{record: Object, app: Object, projected: Object}>}
 * @throws {ServiceError} `VALIDATION_FAILED` for an ID that cannot be an app
 *   ID, `CONFLICT` for a taken one, `ETAG_MISMATCH`.
 */
export function promoteUserApp(
  record,
  { admin, expectedRevision, id, category, settings = currentUserAppSettings(), repository } = {}
) {
  if (id !== undefined && appIdProblem(id) !== null) {
    const message = `"${id}" cannot be used as an app ID`;
    throw new ServiceError('VALIDATION_FAILED', message, {
      details: { issues: [{ path: 'id', code: appIdProblem(id), message }] }
    });
  }
  return writeCompanyApp(record, {
    runner: admin,
    by: admin,
    settings,
    expectedRevision,
    enabledFor: () => false,
    requestedId: id,
    category,
    repository
  });
}

/**
 * The company app of a promoted record as the config cache knows it. A file
 * under `publishedAs.appId` without the record's stamp (`sourceUserAppId`)
 * counts as no company app.
 *
 * @param {Object} record - Stored personal app.
 * @returns {{app: Object|null, exists: boolean, visible: boolean}} `visible`:
 *   it is in the list of apps users get (switched on, features and
 *   integrations on).
 */
export function companyAppOf(record) {
  const appId = record?.state === 'promoted' ? record.publishedAs?.appId : null;
  if (!appId) return { app: null, exists: false, visible: false };
  const found = findByIdCaseInsensitive(configCache.getApps(true)?.data || [], appId) || null;
  // An app under this ID that the publish did not stamp is somebody else's.
  if (!isCompanyAppOf(found, record)) return { app: null, exists: false, visible: false };
  const visible = Boolean(findByIdCaseInsensitive(configCache.getApps()?.data || [], appId));
  return { app: found, exists: true, visible };
}

/**
 * Give a published app back to its owner: `state: 'active'`, no
 * `publishedAs`. The company app stays.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} [options]
 * @param {Object} [options.repository]
 * @returns {Promise<{record: Object, released: boolean, appId: string|null}>}
 *   `released` is false when the app was not published; nothing is written then.
 * @throws {ServiceError} `CONFLICT` with `details.reason: 'published'` while
 *   the company app is visible.
 */
export async function releaseUserApp(record, { repository } = {}) {
  const repo = repository || getUserAppRepository();
  if (record.state !== 'promoted') return { record, released: false, appId: null };
  const company = companyAppOf(record);
  if (company.visible) {
    throw new ServiceError('CONFLICT', 'Unpublish or delete the company app first', {
      details: { reason: 'published', appId: company.app.id }
    });
  }
  const appId = record.publishedAs?.appId || null;
  try {
    const stored = await repo.mutate(record.id, current => ({
      ...current,
      state: 'active',
      publishedAs: null,
      publishing: undefined
    }));
    if (!stored) throw new ServiceError('NOT_FOUND', 'App not found');
    return { record: stored, released: true, appId };
  } catch (error) {
    throw asServiceError(error);
  }
}

/**
 * The published apps that are not switched on: for each, the company app's
 * ID and name, the former owner's name and the date. Nothing of the personal
 * app.
 *
 * @param {Object} [options]
 * @param {Object} [options.repository]
 * @returns {Promise<Array<{appId: string, name: Object|string, publishedAt: string|null,
 *   publishedBy: {name: string}|null}>>} Oldest first, at most
 *   {@link MAX_WAITING_LISTED}.
 */
export async function waitingCompanyApps({ repository } = {}) {
  const repo = repository || getUserAppRepository();
  if (!repo.isAvailable()) return [];
  const items = [];
  let cursor = null;
  do {
    const page = await repo.scan({
      filter: record => {
        const company = companyAppOf(record);
        return company.exists && company.app.enabled === false;
      },
      limit: 200,
      cursor
    });
    for (const record of page.items) {
      const { app } = companyAppOf(record);
      if (!app) continue;
      items.push({
        appId: app.id,
        name: app.name ?? app.id,
        publishedAt: record.publishedAs?.at || null,
        publishedBy: record.publishedAs?.by?.name ? { name: record.publishedAs.by.name } : null
      });
    }
    cursor = page.nextCursor;
  } while (cursor && items.length < MAX_WAITING_LISTED);
  return items
    .sort((a, b) => String(a.publishedAt || '').localeCompare(String(b.publishedAt || '')))
    .slice(0, MAX_WAITING_LISTED);
}

/**
 * For a promoted app: how many of the people it is shared with by name
 * cannot use the company app. A person counts as able when the company app
 * is visible and the groups iHub knows for them grant it. A member whose
 * account iHub cannot look up counts as not able. Groups and "everyone" are
 * not counted: iHub does not know who is in them.
 *
 * @param {Object} record - Stored personal app.
 * @returns {number|undefined} Undefined when the app is not published.
 */
export function membersWithoutCompanyApp(record) {
  const company = companyAppOf(record);
  if (effectiveUserAppState(record, { publishedAppExists: company.exists }) !== 'promoted') {
    return undefined;
  }
  const users = (record.members || []).filter(member => member.type === 'user' && member.id);
  if (!company.visible) return users.length;
  let without = 0;
  for (const member of users) {
    let principal = null;
    try {
      const resolved = resolveOwnerPrincipal({
        owner: { userId: String(member.id), name: member.name, authMode: 'local' }
      });
      principal = resolved?.ok ? resolved.user : null;
    } catch {
      principal = null;
    }
    if (!principal || !canUserAccessResource(principal, 'apps', company.app.id)) without += 1;
  }
  return without;
}

/**
 * What the full view of a personal app gains from this module
 * (`registerUserAppViewExtension`): `publish` for an owner who may publish,
 * and `publishedAs` with the name and the state of the company app.
 *
 * @param {{record: Object, permissions: Object, effective: Object, settings: Object}} context
 * @returns {{publish?: Object, publishedAs?: Object}}
 */
export function userAppViewExtras({ record, permissions, effective, settings }) {
  const extras = {};
  if (permissions?.canPublish) extras.publish = publishPreview(record, { effective, settings });
  const company = companyAppOf(record);
  if (company.exists) {
    extras.publishedAs = {
      appId: company.app.id,
      name: company.app.name ?? company.app.id,
      enabled: company.app.enabled !== false,
      at: record.publishedAs?.at || null
    };
  }
  return extras;
}
