// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the editor of a personal app (`/apps/:appId/edit`) works with, as pure
 * functions: the form state built from the server's answer, the merge patch
 * of a save, the state chip, the reason the form is read-only, and the
 * capabilities the app asks for but no longer gets.
 *
 * The server answers with the app as a chat runs it plus `capabilities`
 * (`[{ id, requested, granted, reason }]`). It does not send the stored
 * `capabilities` object, so the form rebuilds it: a switch is on when it was
 * requested; a bound system has the actions the app object carries. For a
 * system that is requested and withheld the actions are not known; such a
 * binding stays in the form untouched and can only be removed.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, 6.3, 9.1, 11.4.
 *
 * @module features/apps/components/user-app/userAppForm
 */

import {
  USER_APP_LIMITS,
  USER_APP_OUTPUT_FORMATS,
  pickUserAppContent
} from '../../../../../../shared/userAppContent.js';

/** Prefix of the capability ID of a bound installation (`integration:<installationId>`). */
const INTEGRATION_PREFIX = 'integration:';

/** Prefix of the capability ID of a linked project (`project:<projectId>`). */
const PROJECT_PREFIX = 'project:';

/**
 * Stands for "the app asks for a model the server does not tell": the model
 * was withheld, so its ID is not in the answer. Never sent.
 */
export const WITHHELD_MODEL = ':withheld';

const LOCALIZED = ['name', 'description', 'system', 'prompt', 'messagePlaceholder'];
const OPTIONAL_TEXTS = ['prompt', 'messagePlaceholder'];
const FLAGS = ['upload', 'webSearch', 'skills'];

/**
 * The keys about how the chat looks and starts, each with the value of "not
 * set" in the form. The form holds them as the content stores them, except
 * that an empty object, an empty text or `false` stands for "not set".
 */
const LOOKS = Object.freeze({
  greeting: {},
  inputMode: {},
  preferredOutputFormat: '',
  startForm: {},
  variablesPanel: {},
  autoStart: false
});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hasText = value =>
  isPlainObject(value) &&
  Object.values(value).some(text => typeof text === 'string' && text.trim());

/** The capability list of an answer, by ID. */
function capabilityMap(app) {
  const list = Array.isArray(app?.capabilities) ? app.capabilities : [];
  return new Map(list.filter(isPlainObject).map(entry => [entry.id, entry]));
}

/**
 * The form state for an app as `GET /api/apps/{appId}` answers it.
 *
 * @param {Object} app - The full body (owner, "Can edit", receiver of an offer, full admin).
 * @returns {{name: Object, description: Object, system: Object, prompt: Object,
 *   messagePlaceholder: Object, icon: string, color: string, variables: Object[],
 *   starterPrompts: Object[], preferredModel: string|null,
 *   capabilities: {upload: boolean, webSearch: boolean, skills: boolean,
 *   integrations: Array<{id: string, actions: string[]}>}}}
 *
 * @example
 * formFromApp({ name: { de: 'Helfer' }, capabilities: [{ id: 'webSearch', requested: true, granted: false }] })
 *   .capabilities.webSearch; // → true
 */
export function formFromApp(app) {
  const source = isPlainObject(app) ? app : {};
  const caps = capabilityMap(source);
  const requested = id => caps.get(id)?.requested === true || caps.get(id)?.granted === true;
  const content = pickUserAppContent({ ...source, capabilities: undefined, integrations: {} });
  const form = {};
  for (const key of LOCALIZED) form[key] = content[key] || {};
  form.icon = content.icon || '';
  form.color = content.color || '';
  form.variables = content.variables || [];
  form.starterPrompts = content.starterPrompts || [];
  for (const [key, unset] of Object.entries(LOOKS))
    form[key] = content[key] ?? structuredClone(unset);
  form.preferredModel =
    typeof source.preferredModel === 'string' && source.preferredModel
      ? source.preferredModel
      : requested('model')
        ? WITHHELD_MODEL
        : null;
  form.capabilities = {
    upload: caps.has('upload') ? requested('upload') : source.upload?.enabled === true,
    webSearch: caps.has('webSearch') ? requested('webSearch') : source.websearch?.enabled === true,
    skills: caps.has('skills') ? requested('skills') : source.skillSettings?.enabled === true,
    integrations: [...caps.keys()]
      .filter(id => id.startsWith(INTEGRATION_PREFIX) && requested(id))
      .map(id => {
        const installationId = id.slice(INTEGRATION_PREFIX.length);
        // The functions the app stores; the app object holds only the ones
        // that run right now, and none for a binding that is withheld.
        const stored = caps.get(id)?.actions;
        const actions = Array.isArray(stored)
          ? stored
          : source.integrations?.[installationId]?.actions;
        return { id: installationId, actions: Array.isArray(actions) ? [...actions] : [] };
      })
  };
  // What the author stored where the app object of a run has less (the models are cut to
  // what this caller may use): the answer's `authored` block, when the caller may edit.
  // The linked projects: as stored where the caller may read it, else the ones the app asks for.
  const requestedProjects = [...caps.keys()]
    .filter(id => id.startsWith(PROJECT_PREFIX) && requested(id))
    .map(id => ({ id: id.slice(PROJECT_PREFIX.length) }));
  if (requestedProjects.length > 0) form.capabilities.projects = requestedProjects;
  const authored = source.authored?.capabilities;
  if (Array.isArray(authored?.projects))
    form.capabilities.projects = structuredClone(authored.projects);
  if (isPlainObject(authored?.models)) form.capabilities.models = structuredClone(authored.models);
  if (isPlainObject(authored?.webSearchSettings)) {
    form.capabilities.webSearchSettings = structuredClone(authored.webSearchSettings);
  }
  return form;
}

/** The greeting with only the languages that have both a title and a subtitle. */
function cleanGreeting(greeting) {
  const clean = {};
  for (const [language, entry] of Object.entries(isPlainObject(greeting) ? greeting : {})) {
    const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
    const subtitle = typeof entry?.subtitle === 'string' ? entry.subtitle.trim() : '';
    if (title && subtitle) clean[language] = { title, subtitle };
  }
  return clean;
}

/**
 * One look as the server would store it: a value that is not set, or not one a
 * personal app may store, becomes the value of "not set" ({@link LOOKS}).
 */
function cleanLook(key, value) {
  switch (key) {
    case 'greeting':
      return cleanGreeting(value);
    case 'inputMode': {
      const clean = {};
      if (value?.type === 'singleline' || value?.type === 'multiline') clean.type = value.type;
      const rows = Number(value?.rows);
      if (Number.isInteger(rows) && rows >= 1 && rows <= USER_APP_LIMITS.inputRows) {
        clean.rows = rows;
      }
      return clean;
    }
    case 'preferredOutputFormat':
      return USER_APP_OUTPUT_FORMATS.includes(value) && value !== 'markdown' ? value : '';
    case 'startForm': {
      if (typeof value?.enabled !== 'boolean') return {};
      const clean = { enabled: value.enabled };
      const label = {};
      for (const [language, text] of Object.entries(
        isPlainObject(value.submitLabel) ? value.submitLabel : {}
      )) {
        if (typeof text === 'string' && text.trim()) label[language] = text.trim();
      }
      if (Object.keys(label).length > 0) clean.submitLabel = label;
      return clean;
    }
    case 'variablesPanel':
      return typeof value?.pinned === 'boolean' ? { pinned: value.pinned } : {};
    default:
      return value === true;
  }
}

/** Whether a look is "not set". */
const isUnset = value =>
  value === '' ||
  value === false ||
  value === undefined ||
  value === null ||
  (isPlainObject(value) && Object.keys(value).length === 0);

/**
 * The merge patch that turns `before` into `after`: objects key by key, a
 * removed key as `null`, anything else as the whole new value. `undefined`
 * when nothing differs.
 */
function mergeDiff(before, after) {
  if (isPlainObject(after)) {
    const old = isPlainObject(before) ? before : {};
    const diff = {};
    for (const [key, value] of Object.entries(after)) {
      const change = mergeDiff(old[key], value);
      if (change !== undefined) diff[key] = change;
    }
    for (const key of Object.keys(old)) if (!Object.hasOwn(after, key)) diff[key] = null;
    return Object.keys(diff).length > 0 ? diff : undefined;
  }
  return same(before, after) ? undefined : after;
}

/** The patch of one look between two form states: `undefined` when it did not change. */
function lookPatch(key, saved, current) {
  const before = cleanLook(key, saved?.[key]);
  const after = cleanLook(key, current?.[key]);
  if (isUnset(after)) return isUnset(before) ? undefined : null;
  return mergeDiff(before, after);
}

/**
 * One of the capability objects as the server would store it, or `{}` when it
 * says nothing: the models (each ID once, a lock only when it is on) and the
 * settings of web search (a whole number of pages, a guidance that is not blank).
 */
function cleanCapabilityObject(key, value) {
  if (key === 'models') {
    const allowed = [
      ...new Set(
        (Array.isArray(value?.allowed) ? value.allowed : []).filter(
          id => typeof id === 'string' && id !== ''
        )
      )
    ];
    return {
      ...(allowed.length > 0 ? { allowed } : {}),
      ...(value?.lock === true ? { lock: true } : {})
    };
  }
  const clean = {};
  const pages = Number(value?.maxPageReads);
  if (value?.maxPageReads !== undefined && value?.maxPageReads !== '' && Number.isInteger(pages)) {
    clean.maxPageReads = pages;
  }
  if (typeof value?.researchGuidance === 'string' && value.researchGuidance.trim()) {
    clean.researchGuidance = value.researchGuidance.trim();
  }
  return clean;
}

/** The linked projects as the server would store them: each ID once, in order. */
function cleanProjects(list) {
  const ids = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.map(id => ({ id }));
}

/** The patch of one capability object between two form states; `undefined` when it did not change. */
function capabilityObjectPatch(key, saved, current) {
  const before = cleanCapabilityObject(key, saved?.capabilities?.[key]);
  const after = cleanCapabilityObject(key, current?.capabilities?.[key]);
  if (isUnset(after)) return isUnset(before) ? undefined : null;
  // Lists are replaced as a whole, objects merge key by key.
  const diff = mergeDiff(before, after);
  return diff;
}

/** A localized text as a merge patch: changed languages, and `null` for removed ones. */
function textPatch(before, after, optional) {
  if (optional && !hasText(after)) return null;
  const patch = {};
  for (const [language, text] of Object.entries(after || {})) {
    if (optional && !(typeof text === 'string' && text.trim())) {
      if (Object.hasOwn(before || {}, language)) patch[language] = null;
    } else if (before?.[language] !== text) patch[language] = text;
  }
  for (const language of Object.keys(before || {})) {
    if (!Object.hasOwn(after || {}, language)) patch[language] = null;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * The body of `PATCH /api/apps/{appId}` (a JSON Merge Patch) for what changed
 * between two form states. Lists are sent whole, with the allowed keys of
 * their entries only; a text that was emptied is removed; a binding whose
 * actions the server did not tell is not sent, so changing the bound systems
 * removes it.
 *
 * @param {Object} saved - The form state of the stored app.
 * @param {Object} current - The form state as edited.
 * @returns {Object|null} `null` when nothing would change.
 *
 * @example
 * patchFor(formFromApp(app), { ...formFromApp(app), color: '#0EA5E9' }); // → { color: '#0EA5E9' }
 */
export function patchFor(saved, current) {
  const patch = {};
  for (const key of LOCALIZED) {
    const optional = OPTIONAL_TEXTS.includes(key);
    if (optional && !hasText(saved[key]) && !hasText(current[key])) continue;
    const change = textPatch(saved[key], current[key], optional);
    if (change !== undefined) patch[key] = change;
  }
  for (const key of ['icon', 'color']) {
    if (current[key] && current[key] !== saved[key]) patch[key] = current[key];
  }
  const picked = pickUserAppContent({
    variables: current.variables,
    starterPrompts: current.starterPrompts
  });
  const pickedSaved = pickUserAppContent({
    variables: saved.variables,
    starterPrompts: saved.starterPrompts
  });
  for (const key of ['variables', 'starterPrompts']) {
    if (!same(picked[key], pickedSaved[key])) patch[key] = picked[key];
  }
  for (const key of Object.keys(LOOKS)) {
    const change = lookPatch(key, saved, current);
    if (change !== undefined) patch[key] = change;
  }
  if (
    current.preferredModel !== saved.preferredModel &&
    current.preferredModel !== WITHHELD_MODEL
  ) {
    patch.preferredModel = current.preferredModel || null;
  }
  const capabilities = {};
  for (const flag of FLAGS) {
    if (current.capabilities[flag] !== saved.capabilities[flag]) {
      capabilities[flag] = current.capabilities[flag] === true;
    }
  }
  if (!same(current.capabilities.integrations, saved.capabilities.integrations)) {
    capabilities.integrations = current.capabilities.integrations
      .filter(binding => binding.actions.length > 0)
      .map(binding => ({ id: binding.id, actions: [...binding.actions] }));
  }
  for (const key of ['models', 'webSearchSettings']) {
    const change = capabilityObjectPatch(key, saved, current);
    if (change !== undefined) capabilities[key] = change;
  }
  // The linked projects are a list and go whole, or `null` when none is left.
  const projectsBefore = cleanProjects(saved.capabilities?.projects);
  const projectsAfter = cleanProjects(current.capabilities?.projects);
  if (!same(projectsBefore, projectsAfter)) {
    capabilities.projects = projectsAfter.length > 0 ? projectsAfter : null;
  }
  if (Object.keys(capabilities).length > 0) patch.capabilities = capabilities;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The capabilities the app asks for and does not get, as the caller may read
 * them. For an owner and an editor these are the ones to remove; the one an
 * editor personally may not use (`youMayNot`) is told apart, because it makes
 * the form read-only for that editor.
 *
 * @param {Object} app - The answer of the server.
 * @returns {Array<{id: string, kind: 'model'|'models'|'upload'|'webSearch'|'skills'|'integration'|'project',
 *   installationId: string|null, name: Object|string|null, reason: string|null}>}
 */
export function withheldCapabilities(app) {
  const list = Array.isArray(app?.capabilities) ? app.capabilities : [];
  return list
    .filter(entry => isPlainObject(entry) && entry.requested === true && entry.granted !== true)
    .map(entry => {
      const integration = String(entry.id).startsWith(INTEGRATION_PREFIX);
      const project = String(entry.id).startsWith(PROJECT_PREFIX);
      return {
        id: entry.id,
        kind: integration ? 'integration' : project ? 'project' : entry.id,
        ...(project ? { projectId: String(entry.id).slice(PROJECT_PREFIX.length) } : {}),
        installationId: integration ? String(entry.id).slice(INTEGRATION_PREFIX.length) : null,
        name: entry.name ?? null,
        reason: entry.reason || null
      };
    });
}

/**
 * The form state without one withheld capability ("Remove").
 *
 * @param {Object} form
 * @param {{kind: string, installationId: string|null}} capability - An entry of
 *   {@link withheldCapabilities}.
 * @returns {Object} A new form state.
 */
export function withoutCapability(form, capability) {
  if (capability.kind === 'model') return { ...form, preferredModel: null };
  if (capability.kind === 'models') {
    const { models: _removed, ...rest } = form.capabilities;
    return { ...form, capabilities: rest };
  }
  if (capability.kind === 'project') {
    const kept = cleanProjects(form.capabilities.projects).filter(
      link => link.id !== capability.projectId
    );
    const { projects: _links, ...rest } = form.capabilities;
    return { ...form, capabilities: kept.length > 0 ? { ...rest, projects: kept } : rest };
  }
  if (capability.kind === 'integration') {
    return {
      ...form,
      capabilities: {
        ...form.capabilities,
        integrations: form.capabilities.integrations.filter(
          binding => binding.id !== capability.installationId
        )
      }
    };
  }
  return { ...form, capabilities: { ...form.capabilities, [capability.kind]: false } };
}

/**
 * Whether a withheld capability is still in the form (it was not removed yet).
 *
 * @param {Object} form
 * @param {{kind: string, installationId: string|null}} capability
 * @returns {boolean}
 */
export function stillAsksFor(form, capability) {
  if (capability.kind === 'model') return form.preferredModel === WITHHELD_MODEL;
  if (capability.kind === 'models')
    return !isUnset(cleanCapabilityObject('models', form.capabilities.models));
  if (capability.kind === 'project') {
    return cleanProjects(form.capabilities.projects).some(link => link.id === capability.projectId);
  }
  if (capability.kind === 'integration') {
    return form.capabilities.integrations.some(binding => binding.id === capability.installationId);
  }
  return form.capabilities[capability.kind] === true;
}

/**
 * What the state chip of the editor says. The chip is text; the key names it.
 * A shared app names people and groups apart: a group is not one person.
 *
 * @param {Object} app - The answer of the server.
 * @returns {{key: string, values?: Object, counts?: {users: number, groups: number},
 *   tone: 'neutral'|'shared'|'warning'}} Render it with {@link userAppStateChipText}.
 *
 * @example
 * userAppStateChip({ state: 'active', sharedWith: { users: 4, groups: 1, everyone: false } });
 * // → { key: 'userApps.edit.state.shared', counts: { users: 4, groups: 1 }, tone: 'shared' }
 */
export function userAppStateChip(app) {
  if (app?.disabled) return { key: 'userApps.edit.state.disabled', tone: 'warning' };
  if (app?.state === 'promoted') return { key: 'userApps.edit.state.promoted', tone: 'warning' };
  if (app?.pendingOwner?.name) {
    return {
      key: 'userApps.edit.state.offered',
      values: { owner: app.pendingOwner.name },
      tone: 'warning'
    };
  }
  const shared = app?.sharedWith || {};
  if (shared.everyone === true) return { key: 'userApps.edit.state.everyone', tone: 'shared' };
  const users = Number(shared.users) || 0;
  const groups = Number(shared.groups) || 0;
  if (users + groups > 0) {
    return { key: 'userApps.edit.state.shared', counts: { users, groups }, tone: 'shared' };
  }
  return { key: 'userApps.edit.state.private', tone: 'neutral' };
}

/**
 * The text of a state chip.
 *
 * @param {ReturnType<typeof userAppStateChip>} chip
 * @param {(key: string, options?: Object) => string} t
 * @returns {string}
 *
 * @example
 * userAppStateChipText({ key: 'userApps.edit.state.shared', counts: { users: 2, groups: 1 } }, t);
 * // → 'Shared with 2 people, 1 group'
 */
export function userAppStateChipText(chip, t) {
  if (!chip.counts) return t(chip.key, chip.values);
  const parts = [];
  if (chip.counts.users > 0) {
    parts.push(t('userApps.edit.state.people', { count: chip.counts.users }));
  }
  if (chip.counts.groups > 0) {
    parts.push(t('userApps.edit.state.groups', { count: chip.counts.groups }));
  }
  return t(chip.key, { list: parts.join(', ') });
}

/**
 * Why the caller cannot change the app, or `null` when they can.
 *
 * - `disabled`: an administrator switched the app off.
 * - `promoted`: the app became a company app.
 * - `ownerBlocked`: an administrator blocked the caller, who owns the app.
 *   Their editors see the suspended shares instead (`role`).
 * - `ownerInactive`: the owner's account is inactive (an editor).
 * - `capability`: the app uses something this editor may not use; `capability`
 *   names the first one.
 * - `role`: the caller is not owner or editor (a "Can use" member, the
 *   receiver of an offer, an administrator). No banner; the form is read-only.
 *
 * @param {Object} app - The answer of the server.
 * @returns {{reason: 'disabled'|'promoted'|'ownerBlocked'|'ownerInactive'|'capability'|'role',
 *   capability?: Object}|null}
 */
export function readOnlyReason(app) {
  const permissions = app?.permissions || {};
  if (app?.disabled) return { reason: 'disabled' };
  if (app?.state === 'promoted') return { reason: 'promoted' };
  if (permissions.isOwner === true && permissions.suspended === 'ownerBlocked') {
    return { reason: 'ownerBlocked' };
  }
  if (
    permissions.role === 'editor' &&
    (permissions.readOnly === true || app?.owner?.active === false)
  ) {
    return { reason: 'ownerInactive' };
  }
  if (permissions.canEdit !== true) return { reason: 'role' };
  if (permissions.isOwner !== true) {
    const denied = withheldCapabilities(app).find(entry => entry.reason === 'youMayNot');
    if (denied) return { reason: 'capability', capability: denied };
  }
  return null;
}

/**
 * Whether the editor offers changing the app with AI: the conversation
 * (with the preview feature `appBuilderChat` on) and "Improve with AI".
 *
 * Drafting with AI must be on for personal apps (`generatorEnabled` of
 * `GET /api/apps/_config`) and the caller must be able to change this app
 * ({@link readOnlyReason} is `null`): the owner, or an editor through
 * sharing. Create rights are not needed; the editor sends the app's ID with
 * every turn (`POST /api/apps/_revise`), and the server checks the same.
 *
 * @param {Object|null|undefined} config - The `userApps` block of `GET /api/apps/_config`.
 * @param {Object|null|undefined} app - The answer of `GET /api/apps/{appId}`.
 * @returns {boolean}
 *
 * @example
 * offersAiChanges({ generatorEnabled: true, canCreate: false }, editorsApp); // → true
 * offersAiChanges({ generatorEnabled: true }, appSharedForUse); // → false
 */
export function offersAiChanges(config, app) {
  return config?.generatorEnabled === true && Boolean(app) && readOnlyReason(app) === null;
}

/**
 * The members of an app as the shares of the share dialog.
 *
 * @param {Array<{type: string, id?: string|null, name?: string, role: string}>} members
 * @returns {Array<{type: string, id: string|null, name?: string, permission: 'use'|'edit'}>}
 */
export function membersToShares(members) {
  return (Array.isArray(members) ? members : []).map(member => ({
    type: member.type,
    id: member.type === 'everyone' ? null : member.id,
    ...(member.name ? { name: member.name } : {}),
    permission: member.role === 'editor' ? 'edit' : 'use'
  }));
}

/**
 * The shares of the share dialog as the body of `PUT /api/apps/{appId}/members`.
 *
 * @param {Array<{type: string, id?: string|null, permission: string}>} shares
 * @returns {Array<{type: string, id?: string, role: 'user'|'editor'}>}
 *
 * @example
 * sharesToMembers([{ type: 'user', id: 'ben', permission: 'edit' }]);
 * // → [{ type: 'user', id: 'ben', role: 'editor' }]
 */
export function sharesToMembers(shares) {
  return (Array.isArray(shares) ? shares : []).map(share => ({
    type: share.type,
    ...(share.type === 'everyone' ? {} : { id: share.id }),
    role: share.permission === 'edit' ? 'editor' : 'user'
  }));
}
