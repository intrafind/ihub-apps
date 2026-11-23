// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The delete dialogs of models and apps say what names the item before it
 * goes (AI-B12), and that a copy stays in the change history. The server
 * answers `GET …/_dependants`; these helpers turn that answer into the
 * dialog's message and bullet list. Nothing here blocks a delete: the server
 * copes with every reference, so the admin is warned, not stopped.
 *
 * @module features/admin/utils/deleteDependants
 */

import { getLocalizedContent } from '../../../utils/localizeContent';
import { namedList } from './confirmText';

/**
 * The names of referring items, at most five, then "and N more".
 *
 * @param {Array<{id: string, name?: *}>} items
 * @param {(key: string, options?: Object) => string} t
 * @param {string} [language]
 * @returns {string}
 */
function names(items, t, language) {
  return namedList(
    items.map(item => getLocalizedContent(item.name, language) || item.id),
    t
  ).join(', ');
}

/**
 * One bullet per non-empty list: `"{label}: A, B, and 2 more"`.
 *
 * @param {Array<[string, string, Array<Object>]>} rows - `[key, English fallback, items]`.
 * @param {(key: string, options?: Object) => string} t
 * @param {string} [language]
 * @returns {string[]}
 */
function bullets(rows, t, language) {
  return rows
    .filter(([, , items]) => Array.isArray(items) && items.length > 0)
    .map(([key, fallback, items]) =>
      t(key, { names: names(items, t, language), defaultValue: fallback })
    );
}

/**
 * The message of a model or app delete dialog: removed for everyone, and
 * where the copy is kept. The history of a deleted item opens from its own
 * page, which then offers "Restore from History".
 *
 * @param {Object} options
 * @param {'model'|'app'} options.type
 * @param {string} options.path - The item's admin page, e.g. `/admin/models/gpt-4o`.
 * @param {(key: string, options?: Object) => string} options.t
 * @returns {string}
 */
export function deleteWithHistoryMessage({ type, path, t }) {
  return type === 'model'
    ? t('admin.confirm.dependants.modelMessage', {
        path,
        defaultValue:
          'The model is removed for all users. A copy stays in the change history: open {{path}} again to restore it.'
      })
    : t('admin.confirm.dependants.appMessage', {
        path,
        defaultValue:
          'The app is removed for all users. A copy stays in the change history: open {{path}} again to restore it.'
      });
}

/**
 * The bullets of a model delete dialog: the apps, workflows and groups that
 * name the model, and what happens to the default model.
 *
 * @param {Object|null} dependants - `GET /admin/models/{id}/_dependants`, or null
 *   when it could not be read.
 * @param {Object} options
 * @param {(key: string, options?: Object) => string} options.t
 * @param {string} [options.language]
 * @param {(modelId: string) => string} [options.modelName] - Display name of another model.
 * @returns {string[]}
 *
 * @example
 * modelDeleteConsequences({ apps: [{ id: 'chat', name: { en: 'Chat' }, references: ['preferredModel'] }],
 *   workflows: [], groups: [], isDefault: false }, { t, language: 'en' });
 * // ['Apps that name it (they answer with another model): Chat']
 */
export function modelDeleteConsequences(dependants, { t, language, modelName = id => id }) {
  if (!dependants) {
    return [
      t(
        'admin.confirm.dependants.checkFailed',
        'Could not check what uses it. Apps, workflows or groups may still name it.'
      )
    ];
  }
  const result = bullets(
    [
      [
        'admin.confirm.dependants.modelApps',
        'Apps that name it (they answer with another model): {{names}}',
        dependants.apps
      ],
      [
        'admin.confirm.dependants.modelWorkflows',
        'Workflows that name it: {{names}}',
        dependants.workflows
      ],
      [
        'admin.confirm.dependants.modelGroups',
        'Groups that grant it by name: {{names}}',
        dependants.groups
      ]
    ],
    t,
    language
  );
  if (dependants.isDefault) {
    result.push(
      dependants.nextDefaultModelId
        ? t('admin.confirm.dependants.defaultMoves', {
            name: modelName(dependants.nextDefaultModelId),
            defaultValue: 'It is the default model. "{{name}}" becomes the default.'
          })
        : t(
            'admin.confirm.dependants.defaultNone',
            'It is the default model, and no other enabled chat model can take over. Apps without a model of their own have none until you enable one.'
          )
    );
  }
  return result;
}

/**
 * The bullets of an app delete dialog: the prompts, apps, workflows and
 * groups that name the app.
 *
 * @param {Object|null} dependants - `GET /admin/apps/{id}/_dependants`, or null
 *   when it could not be read.
 * @param {Object} options
 * @param {(key: string, options?: Object) => string} options.t
 * @param {string} [options.language]
 * @returns {string[]}
 */
export function appDeleteConsequences(dependants, { t, language }) {
  if (!dependants) {
    return [
      t(
        'admin.confirm.dependants.checkFailed',
        'Could not check what uses it. Apps, workflows or groups may still name it.'
      )
    ];
  }
  const apps = Array.isArray(dependants.apps) ? dependants.apps : [];
  return bullets(
    [
      [
        'admin.confirm.dependants.appPrompts',
        'Prompts that open in it: {{names}}',
        dependants.prompts
      ],
      [
        'admin.confirm.dependants.appTools',
        'Apps that call it as a tool: {{names}}',
        apps.filter(app => app.references?.includes('tool'))
      ],
      [
        'admin.confirm.dependants.appChildren',
        'Apps that inherit from it: {{names}}',
        apps.filter(app => app.references?.includes('parent'))
      ],
      [
        'admin.confirm.dependants.appWorkflows',
        'Workflows that call it: {{names}}',
        dependants.workflows
      ],
      [
        'admin.confirm.dependants.appGroups',
        'Groups that grant it by name: {{names}}',
        dependants.groups
      ]
    ],
    t,
    language
  );
}
