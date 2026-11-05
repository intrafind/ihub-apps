// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool references an app offers a chat and the ones a new chat starts
 * with (#2923). Pure functions over the app config, with no service behind
 * them: the integrations picker, the user's preferences route and the chat
 * request builder all read them.
 *
 * @module services/integrations/appIntegrationRefs
 */
import {
  availableOnlyBindingKeys,
  bindingEnabledByDefault,
  defaultEnabledRefs
} from '../../../shared/integrationDefaults.js';

/** Binding keys that bind no tools: iAssistant is reached through the model. */
const SCOPE_ONLY_BINDINGS = new Set(['iassistant']);

/**
 * Every tool reference an app offers a chat: its `tools` and the keys of the
 * integrations it binds for their tools (`app.integrations`), the same list
 * the chat has always started with. A binding with `actions: []` binds an
 * integration for its scopes only and is left out.
 *
 * @param {Object} app
 * @returns {string[]}
 */
export function appCandidateRefs(app) {
  const listed = Array.isArray(app?.tools) ? app.tools.filter(ref => typeof ref === 'string') : [];
  const bindings =
    app?.integrations && typeof app.integrations === 'object' ? app.integrations : {};
  const bound = Object.entries(bindings)
    .filter(
      ([key, binding]) =>
        !SCOPE_ONLY_BINDINGS.has(key) &&
        !(Array.isArray(binding?.actions) && binding.actions.length === 0)
    )
    .map(([key]) => key);
  return [...new Set([...listed, ...bound])];
}

/**
 * The app's own defaults for a new chat: every reference on except the
 * bindings that are available only (`enabledByDefault: false`), web search as
 * the app says.
 *
 * @param {Object} app
 * @returns {{enabledTools: string[], websearchEnabled: boolean}}
 */
export function appIntegrationDefaults(app) {
  return {
    enabledTools: defaultEnabledRefs(app, appCandidateRefs(app)),
    websearchEnabled: app?.websearch?.enabled === true && app.websearch.enabledByDefault === true
  };
}

/**
 * The references a chat request without its own tool list runs with (an API
 * call, a task): the app's defaults, so an integration the app makes available
 * only (`enabledByDefault: false`) is not on just because nobody switched it
 * on. Undefined when the app has no such binding: the chat is then not
 * narrowed at all, exactly as before the setting existed.
 *
 * @param {Object} app
 * @returns {string[]|undefined}
 */
export function appDefaultEnabledTools(app) {
  if (availableOnlyBindingKeys(app).size === 0) return undefined;
  const enabledTools = appIntegrationDefaults(app).enabledTools;
  // iAssistant is not a candidate reference (it is reached through the model),
  // but a binding that ticks actions (`"actions": ["ask"]`) gives the model
  // `iassistant__ask`, and a request that names tools must still keep it.
  const iassistant = app.integrations?.iassistant;
  if (
    Array.isArray(iassistant?.actions) &&
    iassistant.actions.length > 0 &&
    bindingEnabledByDefault(iassistant) &&
    !enabledTools.includes('iassistant')
  ) {
    return [...enabledTools, 'iassistant'];
  }
  return enabledTools;
}
