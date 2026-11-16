// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an action is in the chat before an admin corrects it
 * (`services/tools/toolCategory`): the declaration of its definition or
 * connector (already on the `discoverActions` result as `activity`), else the
 * engine contract: the `search` action of a web search definition searches the
 * web. Anything else declares nothing and is a plain call.
 *
 * @module services/integrations/actionActivity
 */
import { WEB_SEARCH_ACTION, isWebSearchDefinition } from '../search/webSearchEngines.js';

/**
 * @param {{id: string}} definition
 * @param {{name: string, activity?: Object}} action - a `discoverActions` result
 * @returns {{kind: string, origin?: string, place?: string}|null}
 */
export function declaredActivityOfAction(definition, action) {
  if (action?.activity) return action.activity;
  if (action?.name === WEB_SEARCH_ACTION && isWebSearchDefinition(definition?.id)) {
    return { kind: 'search', origin: 'web' };
  }
  return null;
}
