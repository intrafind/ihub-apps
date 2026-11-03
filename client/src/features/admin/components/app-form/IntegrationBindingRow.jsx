// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS, HELP_CLASS, LABEL_CLASS } from '../formStyles';
import IntegrationBindingOptions from './IntegrationBindingOptions';
import { implicitActionNames, selectedActionNames, toggleBindingAction } from './bindingActions';

/**
 * One row of the app editor's integration bindings: a checkbox that binds an
 * installation, a definition (every installation of it) or a type (every
 * installation of every definition of it), and, once bound, its actions, the
 * Required switch and the scope settings.
 *
 * `actions` absent in the binding means every action except those a
 * definition marks as bound explicitly only (`bindExplicitly`); a
 * list, even an empty one, means exactly those (an empty list binds the
 * installation for its scopes only). A type row offers no action list: the
 * definitions of one type name their actions differently, so a type binding
 * always takes each installation's default actions.
 *
 * A row with `noActions` (a storage provider: it brings files, no model
 * actions) offers no action list either; `newBinding` is the binding a tick
 * creates (a storage provider starts optional) and `requiredHelp` replaces
 * the help text of the Required switch.
 *
 * @param {Object} props
 * @param {{ id: string, label: string, definitionName?: string, enabled?: boolean, kind: 'instance'|'definition'|'type', noActions?: boolean, newBinding?: Object, requiredHelp?: string }} props.item
 * @param {Object|undefined} props.binding - `app.integrations[item.id]`, undefined when unbound
 * @param {Object|undefined} props.detail - the installation as `GET …/installed/:id` returns it (actions, definition)
 * @param {(binding: Object|null) => void} props.onBindingChange - null unbinds
 * @param {React.ReactNode} [props.notice] - shown under the row's name, e.g. the
 *   warnings a definition migration left on this binding
 */
function IntegrationBindingRow({ item, binding, detail, onBindingChange, notice = null }) {
  const { t } = useTranslation();
  const bound = Boolean(binding);
  const current = binding || {};
  const isType = item.kind === 'type';
  const withoutActions = isType || item.noActions === true;
  // A definition row lists the actions the definition declares (through its
  // first installation); an installation row its available ones.
  const actions = withoutActions
    ? []
    : (detail?.actions || []).filter(a =>
        item.kind === 'definition' ? a.enabledByDefault !== false || a.enabled : a.available
      );
  const implicitNames = implicitActionNames(actions);
  const selected = selectedActionNames(current, implicitNames);
  const scopes = withoutActions ? null : detail?.definition?.scopes;
  const checkboxId = `app-integration-${item.id.replace(/[/:]/g, '__')}`;

  const toggleAction = (actionName, checked) =>
    onBindingChange(toggleBindingAction(current, implicitNames, actionName, checked));

  return (
    <div
      data-testid={item.kind === 'instance' ? undefined : `${item.kind}-binding-${item.id}`}
      className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
    >
      <label htmlFor={checkboxId} className="flex items-start gap-3 cursor-pointer">
        <input
          id={checkboxId}
          type="checkbox"
          className={`${CHECKBOX_CLASS} mt-1`}
          checked={bound}
          onChange={e =>
            onBindingChange(e.target.checked ? { ...item.newBinding, ...current } : null)
          }
        />
        <span className="flex-1">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.label}</span>
          {item.kind === 'instance' && (
            <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
              {item.id}
            </span>
          )}
          {item.enabled === false && (
            <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300">
              {t('admin.integrationCatalog.status.disabled', 'Disabled')}
            </span>
          )}
          {item.definitionName && (
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {item.definitionName}
            </span>
          )}
        </span>
      </label>
      {notice && <div className="mt-2 pl-7">{notice}</div>}
      {bound && (
        <div className="mt-3 pl-7 space-y-3">
          {!withoutActions && (
            <div>
              <p className={LABEL_CLASS}>{t('admin.apps.edit.integrations.actions', 'Actions')}</p>
              {!detail && <p className={HELP_CLASS}>{t('common.loading', 'Loading…')}</p>}
              {detail && actions.length === 0 && (
                <p className={HELP_CLASS}>
                  {t(
                    'admin.apps.edit.integrations.noActions',
                    'This installation offers no action right now.'
                  )}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {actions.map(action => (
                  <label
                    key={action.name}
                    className="inline-flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200"
                  >
                    <input
                      type="checkbox"
                      className={`${CHECKBOX_CLASS} mt-0.5`}
                      checked={selected.includes(action.name)}
                      onChange={e => toggleAction(action.name, e.target.checked)}
                    />
                    <span>
                      {action.title}
                      <span className="ml-1 font-mono text-xs text-gray-500 dark:text-gray-400">
                        {action.name}
                      </span>
                      {action.bindExplicitly && (
                        <span className={`${HELP_CLASS} block`}>
                          {t(
                            'admin.apps.edit.integrations.explicitAction',
                            'Only when ticked here; never part of "every action".'
                          )}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <IntegrationBindingOptions
            idPrefix={checkboxId}
            binding={current}
            onBindingChange={onBindingChange}
            scopes={scopes}
            requiredHelp={item.requiredHelp}
          />
        </div>
      )}
    </div>
  );
}

export default IntegrationBindingRow;
