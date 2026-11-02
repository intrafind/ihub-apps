// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import semver from 'semver';
import {
  checkInstallValues,
  isStrictSemver
} from '../../../validators/integrationDefinitionSchema.js';
import { bindingKeyOfType, typeOfBindingKey } from '../integrationTypes.js';

/**
 * The planner of definition migrations (versioning concept §1 and §3, phase
 * 2): which migrations bring an installation from its `definitionVersion` to
 * the loaded definition, what their declarative steps do to the
 * installation's values, its action policy and the bindings of the apps that
 * bind it, and whether the result is valid against the definition.
 *
 * Pure: no I/O, no clock, no registry. The runner
 * (`DefinitionMigrationRunner.js`) reads the files, calls {@link planMigration}
 * and {@link validateMigrationResult}, and writes only when both say yes; the
 * marketplace preview calls {@link planMigration} with a catalog item's copy
 * of the migrations and writes nothing.
 *
 * Which app bindings a migration rewrites. An app binds an installation by
 * one of three keys of `app.integrations` (`integrationTools.appBindingFor`):
 *
 * - the installation id: the installation's own binding, always rewritten;
 * - the definition id: shared by every installation of the definition. The
 *   action and scope names in it are the definition's, and every
 *   installation of the definition runs the same migrations, so it is
 *   rewritten as well. The steps are idempotent on it: a rename whose source
 *   is gone and whose destination is there (a sibling installation migrated
 *   first) changes nothing and is no collision;
 * - `type:<type>`: shared by every definition of the type, whose actions are
 *   named differently, so the app editor offers no action list there
 *   (`IntegrationBindingRow.jsx`). It is never rewritten; a type binding
 *   that names a renamed or removed action or scope anyway gets a warning.
 *
 * A step whose destination already holds something is a collision; it is
 * recorded (and its change skipped) so that one plan reports every
 * colliding key, and the plan is not `ok`. Nothing is ever overwritten or
 * merged silently.
 *
 * @module services/integrations/definitions/migrationPlanner
 */

/** Warning codes of a plan. */
export const MIGRATION_WARNINGS = Object.freeze({
  /** A removed action was named in an app binding; the app offers it no more. */
  ACTION_REMOVED_FROM_APP: 'ACTION_REMOVED_FROM_APP',
  /** A type binding names a renamed or removed action or scope; type bindings are not rewritten. */
  TYPE_BINDING_NOT_REWRITTEN: 'TYPE_BINDING_NOT_REWRITTEN'
});

/** An install value that counts as not set (as `effectiveValues` skips it). */
function isEmptyValue(value) {
  return value === undefined || value === null || value === '';
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * Order two strings by UTF-16 code units, the order `Array#sort` uses without
 * a compare function: deterministic and independent of the server's locale
 * (lock order across workers, canonical key order).
 */
export function compareCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Canonical JSON (sorted keys) for comparing two stored values or blocks. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort(compareCodeUnits)
      .filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The migrations that bring an installation from `from` up to `to`:
 * every one with `semver.gt(id, from) && semver.lte(id, to)`, in semver
 * order. Skipping versions works: 1.2.0 → 1.4.0 runs 1.3.0 and 1.4.0.
 *
 * @param {Array<{ id: string, steps: Array<object> }>|undefined} migrations
 * @param {string} from - the installation's version (strict semver)
 * @param {string} to - the definition version to reach (strict semver)
 * @returns {Array<{ id: string, steps: Array<object> }>}
 */
export function migrationsBetween(migrations, from, to) {
  if (!isStrictSemver(from) || !isStrictSemver(to)) return [];
  return (migrations || [])
    .filter(m => isStrictSemver(m.id) && semver.gt(m.id, from) && semver.lte(m.id, to))
    .sort((a, b) => semver.compare(a.id, b.id));
}

/**
 * One readable line for a step, as the migration log records it:
 * `1.3.0: renameValue fq → defaultFilter`.
 *
 * @param {string} migrationId
 * @param {object} step - a validated step (one key)
 * @returns {string}
 */
export function describeStep(migrationId, step) {
  const [type] = Object.keys(step || {});
  const body = step?.[type] || {};
  let text;
  switch (type) {
    case 'renameValue':
    case 'renameAction':
    case 'renameScope':
      text = `${type} ${body.from} → ${body.to}`;
      break;
    case 'setValue':
      text = `setValue ${body.key} = ${JSON.stringify(body.value)} (${body.when || 'missing'})`;
      break;
    case 'removeValue':
      text = `removeValue ${body.key}`;
      break;
    case 'mapValue':
      text = `mapValue ${body.key} (${Object.keys(body.map || {}).length} values)`;
      break;
    case 'removeAction':
      text = `removeAction ${body.name}`;
      break;
    default:
      text = String(type);
  }
  return `${migrationId}: ${text}`.slice(0, 500);
}

/**
 * The keys of `app.integrations` that bind an installation: its id, its
 * definition id and its definition's type key (null without a type).
 *
 * @param {{ id: string, definition: string }} instance
 * @param {{ type?: string }} [definition]
 * @returns {{ own: string, definition: string, type: string|null }}
 */
export function bindingKeysOf(instance, definition) {
  return {
    own: instance.id,
    definition: instance.definition,
    type: definition?.type ? bindingKeyOfType(definition.type) : null
  };
}

/**
 * Whether an app binds the installation by any of its keys (the files a
 * migration snapshots, reads and may rewrite).
 *
 * @param {object} app - app JSON
 * @param {{ own: string, definition: string, type: string|null }} keys
 * @returns {boolean}
 */
export function appBindsInstallation(app, keys) {
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object') return false;
  return [keys.own, keys.definition, keys.type].some(key => key && Object.hasOwn(bindings, key));
}

/** The binding keys of an app that a migration rewrites (own and definition), in that order. */
function rewrittenKeys(app, keys) {
  const bindings = app?.integrations || {};
  const out = [];
  for (const key of [keys.own, keys.definition]) {
    if (key && Object.hasOwn(bindings, key) && !out.includes(key)) out.push(key);
  }
  return out;
}

function appIdOf(entry) {
  return entry.app?.id || entry.path || 'app';
}

/** Whether an action name is anywhere in the policy. */
function policyHas(policy, name) {
  return (
    policy.enabled.includes(name) ||
    policy.disabled.includes(name) ||
    Object.hasOwn(policy.overrides, name) ||
    Object.hasOwn(policy.approvalActions, name)
  );
}

function renameInList(list, from, to) {
  return list.map(name => (name === from ? to : name));
}

function renameKey(record, from, to) {
  const out = {};
  for (const [key, value] of Object.entries(record)) out[key === from ? to : key] = value;
  return out;
}

/**
 * The working copy of everything a plan may change.
 * @returns {{ values: object, policy: object, apps: Array<{ path: string, app: object }> }}
 */
function workingState(instance, apps) {
  const actions = instance.actions || {};
  return {
    values: clone(instance.values || {}),
    policy: {
      enabled: Array.isArray(actions.enabled) ? [...actions.enabled] : ['*'],
      disabled: Array.isArray(actions.disabled) ? [...actions.disabled] : [],
      overrides: clone(actions.overrides || {}),
      // Per-action tool approval (#2945) follows a renamed action, so a
      // rename never drops the gate an admin set on it.
      approvalActions: clone(instance.approval?.actions || {})
    },
    apps: apps.map(entry => ({ path: entry.path, app: clone(entry.app) }))
  };
}

/**
 * A step being applied: the working state, the step's type and body, where
 * its collisions and warnings go, and the installation's binding keys.
 *
 * @typedef {object} StepRun
 * @property {{ values: object, policy: object, apps: Array<{ path: string, app: object }> }} state
 * @property {string} type - the step's key (`renameValue`, …)
 * @property {object} body - the step's body
 * @property {string} migrationId
 * @property {{ own: string, definition: string, type: string|null }} keys
 * @property {{ collisions: Array, warnings: Array, policyActions: Set, changedBindings: Set, valueKeys: Set }} out
 */

/** Record a collision of the running step; its change is skipped by the caller. */
function collide(run, kind, key, message, extra = {}) {
  run.out.collisions.push({
    migration: run.migrationId,
    step: run.type,
    kind,
    key,
    message,
    ...extra
  });
}

/** Note that a binding of an app file changed (counted once per file and key). */
function markBindingChanged(run, entry, key) {
  run.out.changedBindings.add(`${entry.path}\u0000${key}`);
}

/** `renameValue`: move a value; an empty source is dropped, a filled destination collides. */
function applyRenameValue(run) {
  const { state, body, out } = run;
  if (!Object.hasOwn(state.values, body.from)) return;
  const value = state.values[body.from];
  if (!isEmptyValue(value) && !isEmptyValue(state.values[body.to])) {
    collide(
      run,
      'value',
      body.to,
      `renameValue ${body.from} → ${body.to}: "${body.to}" already holds a value`
    );
    return;
  }
  delete state.values[body.from];
  out.valueKeys.delete(body.from);
  if (!isEmptyValue(value)) {
    state.values[body.to] = value;
    out.valueKeys.add(body.to);
  }
}

/** `setValue`: set a value when it is missing (default) or always. */
function applySetValue({ state, body, out }) {
  if ((body.when || 'missing') !== 'always' && !isEmptyValue(state.values[body.key])) return;
  if (canonicalJson(state.values[body.key]) !== canonicalJson(body.value)) {
    out.valueKeys.add(body.key);
  }
  state.values[body.key] = clone(body.value);
}

/** `removeValue`: drop a value. */
function applyRemoveValue({ state, body, out }) {
  if (Object.hasOwn(state.values, body.key)) out.valueKeys.add(body.key);
  delete state.values[body.key];
}

/** What `mapValue` turns one entry into: its mapping, or the entry itself when unmapped. */
function mappedEntry(map, entry) {
  return Object.hasOwn(map, String(entry)) ? map[String(entry)] : entry;
}

/** `mapValue` on a list: map each entry, drop the ones mapped to null; new duplicates collide. */
function mapListValue(run, current) {
  const { state, body, out } = run;
  const mapped = [];
  for (const entry of current) {
    const next = mappedEntry(body.map, entry);
    if (next !== null) mapped.push(next);
  }
  const duplicates = mapped.filter((entry, i) => mapped.indexOf(entry) !== i);
  const before = new Set(current.filter((entry, i) => current.indexOf(entry) !== i));
  const landed = [...new Set(duplicates)].filter(entry => !before.has(entry));
  if (landed.length > 0) {
    collide(
      run,
      'value',
      body.key,
      `mapValue ${body.key}: several entries map to ${landed.map(e => JSON.stringify(e)).join(', ')}`
    );
    return;
  }
  if (canonicalJson(mapped) !== canonicalJson(current)) out.valueKeys.add(body.key);
  state.values[body.key] = mapped;
}

/** `mapValue` on a single value: replace a mapped scalar, delete it when mapped to null. */
function mapScalarValue({ state, body, out }, current) {
  if (current === undefined || current === null || typeof current === 'object') return;
  if (!Object.hasOwn(body.map, String(current))) return;
  const next = body.map[String(current)];
  if (next !== current) out.valueKeys.add(body.key);
  if (next === null) delete state.values[body.key];
  else state.values[body.key] = next;
}

/** `mapValue`: rewrite a value, or each entry of a list value, by a map. */
function applyMapValue(run) {
  const current = run.state.values[run.body.key];
  if (Array.isArray(current)) mapListValue(run, current);
  else mapScalarValue(run, current);
}

/** Whether a binding's `actions` list names an action. */
function bindsAction(binding, name) {
  return Array.isArray(binding?.actions) && binding.actions.includes(name);
}

/** `renameAction` in the action policy; a policy that already names the new name collides. */
function renamePolicyAction(run, from, to) {
  const { policy } = run.state;
  if (!policyHas(policy, from)) return;
  if (policyHas(policy, to)) {
    collide(
      run,
      'action',
      to,
      `renameAction ${from} → ${to}: the action policy already names "${to}"`
    );
    return;
  }
  policy.enabled = renameInList(policy.enabled, from, to);
  policy.disabled = renameInList(policy.disabled, from, to);
  policy.overrides = renameKey(policy.overrides, from, to);
  policy.approvalActions = renameKey(policy.approvalActions, from, to);
  run.out.policyActions.add(from);
}

/** `renameAction` in the own and definition bindings of one app. */
function renameBoundAction(run, entry, from, to) {
  for (const key of rewrittenKeys(entry.app, run.keys)) {
    const binding = entry.app.integrations[key];
    if (!bindsAction(binding, from)) continue;
    if (binding.actions.includes(to)) {
      collide(
        run,
        'action',
        to,
        `renameAction ${from} → ${to}: app "${appIdOf(entry)}" already binds "${to}" (${key})`,
        { appId: appIdOf(entry), binding: key }
      );
      continue;
    }
    binding.actions = renameInList(binding.actions, from, to);
    markBindingChanged(run, entry, key);
  }
}

/** `renameAction`: the policy, then each app (its bindings, then a warning for its type binding). */
function applyRenameAction(run) {
  const { from, to } = run.body;
  renamePolicyAction(run, from, to);
  for (const entry of run.state.apps) {
    renameBoundAction(run, entry, from, to);
    warnTypeBinding(entry, run.keys, run.out, run.migrationId, binding =>
      bindsAction(binding, from) ? { action: from, message: `renameAction ${from} → ${to}` } : null
    );
  }
}

/** `removeAction` from the action policy. */
function removePolicyAction(run, name) {
  const { policy } = run.state;
  if (!policyHas(policy, name)) return;
  policy.enabled = policy.enabled.filter(n => n !== name);
  policy.disabled = policy.disabled.filter(n => n !== name);
  delete policy.overrides[name];
  delete policy.approvalActions[name];
  run.out.policyActions.add(name);
}

/** `removeAction` from the own and definition bindings of one app, with a warning per binding. */
function removeBoundAction(run, entry, name) {
  for (const key of rewrittenKeys(entry.app, run.keys)) {
    const binding = entry.app.integrations[key];
    if (!bindsAction(binding, name)) continue;
    binding.actions = binding.actions.filter(n => n !== name);
    markBindingChanged(run, entry, key);
    run.out.warnings.push({
      code: MIGRATION_WARNINGS.ACTION_REMOVED_FROM_APP,
      message: `${run.migrationId}: the action "${name}" was removed; app "${appIdOf(entry)}" bound it (${key}) and no longer offers it`,
      appId: appIdOf(entry),
      action: name,
      key
    });
  }
}

/** `removeAction`: the policy, then each app (its bindings, then a warning for its type binding). */
function applyRemoveAction(run) {
  const { name } = run.body;
  removePolicyAction(run, name);
  for (const entry of run.state.apps) {
    removeBoundAction(run, entry, name);
    warnTypeBinding(entry, run.keys, run.out, run.migrationId, binding =>
      bindsAction(binding, name) ? { action: name, message: `removeAction ${name}` } : null
    );
  }
}

/** `renameScope` in the `defaultScope` and `pinnedScope` of the own and definition bindings of one app. */
function renameBoundScope(run, entry, from, to) {
  for (const key of rewrittenKeys(entry.app, run.keys)) {
    const binding = entry.app.integrations[key];
    if (!binding || typeof binding !== 'object') continue;
    let changed = false;
    for (const field of ['defaultScope', 'pinnedScope']) {
      if (binding[field] === from) {
        binding[field] = to;
        changed = true;
      }
    }
    if (changed) markBindingChanged(run, entry, key);
  }
}

/** `renameScope`: each app (its bindings, then a warning for its type binding). */
function applyRenameScope(run) {
  const { from, to } = run.body;
  for (const entry of run.state.apps) {
    renameBoundScope(run, entry, from, to);
    warnTypeBinding(entry, run.keys, run.out, run.migrationId, binding =>
      binding && (binding.defaultScope === from || binding.pinnedScope === from)
        ? { scope: from, message: `renameScope ${from} → ${to}` }
        : null
    );
  }
}

/** The handler of each declarative step the schema admits. */
const STEP_HANDLERS = new Map([
  ['renameValue', applyRenameValue],
  ['setValue', applySetValue],
  ['removeValue', applyRemoveValue],
  ['mapValue', applyMapValue],
  ['renameAction', applyRenameAction],
  ['removeAction', applyRemoveAction],
  ['renameScope', applyRenameScope]
]);

/**
 * Apply one step to the working state. Collisions and warnings are pushed
 * to `out`; a colliding change is skipped, the rest of the step still runs.
 */
function applyStep(state, step, context, out) {
  const [type] = Object.keys(step);
  const handler = STEP_HANDLERS.get(type);
  if (handler) {
    handler({
      state,
      type,
      body: step[type],
      migrationId: context.migrationId,
      keys: context.keys,
      out
    });
    return;
  }
  // The schema admits only the seven declarative steps; anything else
  // reaching here (a step from an unvalidated source) is refused.
  out.collisions.push({
    migration: context.migrationId,
    step: String(type),
    kind: 'step',
    key: String(type),
    message: `unknown migration step "${type}"`
  });
}

/** A warning when the app's type binding names what a step renamed or removed. */
function warnTypeBinding(entry, keys, out, migrationId, match) {
  if (!keys.type || !typeOfBindingKey(keys.type)) return;
  const binding = entry.app?.integrations?.[keys.type];
  const hit = match(binding);
  if (!hit) return;
  const { message, ...detail } = hit;
  out.warnings.push({
    code: MIGRATION_WARNINGS.TYPE_BINDING_NOT_REWRITTEN,
    message: `${migrationId}: ${message} — app "${appIdOf(entry)}" names it in its type binding ${keys.type}, which is shared with other definitions and not rewritten; edit the app`,
    appId: appIdOf(entry),
    key: keys.type,
    ...detail
  });
}

/** The installation and app files a working state stands for. */
function materialize(instance, state, to) {
  const out = {
    ...clone(instance),
    definitionVersion: to,
    values: clone(state.values),
    actions: {
      enabled: [...state.policy.enabled],
      disabled: [...state.policy.disabled],
      overrides: clone(state.policy.overrides)
    }
  };
  if (instance.approval) {
    const approvalActions = clone(state.policy.approvalActions);
    const approval = {
      ...(instance.approval.default ? { default: instance.approval.default } : {}),
      ...(Object.keys(approvalActions).length ? { actions: approvalActions } : {})
    };
    if (Object.keys(approval).length) out.approval = approval;
    else delete out.approval;
  }
  return {
    instance: out,
    apps: state.apps.map(entry => ({ path: entry.path, app: clone(entry.app) }))
  };
}

/**
 * Plan the migration of one installation from `from` to `to`.
 *
 * @param {object} input
 * @param {object} input.instance - the stored installation (not modified)
 * @param {Array<{ path: string, app: object }>} [input.apps] - the app files
 *   binding it (by id, definition or type key); not modified
 * @param {{ id?: string, type?: string, version?: string, migrations?: Array }} [input.definition]
 *   - the target definition (its `type` decides the type key)
 * @param {string} input.from - the installation's version
 * @param {string} [input.to] - the version to reach (default: `definition.version`)
 * @param {Array<{ id: string, steps: Array }>} [input.migrations] - the
 *   migrations to pick from (default: `definition.migrations`)
 * @returns {{
 *   ok: boolean, from: string, to: string, migrations: string[], steps: string[],
 *   instance: object, apps: Array<{ path: string, appId: string, app: object, changed: boolean }>,
 *   boundaries: Array<{ version: string, instance: object, apps: Array<{ path: string, app: object }> }>,
 *   summary: { values: number, actions: number, apps: number },
 *   warnings: Array<object>, collisions: Array<object>
 * }}
 */
export function planMigration({ instance, apps = [], definition = {}, from, to, migrations }) {
  const target = to || definition.version;
  const selected = migrationsBetween(migrations ?? definition.migrations, from, target);
  const keys = bindingKeysOf(instance, definition);
  const state = workingState(instance, apps);
  const out = {
    collisions: [],
    warnings: [],
    policyActions: new Set(),
    changedBindings: new Set(),
    valueKeys: new Set()
  };
  const steps = [];
  const boundaries = [];
  selected.forEach((migration, index) => {
    for (const step of migration.steps || []) {
      steps.push(describeStep(migration.id, step));
      applyStep(state, step, { migrationId: migration.id, keys }, out);
    }
    if (index < selected.length - 1) {
      boundaries.push({ version: migration.id, ...materialize(instance, state, migration.id) });
    }
  });
  const result = materialize(instance, state, target);
  const changedPaths = new Set([...out.changedBindings].map(entry => entry.split('\u0000')[0]));
  return {
    ok: out.collisions.length === 0,
    from,
    to: target,
    migrations: selected.map(m => m.id),
    steps,
    instance: result.instance,
    apps: result.apps.map(entry => ({
      path: entry.path,
      appId: entry.app?.id || entry.path,
      app: entry.app,
      changed: changedPaths.has(entry.path)
    })),
    boundaries,
    summary: {
      values: out.valueKeys.size,
      actions: out.policyActions.size,
      apps: out.changedBindings.size
    },
    warnings: out.warnings,
    collisions: out.collisions
  };
}

/**
 * The one-line reason of a plan whose steps collided, naming every
 * colliding key (and app).
 *
 * @param {Array<{ key: string, appId?: string, message: string }>} collisions
 * @returns {string}
 */
export function describeCollisions(collisions) {
  const keys = [...new Set(collisions.map(c => (c.appId ? `${c.key} (app ${c.appId})` : c.key)))];
  return `migration collides on ${keys.join(', ')}: ${collisions.map(c => c.message).join('; ')}`;
}

/**
 * Stored values with the definition's defaults filled in where an admin
 * field holds none: the rule of `effectiveValues` (`installedValues.js`),
 * without its URL normalization, for validation only.
 *
 * @param {object} definition
 * @param {Record<string, unknown>} [values]
 * @returns {Record<string, unknown>}
 */
export function withDefaults(definition, values = {}) {
  const out = { ...values };
  for (const field of definition.install || []) {
    if (field.sensitive || (field.scope && field.scope !== 'admin')) continue;
    if (field.default === undefined || !isEmptyValue(out[field.key])) continue;
    out[field.key] = field.default;
  }
  return out;
}

/**
 * Validate a planned result against the target definition before anything
 * is written (concept §3 step 2): the values, with the definition's defaults
 * filled in as the runtime reads them, against the install fields
 * (`checkInstallValues`), every action name of the policy and of the bound
 * apps' `actions` (own and definition bindings) against the definition's
 * actions, a static `defaultScope`/`pinnedScope` against a definition that
 * declares no scopes at all, the sign-in mode against the modes offered, and
 * the `auth` block against the one before the migration (a migration never
 * touches credentials).
 *
 * @param {object} input
 * @param {object} input.before - the installation before the migration
 * @param {object} input.after - the planned installation
 * @param {Array<{ path: string, app: object }>} [input.apps] - the planned app files
 * @param {object} input.definition - the target definition (validated)
 * @param {boolean} [input.dynamicActions] - the protocol lists its actions at
 *   run time (MCP, A2A): action names are not checked
 * @returns {Array<{ kind: string, key: string, message: string, appId?: string }>} empty when valid
 */
export function validateMigrationResult({
  before,
  after,
  apps = [],
  definition,
  dynamicActions = false
}) {
  const mode = after?.auth?.mode || 'none';
  const errors = [
    ...authErrors(before, after, definition, mode),
    ...valueErrors(after, definition, mode)
  ];
  const keys = bindingKeysOf(after, definition);
  const actions = dynamicActions ? [] : actionErrors(after, apps, definition, keys);
  const scopes = definition.scopes ? [] : scopeErrors(apps, definition, keys);
  return [...errors, ...actions, ...scopes];
}

/** `<definition id> <version>`, as the validation messages name the target. */
function targetOf(definition) {
  return `${definition.id} ${definition.version}`;
}

/** The auth block must be the one before the migration, its mode one the definition offers. */
function authErrors(before, after, definition, mode) {
  const errors = [];
  if (canonicalJson(before?.auth ?? null) !== canonicalJson(after?.auth ?? null)) {
    errors.push({
      kind: 'auth',
      key: 'auth',
      message: 'a migration must not change the sign-in block (auth) of an installation'
    });
  }
  if (!(definition.auth?.modes || []).includes(mode)) {
    errors.push({
      kind: 'auth',
      key: 'auth.mode',
      message: `sign-in mode "${mode}" is not offered by ${targetOf(definition)}`
    });
  }
  return errors;
}

/**
 * The values against the install fields. The runtime reads them with the
 * definition's defaults filled in (`effectiveValues`), so a field that
 * became required but has a default is satisfied; the defaults are only
 * used for the check, never stored.
 */
function valueErrors(after, definition, mode) {
  const errors = [];
  for (const issue of checkInstallValues(definition, withDefaults(definition, after?.values), {
    authMode: mode,
    hasCredential: Boolean(after?.auth?.credentialRef)
  })) {
    errors.push({ kind: 'value', key: issue.key, message: `${issue.key}: ${issue.message}` });
  }
  return errors;
}

/** Every action name of the policy, then of the own and definition bindings, against the definition's actions. */
function actionErrors(after, apps, definition, keys) {
  const known = new Set((definition.actions || []).map(action => action.name));
  return [
    ...policyActionErrors(after?.actions || {}, known, definition),
    ...boundActionErrors(apps, keys, known, definition)
  ];
}

/** The action names the policy lists (each once, without `*`) that the definition does not declare. */
function policyActionErrors(policy, known, definition) {
  const named = new Set([
    ...(policy.enabled || []).filter(name => name !== '*'),
    ...(policy.disabled || []),
    ...Object.keys(policy.overrides || {})
  ]);
  return [...named]
    .filter(name => !known.has(name))
    .map(name => ({
      kind: 'action',
      key: name,
      message: `the action policy names "${name}", which ${targetOf(definition)} does not declare`
    }));
}

/** The action names the own and definition bindings of the apps list that the definition does not declare. */
function boundActionErrors(apps, keys, known, definition) {
  const errors = [];
  for (const entry of apps) {
    for (const key of rewrittenKeys(entry.app, keys)) {
      for (const name of entry.app.integrations[key]?.actions || []) {
        if (known.has(name)) continue;
        errors.push({
          kind: 'action',
          key: name,
          appId: appIdOf(entry),
          message: `app "${appIdOf(entry)}" binds the action "${name}" (${key}), which ${targetOf(definition)} does not declare`
        });
      }
    }
  }
  return errors;
}

/** A static `defaultScope`/`pinnedScope` in an own or definition binding, against a definition without scopes. */
function scopeErrors(apps, definition, keys) {
  const errors = [];
  for (const entry of apps) {
    for (const key of rewrittenKeys(entry.app, keys)) {
      const binding = entry.app.integrations[key] || {};
      for (const field of ['defaultScope', 'pinnedScope']) {
        if (!binding[field]) continue;
        errors.push({
          kind: 'scope',
          key: binding[field],
          appId: appIdOf(entry),
          message: `app "${appIdOf(entry)}" sets ${field} "${binding[field]}" (${key}), but ${targetOf(definition)} declares no scopes`
        });
      }
    }
  }
  return errors;
}

/**
 * Where an installation stands with the loaded definition (concept §3), the
 * state the admin API reports and tool loading obeys:
 *
 * - a stored `migrationFailed` or `needsReview` stays until an admin acts;
 * - a missing or invalid `definitionVersion` is `needsReview`;
 * - a definition newer than `definitionVersion` is `migrationPending`; the
 *   installation offers no tools while a migration lies between them, and
 *   keeps serving its old values when none does (a release without
 *   `migration` changes nothing stored; the next run stamps the version);
 * - a definition older than `definitionVersion` (a downgrade) is
 *   `needsReview` (`downgrade: true`), unless a backup is restored for it;
 * - an incompatible definition never migrates: its installation keeps its
 *   data and reports no pending migration (it offers no tools anyway).
 *
 * @param {object} instance - the stored installation
 * @param {{ definition: object, status?: string }|null} entry - its registry
 *   entry, null when the definition is missing
 * @returns {{
 *   status: 'migrationPending'|'migrationFailed'|'needsReview'|null,
 *   statusReason: string|null, blocked: boolean, pending: boolean,
 *   downgrade: boolean, from: string|null, to: string|null, migrations: string[]
 * }}
 */
export function installationMigrationState(instance, entry) {
  const stored = instance?.status || null;
  const from = isStrictSemver(instance?.definitionVersion) ? instance.definitionVersion : null;
  const definition = entry?.definition || null;
  const to = definition?.version || null;
  const base = {
    status: null,
    statusReason: null,
    blocked: false,
    pending: false,
    downgrade: false,
    from,
    to,
    migrations: []
  };
  const newer = Boolean(from && to && isStrictSemver(to) && semver.gt(to, from));
  const between = newer ? migrationsBetween(definition.migrations, from, to).map(m => m.id) : [];
  if (stored === 'migrationFailed' || stored === 'needsReview') {
    return {
      ...base,
      status: stored,
      statusReason: instance.statusReason || null,
      blocked: true,
      pending: newer && entry?.status !== 'incompatible',
      migrations: between
    };
  }
  if (!definition || entry?.status === 'incompatible') return base;
  if (!from) {
    return {
      ...base,
      status: 'needsReview',
      statusReason:
        'the installation records no definitionVersion; adopt the loaded definition version after checking its values, restore a backup, or uninstall it',
      blocked: true
    };
  }
  if (newer) {
    return {
      ...base,
      status: 'migrationPending',
      statusReason:
        between.length > 0
          ? `${definition.id} ${to} is loaded, the installation is at ${from}; the migrations ${between.join(', ')} are pending`
          : `${definition.id} ${to} is loaded, the installation is at ${from}; no migration applies, the next run stamps the new version`,
      blocked: between.length > 0,
      pending: true,
      migrations: between
    };
  }
  if (isStrictSemver(to) && semver.lt(to, from)) {
    return {
      ...base,
      status: 'needsReview',
      statusReason: `${definition.id} ${to} is loaded, older than the installed ${from} (a downgrade); restore the backup of ${to} or adopt the loaded version`,
      blocked: true,
      downgrade: true
    };
  }
  return base;
}
