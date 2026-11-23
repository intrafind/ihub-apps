// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The app's prompt template and the call's variables on the last user
 * message, for callers that build their messages themselves.
 *
 * @module services/chat/appPrompt
 */

/**
 * Attach app variables and the app's prompt template to the last user message
 * (where PromptService reads them).
 *
 * `PromptService.processMessageTemplates` only interpolates an app's `prompt`
 * when the message carries it as `promptTemplate` — the browser client puts it
 * there. Headless callers (MCP gateway, A2A, app-as-tool) build their messages
 * themselves, so without this the template and every declared variable were
 * silently dropped and the model saw only the raw message.
 */
export function withAppPrompt(messages, variables, promptTemplate) {
  const list = Array.isArray(messages) ? messages : [];
  const hasVariables = variables && Object.keys(variables).length > 0;
  if (!hasVariables && !promptTemplate) return list;
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return list;
  return list.map((m, i) =>
    i === lastUser
      ? {
          ...m,
          variables: { ...m.variables, ...variables },
          ...(m.promptTemplate ? {} : { promptTemplate: promptTemplate || null })
        }
      : m
  );
}

export default withAppPrompt;
