// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS } from '../formStyles';
import { isAllowlist } from './actionsPolicy';

/** Badge colours of an action's side effect. */
export const SIDE_EFFECT_CLASS = {
  read: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  write: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  destructive: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
  unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
};

/**
 * The side effect of an action as a small badge (read, write, destructive).
 *
 * @param {Object} props
 * @param {string} [props.sideEffect]
 */
export function SideEffectBadge({ sideEffect }) {
  const { t } = useTranslation();
  const effect = sideEffect || 'unknown';
  return (
    <span
      className={`inline-flex px-1.5 py-0.5 rounded-sm text-xs font-medium ${SIDE_EFFECT_CLASS[effect] || SIDE_EFFECT_CLASS.unknown}`}
    >
      {t(`admin.integrationCatalog.sideEffect.${effect}`, effect)}
    </span>
  );
}

/**
 * The actions an installation may offer the model, one checkbox each, with
 * the side effect, the description, a requirement and the "needs a token"
 * hint. For dynamic actions (MCP) it explains where the list comes from.
 * Used by the generic install form and the dedicated editors.
 *
 * @param {Object} props
 * @param {Array<Object>} props.actions - the known actions (`name`, `title`, `sideEffect`, …)
 * @param {Set<string>} props.checked - the names switched on
 * @param {(name: string, on: boolean) => void} props.onToggle
 * @param {string} [props.authMode] - the selected sign-in mode (for "needs a token")
 * @param {boolean} [props.dynamicActions] - the system lists its actions (MCP, A2A)
 * @param {Object|null} [props.storedPolicy] - the installation's saved `actions`
 * @param {string} [props.idPrefix='integration-action'] - prefix of the checkbox ids
 */
function ActionToggleList({
  actions,
  checked,
  onToggle,
  authMode,
  dynamicActions = false,
  storedPolicy = null,
  idPrefix = 'integration-action'
}) {
  const { t } = useTranslation();
  return (
    <>
      {dynamicActions && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {actions.length === 0 && storedPolicy
            ? t(
                'admin.integrationCatalog.wizard.dynamicActionsUnavailable',
                'The server did not list its tools (not reachable, or nobody connected yet). Saving keeps the stored tool selection as it is; test the connection to see and change it.'
              )
            : actions.length === 0
              ? t(
                  'admin.integrationCatalog.wizard.dynamicActionsEmpty',
                  'The server lists its tools when iHub connects. Test the connection to see them; every tool is on until you switch some off.'
                )
              : isAllowlist(storedPolicy)
                ? t(
                    'admin.integrationCatalog.wizard.dynamicActionsAllowlistHint',
                    'These are the tools the server lists; only the checked ones may run, and a tool the server adds later stays off until you switch it on.'
                  )
                : t(
                    'admin.integrationCatalog.wizard.dynamicActionsHint',
                    'These are the tools the server lists; a tool the server adds later is on by default.'
                  )}
        </p>
      )}
      {actions.length > 0 && (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
          {actions.map(action => {
            const needsToken = action.connection === 'token' && authMode === 'none';
            const requirement = action.requires
              ? Object.entries(action.requires)
                  .map(([k, v]) => `${k.replace(/^install\./, '')} = ${String(v)}`)
                  .join(', ')
              : null;
            const inputId = `${idPrefix}-${action.name}`;
            return (
              <li key={action.name} className="flex items-start gap-3 px-3 py-2">
                <input
                  id={inputId}
                  type="checkbox"
                  className={`${CHECKBOX_CLASS} mt-1`}
                  checked={checked.has(action.name)}
                  onChange={e => onToggle(action.name, e.target.checked)}
                />
                <label htmlFor={inputId} className="flex-1 text-sm">
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {action.title || action.name}
                  </span>
                  <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                    {action.name}
                  </span>
                  <span className="ml-2">
                    <SideEffectBadge sideEffect={action.sideEffect} />
                  </span>
                  {action.description && (
                    <span className="block text-gray-600 dark:text-gray-400">
                      {action.description}
                    </span>
                  )}
                  {requirement && (
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {t('admin.integrationCatalog.wizard.requires', 'Requires {{requirement}}', {
                        requirement
                      })}
                    </span>
                  )}
                  {needsToken && (
                    <span className="block text-xs text-amber-700 dark:text-amber-300">
                      {t(
                        'admin.integrationCatalog.wizard.needsToken',
                        'Needs a shared service account; off while sign-in is "none".'
                      )}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export default ActionToggleList;
