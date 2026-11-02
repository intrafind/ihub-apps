// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS, HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from '../formStyles';

/** A shallow copy of `object` without `key`. */
function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

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
 * @param {Object} props
 * @param {{ id: string, label: string, definitionName?: string, enabled?: boolean, kind: 'instance'|'definition'|'type' }} props.item
 * @param {Object|undefined} props.binding - `app.integrations[item.id]`, undefined when unbound
 * @param {Object|undefined} props.detail - the installation as `GET …/installed/:id` returns it (actions, definition)
 * @param {(binding: Object|null) => void} props.onBindingChange - null unbinds
 */
function IntegrationBindingRow({ item, binding, detail, onBindingChange }) {
  const { t } = useTranslation();
  const bound = Boolean(binding);
  const current = binding || {};
  const isType = item.kind === 'type';
  // A definition row lists the actions the definition declares (through its
  // first installation); an installation row its available ones.
  const actions = isType
    ? []
    : (detail?.actions || []).filter(a =>
        item.kind === 'definition' ? a.enabledByDefault !== false || a.enabled : a.available
      );
  const implicitNames = actions.filter(a => !a.bindExplicitly).map(a => a.name);
  const selected = Array.isArray(current.actions) ? current.actions : implicitNames;
  const scopes = isType ? null : detail?.definition?.scopes;
  const checkboxId = `app-integration-${item.id.replace(/[/:]/g, '__')}`;

  const toggleAction = (actionName, checked) => {
    const base = Array.isArray(current.actions) ? current.actions : implicitNames;
    const next = checked ? [...new Set([...base, actionName])] : base.filter(n => n !== actionName);
    const sameAsImplicit =
      next.length === implicitNames.length && implicitNames.every(n => next.includes(n));
    const rest = withoutKey(current, 'actions');
    onBindingChange(sameAsImplicit ? rest : { ...rest, actions: next });
  };

  // Absent `required` means required; only an explicit `false` is optional.
  const setRequired = required => {
    const rest = withoutKey(current, 'required');
    onBindingChange(required ? rest : { ...rest, required: false });
  };

  const setScope = patch => {
    const next = { ...current, ...patch };
    for (const key of Object.keys(patch)) {
      if (patch[key] === '' || patch[key] === undefined) delete next[key];
    }
    onBindingChange(next);
  };

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
          onChange={e => onBindingChange(e.target.checked ? { ...current } : null)}
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
      {bound && (
        <div className="mt-3 pl-7 space-y-3">
          {!isType && (
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
          <label className="inline-flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              className={`${CHECKBOX_CLASS} mt-0.5`}
              checked={current.required !== false}
              onChange={e => setRequired(e.target.checked)}
            />
            <span>
              {t('admin.apps.edit.integrations.required', 'Required')}
              <span className={`${HELP_CLASS} block`}>
                {t(
                  'admin.apps.edit.integrations.requiredHelp',
                  'Hide the app while this integration is disabled or missing. Off: the app stays available without its actions.'
                )}
              </span>
            </span>
          </label>
          {scopes && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor={`${checkboxId}-default-scope`} className={LABEL_CLASS}>
                  {t('admin.apps.edit.integrations.defaultScope', 'Default {{scope}}', {
                    scope: scopes.label
                  })}
                </label>
                <input
                  id={`${checkboxId}-default-scope`}
                  className={`${INPUT_CLASS} font-mono`}
                  value={current.defaultScope || ''}
                  onChange={e => setScope({ defaultScope: e.target.value })}
                  placeholder={t('admin.apps.edit.integrations.scopeAny', 'users pick')}
                />
              </div>
              <div>
                <label htmlFor={`${checkboxId}-pinned-scope`} className={LABEL_CLASS}>
                  {t('admin.apps.edit.integrations.pinnedScope', 'Pinned {{scope}}', {
                    scope: scopes.label
                  })}
                </label>
                <input
                  id={`${checkboxId}-pinned-scope`}
                  className={`${INPUT_CLASS} font-mono`}
                  value={current.pinnedScope || ''}
                  onChange={e => setScope({ pinnedScope: e.target.value })}
                />
                <p className={HELP_CLASS}>
                  {t(
                    'admin.apps.edit.integrations.pinnedHelp',
                    'Fixes the scope; users cannot change it.'
                  )}
                </p>
              </div>
              <div>
                <label htmlFor={`${checkboxId}-picker`} className={LABEL_CLASS}>
                  {t('admin.apps.edit.integrations.scopePicker', 'Scope picker')}
                </label>
                <select
                  id={`${checkboxId}-picker`}
                  className={INPUT_CLASS}
                  value={current.scopePicker || 'menu'}
                  onChange={e =>
                    setScope({ scopePicker: e.target.value === 'menu' ? '' : e.target.value })
                  }
                >
                  <option value="menu">
                    {t('admin.apps.edit.integrations.picker.menu', 'In the menu')}
                  </option>
                  <option value="hidden">
                    {t('admin.apps.edit.integrations.picker.hidden', 'Hidden')}
                  </option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default IntegrationBindingRow;
