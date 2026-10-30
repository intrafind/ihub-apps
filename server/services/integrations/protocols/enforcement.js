// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { fillValue, fillTemplate } from '../definitions/valuePaths.js';

/**
 * Enforced values: what an installation contributes to an action call and
 * how it combines with what the model sent (see `enforcedValueSchema`).
 *
 * - `fixed`: the install value is sent, the model's value is dropped
 * - `cap`: the smaller number wins
 * - `append`: install value and model value are joined with a space
 * - `default`: the install value only fills a gap
 */

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

/**
 * Apply one enforced value to the arguments.
 * @param {Record<string, unknown>} args - mutated
 * @param {string} param
 * @param {{ value: unknown, mode: string }} rule
 * @param {Record<string, unknown>} values - install values for `{key}` placeholders
 * @returns {Record<string, unknown>} args
 */
export function applyEnforcedValue(args, param, rule, values = {}) {
  if (!rule) return args;
  const resolved = fillValue(rule.value, values);
  if (isEmpty(resolved)) return args;
  const modelValue = args[param];
  const modelHas = !isEmpty(modelValue);

  switch (rule.mode) {
    case 'fixed':
      args[param] = resolved;
      break;
    case 'cap': {
      const limit = Number(resolved);
      if (Number.isNaN(limit)) break;
      const asked = Number(modelValue);
      args[param] = modelHas && !Number.isNaN(asked) ? Math.min(asked, limit) : limit;
      break;
    }
    case 'append':
      args[param] = modelHas ? `${resolved} ${String(modelValue)}`.trim() : resolved;
      break;
    case 'default':
    default:
      if (!modelHas) args[param] = resolved;
  }
  return args;
}

/**
 * Apply every default of an action.
 * @param {Record<string, unknown>} args
 * @param {Record<string, {value: unknown, mode: string}>|undefined} defaults
 * @param {Record<string, unknown>} values
 */
export function applyActionDefaults(args, defaults, values) {
  for (const [param, rule] of Object.entries(defaults || {})) {
    applyEnforcedValue(args, param, rule, values);
  }
  return args;
}

/**
 * Apply the chat's scope pick to an action's arguments.
 *
 * @param {Record<string, unknown>} args
 * @param {object|undefined} scopes - the definition's `scopes` block
 * @param {string} actionName
 * @param {{ id: string, name?: string }|null} scope - the picked scope
 * @param {Record<string, unknown>} values
 */
export function applyScope(args, scopes, actionName, scope, values = {}) {
  if (!scopes || !scope?.id) return args;
  for (const [target, rule] of Object.entries(scopes.applyAs || {})) {
    const [action, param] = target.split('.');
    if (action !== actionName) continue;
    const value =
      typeof rule.value === 'string'
        ? fillTemplate(rule.value, { ...values, id: scope.id, name: scope.name ?? scope.id })
        : rule.value;
    applyEnforcedValue(args, param, { value, mode: rule.mode }, values);
  }
  return args;
}

/**
 * Whether an action's `requires` block holds for the installation.
 * Keys are `install.<fieldKey>`; other prefixes are reserved and ignored.
 * @param {object} action
 * @param {Record<string, unknown>} values
 */
export function actionRequirementsMet(action, values = {}) {
  for (const [key, expected] of Object.entries(action.requires || {})) {
    if (!key.startsWith('install.')) continue;
    const actual = values[key.slice('install.'.length)];
    if (actual !== expected) return false;
  }
  return true;
}

/**
 * Remove parameters the installation fixes from the model-facing schema, and
 * annotate capped ones, so the model is not invited to set what it cannot.
 * @param {object} parameters - JSON schema `{ type: 'object', properties, required }`
 * @param {Record<string, {value: unknown, mode: string}>|undefined} defaults
 * @param {Record<string, unknown>} values
 * @returns {object} a new schema
 */
export function shapeParametersForModel(parameters, defaults, values = {}) {
  const properties = { ...(parameters?.properties || {}) };
  let required = [...(parameters?.required || [])];
  for (const [param, rule] of Object.entries(defaults || {})) {
    if (!(param in properties)) continue;
    const resolved = fillValue(rule.value, values);
    if (isEmpty(resolved)) continue;
    if (rule.mode === 'fixed') {
      delete properties[param];
      required = required.filter(r => r !== param);
    } else if (rule.mode === 'cap') {
      const limit = Number(resolved);
      if (!Number.isNaN(limit)) {
        properties[param] = { ...properties[param], maximum: limit };
      }
    } else if (!isEmpty(resolved)) {
      // the installation fills it when absent, so the model need not
      required = required.filter(r => r !== param);
    }
  }
  return { ...parameters, type: 'object', properties, required };
}
