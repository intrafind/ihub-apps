// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The capability ceiling of personal apps.
 *
 * A personal app can never do more than its owner may do and never more than
 * the person chatting may do. This module answers that question in two
 * places: when an app is saved ({@link checkCapabilitiesForSave}) and on
 * every chat request ({@link effectiveUserApp}). The run check is the one
 * that counts, because rights change after a save.
 *
 * {@link effectiveUserApp} also builds the app object a chat runs with. It
 * starts from `personalAppBase(record.id)`, copies the content keys one by
 * one and writes what the ceiling grants. It never spreads a record or a
 * request body, so a key a record should not have cannot reach a chat.
 *
 * Pure: no store, no config cache, no clock of its own. Everything that had
 * to be looked up comes in as `catalog` (`userAppCatalog` in `resolveApp.js`
 * builds it).
 *
 * **The catalog.**
 *
 * ```js
 * {
 *   models: [{ id, enabled, modelType }],          // every model, disabled ones included
 *   installations: [{ id, definition, enabled }],  // every installed integration
 *   features: { skills: true, integrations: true },// feature flags; `false` withholds
 *   webSearch: { owner: true, runner: true },      // a search engine is available to them
 *   skills: { owner: ['a'], runner: ['a', 'b'] }   // global skills granted to them
 * }
 * ```
 *
 * `runner` in the catalog is the person the check is made for: the person
 * chatting on a run, the person saving on a save.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, section 6.
 *
 * @module services/userApps/ceiling
 */
import { canUserAccessResource } from '../../utils/authorization.js';
import { mayUseIntegration } from '../integrations/integrationAccess.js';
import { placeholdersIn } from '../../../shared/appPlaceholders.js';
import {
  PERSONAL_UPLOAD_OFF,
  PERSONAL_UPLOAD_ON,
  USER_APP_LOCALIZED_KEYS,
  USER_APP_STARTER_PROMPT_KEYS,
  USER_APP_VARIABLE_KEYS,
  personalAppBase
} from '../../../shared/userAppContent.js';
import { isOwnerSnapshotStale } from './userAppAccess.js';

/** The capability IDs that are not a bound installation, in the order they are reported. */
export const USER_APP_CAPABILITY_IDS = Object.freeze(['model', 'upload', 'webSearch', 'skills']);

/** The prefix of the capability ID of one bound installation. */
export const INTEGRATION_CAPABILITY_PREFIX = 'integration:';

/** Why a capability was withheld. */
export const CAPABILITY_REASONS = Object.freeze({
  notRequested: 'notRequested',
  offOnInstallation: 'offOnInstallation',
  ownerMayNot: 'ownerMayNot',
  youMayNot: 'youMayNot',
  ownerInactive: 'ownerInactive',
  ownerStale: 'ownerStale'
});

/**
 * The capability ID of a bound installation.
 *
 * @param {string} installationId
 * @returns {string}
 *
 * @example
 * integrationCapabilityId('jira'); // → 'integration:jira'
 */
export function integrationCapabilityId(installationId) {
  return `${INTEGRATION_CAPABILITY_PREFIX}${installationId}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameId(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** The named actions of a binding: strings, each once. */
function actionNames(actions) {
  if (!Array.isArray(actions)) return [];
  return [
    ...new Set(actions.filter(name => typeof name === 'string' && name !== '' && name !== '*'))
  ];
}

/** The bindings a content object asks for, as `[{ id, actions }]`. Anything else is left out. */
function requestedBindings(content) {
  const list = content?.capabilities?.integrations;
  if (!Array.isArray(list)) return [];
  const bindings = [];
  const seen = new Set();
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!id || id === '*' || id.includes(':') || seen.has(id)) continue;
    seen.add(id);
    bindings.push({ id, actions: actionNames(entry.actions) });
  }
  return bindings;
}

/**
 * The reason the owner's side withholds everything, or null: no owner
 * principal (the account is gone, deactivated or could not be looked up), or
 * a snapshot of the owner's groups that is too old to trust.
 */
function ownerVerdict(owner, stale) {
  if (!owner) return CAPABILITY_REASONS.ownerInactive;
  if (stale) return CAPABILITY_REASONS.ownerStale;
  return null;
}

/**
 * One capability, decided in a fixed order: what the installation allows,
 * then the owner, then the person the check is made for.
 *
 * @param {Object} checks
 * @param {boolean} checks.installation - The installation offers it.
 * @param {string|null} checks.ownerState - `ownerInactive`, `ownerStale` or null.
 * @param {boolean} checks.owner - The owner may use it.
 * @param {boolean} checks.runner - The person chatting (or saving) may use it.
 * @returns {string|null} The reason it is withheld; null when it is granted.
 */
function decide({ installation, ownerState, owner, runner }) {
  if (!installation) return CAPABILITY_REASONS.offOnInstallation;
  if (ownerState) return ownerState;
  if (!owner) return CAPABILITY_REASONS.ownerMayNot;
  if (!runner) return CAPABILITY_REASONS.youMayNot;
  return null;
}

/**
 * Every capability of a content object, decided for one owner and one runner.
 *
 * @returns {{model: Object, upload: Object, webSearch: Object, skills: Object,
 *   bindings: Array<Object>}} Each entry is `{ requested, reason }` (`reason`
 *   null when granted); `skills` adds `ids`, a binding adds `id` and `actions`.
 */
function evaluate(content, { runner, owner, settings, catalog, ownerState, strictActions }) {
  const allowed = settings?.capabilities || {};
  const requested = content?.capabilities || {};
  const features = catalog?.features || {};

  // Preferred model.
  const modelId = typeof content?.preferredModel === 'string' ? content.preferredModel : '';
  const modelEntry = (catalog?.models || []).find(model => sameId(model?.id, modelId));
  const chatModel =
    Boolean(modelEntry) &&
    modelEntry.enabled !== false &&
    (modelEntry.modelType || 'chat') === 'chat';
  const model = {
    requested: modelId !== '',
    id: modelEntry?.id || modelId,
    reason:
      modelId === ''
        ? CAPABILITY_REASONS.notRequested
        : decide({
            installation: allowed.modelChoice === true && chatModel,
            ownerState,
            owner: canUserAccessResource(owner, 'models', modelId),
            runner: canUserAccessResource(runner, 'models', modelId)
          })
  };

  // File upload: the installation's switch. The owner's state still counts:
  // an app whose owner is gone or stale runs as plain chat.
  const upload = {
    requested: requested.upload === true,
    reason:
      requested.upload === true
        ? decide({ installation: allowed.upload === true, ownerState, owner: true, runner: true })
        : CAPABILITY_REASONS.notRequested
  };

  // Web search: a search engine both can use.
  const webSearch = {
    requested: requested.webSearch === true,
    reason:
      requested.webSearch === true
        ? decide({
            installation: allowed.webSearch === true,
            ownerState,
            owner: catalog?.webSearch?.owner === true,
            runner: catalog?.webSearch?.runner === true
          })
        : CAPABILITY_REASONS.notRequested
  };

  // Skills: the switch, and the global skills granted to both. Personal skills
  // of the person chatting follow their own rule (`skillAccess.js`).
  const ownerSkills = new Set((catalog?.skills?.owner || []).map(String));
  const skills = {
    requested: requested.skills === true,
    ids: [],
    reason:
      requested.skills === true
        ? decide({
            installation: allowed.skills === true && features.skills !== false,
            ownerState,
            owner: true,
            runner: true
          })
        : CAPABILITY_REASONS.notRequested
  };
  if (!skills.reason) {
    skills.ids = [...new Set((catalog?.skills?.runner || []).map(String))].filter(id =>
      ownerSkills.has(id)
    );
  }

  // Connected systems, one decision per binding.
  const bindings = requestedBindings(content).map(binding => {
    const allowedActions = (allowed.integrations || []).find(entry => entry?.id === binding.id);
    const installation = (catalog?.installations || []).find(entry => entry?.id === binding.id);
    const onList = new Set(actionNames(allowedActions?.actions));
    const actions = binding.actions.filter(action => onList.has(action));
    // A save names only actions the admin listed. A run keeps the ones that
    // are still listed, so taking one action off the list does not stop an
    // app that also uses others.
    const actionsFit = strictActions
      ? binding.actions.length > 0 && actions.length === binding.actions.length
      : actions.length > 0;
    return {
      id: binding.id,
      requested: true,
      actions,
      reason: decide({
        installation:
          features.integrations !== false &&
          Boolean(allowedActions) &&
          Boolean(installation) &&
          installation.enabled !== false &&
          actionsFit,
        ownerState,
        owner: Boolean(owner) && mayUseIntegration(installation, owner),
        runner: mayUseIntegration(installation, runner)
      })
    };
  });

  return { model, upload, webSearch, skills, bindings };
}

/** One entry of the `capabilities` list of {@link effectiveUserApp}. */
function capabilityEntry(id, { requested, reason }) {
  return reason ? { id, requested, granted: false, reason } : { id, requested, granted: true };
}

/** A localized text as a new object with string values only. */
function localizedCopy(value) {
  if (!isPlainObject(value)) return undefined;
  const copy = {};
  for (const [language, text] of Object.entries(value)) {
    if (typeof text === 'string') copy[language] = text;
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
}

/** A list of objects with only the allowed keys of each. */
function listCopy(value, keys) {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isPlainObject).map(entry => {
    const copy = {};
    for (const key of keys) {
      if (Object.hasOwn(entry, key) && entry[key] !== undefined) {
        copy[key] = structuredClone(entry[key]);
      }
    }
    return copy;
  });
}

/**
 * Whether a person can send the form without typing a message: true when the
 * message template uses an input field (the rule of a generated draft).
 */
function templateUsesField(prompt, variables) {
  const names = new Set((variables || []).map(variable => variable?.name).filter(Boolean));
  if (names.size === 0 || !isPlainObject(prompt)) return false;
  return Object.values(prompt).some(
    text => typeof text === 'string' && placeholdersIn(text).some(used => names.has(used))
  );
}

/**
 * Whether `runner` is the owner of `record`.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object|null|undefined} runner - `req.user`.
 * @returns {boolean}
 */
export function isRunnerOwner(record, runner) {
  const ownerId = record?.owner?.id;
  if (ownerId === null || ownerId === undefined || ownerId === '') return false;
  if (runner?.id === null || runner?.id === undefined) return false;
  return String(ownerId) === String(runner.id);
}

/**
 * The app a chat request runs, with what the ceiling grants this runner.
 *
 * @param {Object} record - Stored personal app.
 * @param {Object} context
 * @param {Object} context.runner - `req.user`, with resolved permissions.
 * @param {Object|null} context.owner - The owner's principal with resolved
 *   permissions (`lookupUserAppOwner(record).principal`), or null when the
 *   owner is inactive or could not be looked up. Ignored when the runner is
 *   the owner: the owner's rights are then those of the request.
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} context.settings
 *   The effective `platform.userApps` block.
 * @param {Object} context.catalog - What the caller looked up; see the module description.
 * @param {number} [context.now] - Clock in milliseconds, for the age of the owner snapshot.
 * @returns {{app: Object, capabilities: Array<{id: string, requested: boolean, granted: boolean,
 *   reason?: string}>, approval: {mode: 'writes'|'always', chatGrants: boolean}}}
 *   `app` passes `appConfigSchema` and has only keys of `USER_APP_RUN_KEYS`.
 *   `capabilities` lists `model`, `upload`, `webSearch`, `skills` and one
 *   `integration:<installationId>` per binding.
 *
 * @example
 * const owner = lookupUserAppOwner(record, { settings });
 * const { app, approval } = effectiveUserApp(record, {
 *   runner: req.user, owner: owner.principal, settings, catalog, now: Date.now()
 * });
 */
export function effectiveUserApp(record, { runner, owner, settings, catalog, now = Date.now() }) {
  const content = isPlainObject(record?.content) ? record.content : {};
  const runnerIsOwner = isRunnerOwner(record, runner);
  const effectiveOwner = runnerIsOwner ? runner : owner || null;
  const stale = !runnerIsOwner && isOwnerSnapshotStale(record, settings, now);
  const decided = evaluate(content, {
    runner,
    owner: effectiveOwner,
    settings,
    catalog: runnerIsOwner
      ? {
          ...catalog,
          webSearch: { owner: catalog?.webSearch?.runner, runner: catalog?.webSearch?.runner },
          skills: { owner: catalog?.skills?.runner, runner: catalog?.skills?.runner }
        }
      : catalog,
    ownerState: ownerVerdict(effectiveOwner, stale),
    strictActions: false
  });

  const app = personalAppBase(record.id);

  // Content: copied key by key, never spread.
  for (const key of USER_APP_LOCALIZED_KEYS) {
    const text = localizedCopy(content[key]);
    if (text) app[key] = text;
  }
  if (typeof content.icon === 'string' && content.icon !== '') app.icon = content.icon;
  if (typeof content.color === 'string' && content.color !== '') app.color = content.color;
  const variables = listCopy(content.variables, USER_APP_VARIABLE_KEYS);
  if (variables) app.variables = variables;
  const starterPrompts = listCopy(content.starterPrompts, USER_APP_STARTER_PROMPT_KEYS);
  if (starterPrompts) app.starterPrompts = starterPrompts;
  app.allowEmptyContent = templateUsesField(app.prompt, app.variables);

  // Capabilities: written here, never copied from the record.
  if (!decided.model.reason) app.preferredModel = decided.model.id;
  app.upload = structuredClone(decided.upload.reason ? PERSONAL_UPLOAD_OFF : PERSONAL_UPLOAD_ON);
  app.websearch = decided.webSearch.reason
    ? { enabled: false }
    : { enabled: true, provider: 'auto', enabledByDefault: false, useNativeSearch: false };
  if (!decided.skills.reason) {
    app.skillSettings = { enabled: true, allowPersonal: true };
    app.skills = [...decided.skills.ids];
  }
  const granted = decided.bindings.filter(binding => !binding.reason);
  if (granted.length > 0) {
    app.integrations = {};
    for (const binding of granted) {
      app.integrations[binding.id] = {
        actions: [...binding.actions],
        required: false,
        enabledByDefault: false
      };
    }
  }
  // The owner reads their own instructions; everyone else is asked before
  // every tool call, reads included, and cannot grant a tool for the chat.
  app.toolApproval = { default: runnerIsOwner ? 'writes' : 'always' };

  return {
    app,
    capabilities: [
      capabilityEntry('model', decided.model),
      capabilityEntry('upload', decided.upload),
      capabilityEntry('webSearch', decided.webSearch),
      capabilityEntry('skills', decided.skills),
      ...decided.bindings.map(binding =>
        capabilityEntry(integrationCapabilityId(binding.id), binding)
      )
    ],
    approval: { mode: runnerIsOwner ? 'writes' : 'always', chatGrants: runnerIsOwner }
  };
}

/**
 * What stands in the way of saving `content`. Runs on the whole content of
 * the app (for a `PATCH`: the merged content), whatever the request changes:
 * the instructions steer the capabilities, so a person who may not use what
 * the app uses may not rewrite it either.
 *
 * @param {Object} content - Validated content (`userAppContentSchema`).
 * @param {Object} context
 * @param {Object} context.actor - `req.user` of the person saving.
 * @param {Object|null} context.owner - The owner's principal; `actor` itself
 *   when the owner saves; null when the owner is inactive.
 * @param {ReturnType<typeof import('./userAppSettings.js').userAppSettings>} context.settings
 * @param {Object} context.catalog - See the module description; its `runner`
 *   entries are about `actor`.
 * @returns {Array<{capability: string, reason: string}>} Empty when the
 *   content may be saved. `capability` is `model`, `upload`, `webSearch`,
 *   `skills` or `integration:<installationId>`.
 *
 * @example
 * const [denied] = checkCapabilitiesForSave(merged, { actor: req.user, owner, settings, catalog });
 * if (denied) throw new ServiceError('USER_APP_CAPABILITY_DENIED', '…', { details: denied });
 */
export function checkCapabilitiesForSave(content, { actor, owner, settings, catalog }) {
  const decided = evaluate(isPlainObject(content) ? content : {}, {
    runner: actor,
    owner: owner || null,
    settings,
    catalog,
    ownerState: ownerVerdict(owner || null, false),
    strictActions: true
  });
  const denied = [];
  const note = (capability, entry) => {
    if (entry.requested && entry.reason) denied.push({ capability, reason: entry.reason });
  };
  note('model', decided.model);
  note('upload', decided.upload);
  note('webSearch', decided.webSearch);
  note('skills', decided.skills);
  for (const binding of decided.bindings) note(integrationCapabilityId(binding.id), binding);
  return denied;
}

/**
 * Whether `next` uses nothing that `previous` did not use already, and
 * changes nothing else. A save of this kind by an editor who may not use
 * everything the app uses is accepted: it only takes capabilities away.
 *
 * @param {Object} previous - The stored content.
 * @param {Object} next - The merged content of the save.
 * @returns {boolean}
 */
export function removesCapabilitiesOnly(previous, next) {
  const before = isPlainObject(previous) ? previous : {};
  const after = isPlainObject(next) ? next : {};
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'capabilities' || key === 'preferredModel') continue;
    if (!same(before[key], after[key])) return false;
  }
  // The preferred model may stay or go, not change.
  if (after.preferredModel && !same(before.preferredModel, after.preferredModel)) return false;

  const was = before.capabilities || {};
  const is = after.capabilities || {};
  for (const flag of ['upload', 'webSearch', 'skills']) {
    if (is[flag] === true && was[flag] !== true) return false;
  }
  const wasBound = new Map(requestedBindings(before).map(binding => [binding.id, binding.actions]));
  for (const binding of requestedBindings(after)) {
    const actions = wasBound.get(binding.id);
    if (!actions) return false;
    if (binding.actions.some(action => !actions.includes(action))) return false;
  }
  return true;
}
