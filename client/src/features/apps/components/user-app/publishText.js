// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sentences of the two dialogs that turn a personal app into a company
 * app: the owner's "Publish" and the admin's "Take over as app". Both list
 * what the server says the new app will be able to do (`publish` in the
 * owner's view, `takeOverPreview` in the admin view) and what is left behind.
 * Nothing here decides anything: the lists come from the server as they are.
 *
 * Pure functions; no API module is imported, so the admin page can load this
 * file in tests that replace the admin API.
 */

/** The granted capabilities that get a line of their own, and the key of each line. */
const LINE_KEYS = {
  model: 'userApps.publish.can.model',
  upload: 'userApps.publish.can.upload',
  webSearch: 'userApps.publish.can.webSearch'
};

/** The name of a capability that is not a connected system, for "Not taken over: …". */
const NAME_KEYS = {
  model: 'userApps.edit.extras.model',
  upload: 'userApps.edit.extras.upload',
  webSearch: 'userApps.edit.extras.webSearch',
  skills: 'userApps.edit.extras.skills'
};

/** Why a capability is left behind, as the dialog says it. */
const REASON_KEYS = {
  offOnInstallation: 'userApps.publish.reason.offOnInstallation',
  ownerMayNot: 'userApps.publish.reason.ownerMayNot',
  youMayNot: 'userApps.publish.reason.youMayNot',
  ownerInactive: 'userApps.publish.reason.ownerInactive',
  ownerStale: 'userApps.publish.reason.ownerStale'
};

/** What makes an app one that an administrator switches on, for "Because it uses …". */
const TOOL_KEYS = {
  webSearch: 'userApps.publish.tool.webSearch',
  skills: 'userApps.publish.tool.skills',
  integrations: 'userApps.publish.tool.integrations'
};

/**
 * Words joined as a list in the reader's language ("a, b and c").
 *
 * @param {string[]} items
 * @param {string} [language]
 * @returns {string}
 */
export function joinList(items, language) {
  const words = items.filter(Boolean);
  try {
    return new Intl.ListFormat(language || undefined, {
      style: 'long',
      type: 'conjunction'
    }).format(words);
  } catch {
    return words.join(', ');
  }
}

/**
 * One line per capability the new app will have: "take files from users",
 * "search the web", "Jira: search, read", "use the skills: brand-voice".
 * Every action and every skill the server lists is named.
 *
 * @param {Array<Object>|undefined} capabilities - `capabilities` of `publish`
 *   or `takeOverPreview`.
 * @param {(key: string, options?: Object) => string} t
 * @returns {Array<{id: string, text: string}>} One entry when the app will be
 *   able to do nothing beyond the chat.
 */
export function capabilityLines(capabilities, t) {
  const lines = [];
  for (const entry of Array.isArray(capabilities) ? capabilities : []) {
    if (entry.installationId) {
      lines.push({
        id: entry.id,
        text: t('userApps.publish.can.integration', {
          name: entry.name || entry.installationId,
          actions: (entry.actions || []).join(', ')
        })
      });
    } else if (entry.id === 'skills') {
      const skills = Array.isArray(entry.skills) ? entry.skills : [];
      lines.push({
        id: 'skills',
        text:
          skills.length > 0
            ? t('userApps.publish.can.skills', { list: skills.join(', ') })
            : t('userApps.publish.can.skillsNone')
      });
    } else if (LINE_KEYS[entry.id]) {
      lines.push({ id: entry.id, text: t(LINE_KEYS[entry.id], { model: entry.model || '' }) });
    }
  }
  if (lines.length === 0) lines.push({ id: 'none', text: t('userApps.publish.can.none') });
  return lines;
}

/**
 * What is left behind, as one text: "SharePoint (no longer allowed for
 * personal apps), Web search (you may not use it)".
 *
 * @param {Array<{id: string, reason: string, name?: string}>|undefined} dropped
 * @param {(key: string, options?: Object) => string} t
 * @param {Object} [options]
 * @param {boolean} [options.asOwner=false] - The reader is the owner, so "the
 *   owner may not" reads "you may not".
 * @returns {string} Empty when nothing is left behind.
 */
export function droppedText(dropped, t, { asOwner = false } = {}) {
  return (Array.isArray(dropped) ? dropped : [])
    .map(entry => {
      const name = entry.name || (NAME_KEYS[entry.id] ? t(NAME_KEYS[entry.id]) : entry.id);
      const reason = asOwner && entry.reason === 'ownerMayNot' ? 'youMayNot' : entry.reason;
      return REASON_KEYS[reason]
        ? t('userApps.publish.droppedItem', { name, reason: t(REASON_KEYS[reason]) })
        : name;
    })
    .join(', ');
}

/**
 * The tools that keep a published app switched off, as words for a sentence.
 *
 * @param {string[]|undefined} tools - `publish.tools`.
 * @param {(key: string, options?: Object) => string} t
 * @param {string} [language]
 * @returns {string}
 */
export function toolsText(tools, t, language) {
  return joinList(
    (Array.isArray(tools) ? tools : [])
      .filter(tool => TOOL_KEYS[tool])
      .map(tool => t(TOOL_KEYS[tool])),
    language
  );
}
