// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Switch from '../../../../shared/components/Switch';
import { HELP_CLASS, RADIO_CLASS } from '../formStyles';
import IntegrationBindingOptions from './IntegrationBindingOptions';

/**
 * App editor card for the integrations of one type (people directories,
 * storage providers), laid out like the other integration panels:
 *
 * - **Enable …** switch: whether the app uses the type at all. Switching it on
 *   binds every installation of the type (`type:<type>`); switching it off
 *   removes every binding of the type (the type key and every row's key).
 * - **All …** (the type binding, with its Required setting) or **Only
 *   selected …** (no type binding: only the ticked rows).
 * - The rows (definitions, installations): with "All" a ticked row gives that
 *   integration settings of its own (actions, Required), which win over the
 *   type binding's; with "Only selected" the ticked rows are what the app uses.
 *
 * @param {Object} props
 * @param {string} props.testId
 * @param {string} props.title
 * @param {string} props.description
 * @param {string} props.enableLabel - label of the switch
 * @param {string} props.allLabel - label of the "every installation" choice
 * @param {string} props.allHelp - help of that choice (how many there are now)
 * @param {string} props.someLabel - label of the "only the ticked ones" choice
 * @param {string} props.typeKey - the type's binding key (`type:storage`)
 * @param {Object<string, Object>} props.bindings - `app.integrations`
 * @param {Array<{ id: string }>} props.rows - the definition and installation rows
 * @param {(row: Object) => React.ReactNode} props.renderRow
 * @param {(patch: Object<string, Object|null>) => void} props.onBindingsChange -
 *   sets several bindings at once; null removes one
 * @param {Object} [props.newBinding] - the binding the type key starts with
 * @param {string} [props.requiredHelp] - help text of the type binding's Required switch
 * @param {React.ReactNode} [props.notice] - shown on top, e.g. a migration warning
 */
function TypeBindingCard({
  testId,
  title,
  description,
  enableLabel,
  allLabel,
  allHelp,
  someLabel,
  typeKey,
  bindings,
  rows,
  renderRow,
  onBindingsChange,
  newBinding = {},
  requiredHelp,
  notice = null
}) {
  const { t } = useTranslation();
  // "Only selected" with nothing ticked yet binds nothing; remember the choice
  // so the switch stays on while the admin ticks the first one.
  const [pickSome, setPickSome] = useState(false);
  const has = key => Object.hasOwn(bindings, key);
  const typeBound = has(typeKey);
  const rowBound = rows.some(row => has(row.id));
  const enabled = typeBound || rowBound || pickSome;
  const idPrefix = `app-integration-${typeKey.replace(/[/:]/g, '__')}`;

  const setEnabled = on => {
    setPickSome(false);
    if (on) {
      onBindingsChange({ [typeKey]: { ...newBinding } });
      return;
    }
    const patch = { [typeKey]: null };
    for (const row of rows) patch[row.id] = null;
    onBindingsChange(patch);
  };

  const chooseAll = all => {
    setPickSome(!all);
    onBindingsChange({ [typeKey]: all ? { ...newBinding, ...bindings[typeKey] } : null });
  };

  return (
    <div
      className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6"
      data-testid={testId}
    >
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {title}
          </h3>
          {description && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
          )}
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-4">
          {notice}
          <Switch
            id={`${idPrefix}-enabled`}
            checked={enabled}
            onChange={setEnabled}
            label={enableLabel}
            labelPosition="start"
          />
          {enabled && (
            <>
              <fieldset className="space-y-2">
                <legend className="sr-only">{enableLabel}</legend>
                <div>
                  <label className="flex items-start gap-3 cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
                    <input
                      type="radio"
                      name={`${idPrefix}-mode`}
                      className={`${RADIO_CLASS} mt-0.5`}
                      checked={typeBound}
                      onChange={() => chooseAll(true)}
                      aria-describedby={`${idPrefix}-all-help`}
                    />
                    {allLabel}
                  </label>
                  <p
                    id={`${idPrefix}-all-help`}
                    className="pl-7 text-xs text-gray-500 dark:text-gray-400"
                  >
                    {allHelp}
                  </p>
                </div>
                {typeBound && (
                  <div className="pl-7 space-y-3">
                    <IntegrationBindingOptions
                      idPrefix={idPrefix}
                      binding={bindings[typeKey]}
                      onBindingChange={binding => onBindingsChange({ [typeKey]: binding })}
                      requiredHelp={requiredHelp}
                    />
                  </div>
                )}
                <label className="flex items-start gap-3 cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
                  <input
                    type="radio"
                    name={`${idPrefix}-mode`}
                    className={`${RADIO_CLASS} mt-0.5`}
                    checked={!typeBound}
                    onChange={() => chooseAll(false)}
                  />
                  {someLabel}
                </label>
              </fieldset>
              {rows.length > 0 && (
                <div className="space-y-3">
                  <p className={HELP_CLASS}>
                    {typeBound
                      ? t(
                          'admin.apps.edit.integrations.typeOverrideHelp',
                          'Tick one to give it settings of its own; the others follow the settings above.'
                        )
                      : t(
                          'admin.apps.edit.integrations.typePickHelp',
                          'The app uses only the ones ticked here.'
                        )}
                  </p>
                  {rows.map(renderRow)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default TypeBindingCard;
