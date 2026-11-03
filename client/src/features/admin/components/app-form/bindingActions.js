// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The action list of an integration binding (`app.integrations[id].actions`).
 *
 * `actions` absent means every action except those a definition marks as bound
 * explicitly only (`bindExplicitly`: the implicit ones); a list, even an empty
 * one, means exactly those.
 */

/** The names of the actions a binding without `actions` takes. */
export function implicitActionNames(actions) {
  return (actions || []).filter(action => !action.bindExplicitly).map(action => action.name);
}

/** The action names a binding takes. */
export function selectedActionNames(binding, implicitNames) {
  return Array.isArray(binding?.actions) ? binding.actions : implicitNames;
}

/**
 * The binding with one action ticked or unticked. A list that equals the
 * implicit set is stored as no list at all.
 *
 * @param {Object} binding - the current binding
 * @param {string[]} implicitNames - see {@link implicitActionNames}
 * @param {string} actionName
 * @param {boolean} checked
 * @returns {Object} the changed binding
 */
export function toggleBindingAction(binding, implicitNames, actionName, checked) {
  const current = binding || {};
  const base = selectedActionNames(current, implicitNames);
  const next = checked ? [...new Set([...base, actionName])] : base.filter(n => n !== actionName);
  const sameAsImplicit =
    next.length === implicitNames.length && implicitNames.every(n => next.includes(n));
  const rest = { ...current };
  delete rest.actions;
  return sameAsImplicit ? rest : { ...rest, actions: next };
}
