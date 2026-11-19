// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Switch from '../../../../shared/components/Switch';
import {
  ALL_INTEGRATIONS_KEY,
  allIntegrationsBindingOf,
  isCoverableByAllIntegrations,
  isExcludedFromAllIntegrations
} from '../../../../../../shared/appWildcards.js';
import { HELP_CLASS } from '../formStyles';
import AllIntegrationsCoverage from './AllIntegrationsCoverage';
import { AlwaysLoadedCheckbox, EnabledByDefaultCheckbox } from './IntegrationBindingOptions';

/**
 * The app editor's side of "All integrations" (`app.integrations["*"]`,
 * `shared/appWildcards.js`): what the binding covers, the exclusions, and the
 * switch on top of the Integrations card. Kept apart from
 * `IntegrationsConfigSection` so the card stays readable.
 *
 * @module features/admin/components/app-form/allIntegrationsEditor
 */

const TYPE_PREFIX = 'type:';

/** The id prefix of the inputs for a binding key. */
export const inputIdPrefixOf = key => `app-integration-${key.replace(/[/:]/g, '__')}`;

/**
 * The app's `"*"` binding and its exclusions.
 * @param {Object<string, Object>} bindings - `app.integrations`
 * @returns {{ allBinding: Object|null, allExcluded: string[] }}
 */
export function allIntegrationsStateOf(bindings) {
  const allBinding = allIntegrationsBindingOf(bindings);
  const allExcluded = Array.isArray(allBinding?.exclude) ? allBinding.exclude : [];
  return { allBinding, allExcluded };
}

/**
 * The `"*"` binding with `key` added to or removed from `exclude` (dropped once empty).
 * @param {Object} allBinding
 * @param {string} key
 * @param {boolean} excluded
 * @returns {Object}
 */
export function withExclusion(allBinding, key, excluded) {
  const current = Array.isArray(allBinding?.exclude) ? allBinding.exclude : [];
  const rest = current.filter(entry => entry !== key);
  const exclude = excluded ? [...rest, key] : rest;
  const next = { ...allBinding };
  if (exclude.length > 0) next.exclude = exclude;
  else delete next.exclude;
  return next;
}

/**
 * The binding keys of a row, its own first: an installation's id, definition
 * id and type key; a definition row's id and type key.
 * @param {{ id: string, kind: string, definition?: string, type?: string }} item
 * @returns {string[]}
 */
export function rowKeysOf(item) {
  return [
    item.id,
    item.kind === 'instance' ? item.definition : null,
    item.type ? `${TYPE_PREFIX}${item.type}` : null
  ].filter(Boolean);
}

/**
 * Which exclusion leaves a row out of "All integrations", or undefined when
 * `"*"` does not decide the row at all: the app has no `"*"` binding, `"*"`
 * cannot cover it (a storage provider), or a broader binding of the row (its
 * definition or type) decides it instead.
 *
 * @param {Object} options
 * @param {Object<string, Object>} options.bindings - `app.integrations`
 * @param {Set<string>} options.storageRowIds - the rows of the storage card
 * @param {{ id: string, kind: string, definition?: string, type?: string }} item
 * @returns {string|null|undefined} the excluding key, null when covered, undefined when not decided
 */
export function rowExclusionOf({ bindings, storageRowIds }, item) {
  const { allBinding, allExcluded } = allIntegrationsStateOf(bindings);
  if (!allBinding || storageRowIds.has(item.id)) return undefined;
  if (!isCoverableByAllIntegrations({ id: item.id, type: item.type })) return undefined;
  const keys = rowKeysOf(item);
  if (keys.slice(1).some(key => Object.hasOwn(bindings, key))) return undefined;
  return keys.find(key => allExcluded.includes(key)) || null;
}

/**
 * The keys whose "All integrations" control a row or panel shows: a row the
 * app does not bind by itself and `"*"` decides, and the panels in
 * `panelKeys`. An excluded key without one is listed under the switch, so no
 * exclusion is hidden (a collapsed people directories card renders no rows).
 *
 * @param {Object} options
 * @param {Object<string, Object>} options.bindings
 * @param {Set<string>} options.storageRowIds
 * @param {Object[]} options.rows - the rows on screen
 * @param {string[]} options.panelKeys - the panels that show a {@link PanelCoverage}
 * @returns {Set<string>}
 */
export function shownCoverageKeys({ bindings, storageRowIds, rows, panelKeys }) {
  const shown = new Set();
  if (!allIntegrationsBindingOf(bindings)) return shown;
  for (const row of rows) {
    const decided = rowExclusionOf({ bindings, storageRowIds }, row) !== undefined;
    if (decided && !Object.hasOwn(bindings, row.id)) shown.add(row.id);
  }
  for (const key of panelKeys) shown.add(key);
  return shown;
}

/**
 * How many enabled installations "All integrations" covers now.
 * @param {Object[]} installed - `GET …/installed` items
 * @param {Object|null} allBinding
 * @returns {number}
 */
export function coveredInstallationCount(installed, allBinding) {
  return installed.filter(
    item =>
      item.enabled !== false &&
      isCoverableByAllIntegrations(item) &&
      !isExcludedFromAllIntegrations(allBinding, item)
  ).length;
}

/**
 * The note on a panel (iFinder, the people directories) about what "All
 * integrations" does to its integration, while the app does not bind it by
 * itself. `keys` are the integration's binding keys, its own first, so an
 * exclusion by any of them shows.
 */
export function PanelCoverage({ bindings, itemKey, keys = [itemKey], boundByItself, onExclude }) {
  const { allBinding, allExcluded } = allIntegrationsStateOf(bindings);
  if (boundByItself || !allBinding) return null;
  return (
    <AllIntegrationsCoverage
      idPrefix={inputIdPrefixOf(itemKey)}
      itemKey={itemKey}
      excludedBy={keys.find(entry => allExcluded.includes(entry)) || null}
      onExcludeChange={excluded => onExclude(itemKey, excluded)}
    />
  );
}

/**
 * The "Use all integrations" switch on top of the Integrations card, with the
 * settings of the `"*"` binding and the exclusions no row or panel shows.
 *
 * @param {Object} props
 * @param {Object<string, Object>} props.bindings - `app.integrations`
 * @param {number} props.coveredCount - from {@link coveredInstallationCount}
 * @param {Set<string>} props.shownKeys - keys whose exclusion a row or panel shows
 * @param {boolean} props.toolSearchEnabled
 * @param {(binding: Object|null) => void} props.onAllBindingChange - null removes `"*"`
 * @param {(key: string, excluded: boolean) => void} props.onExclude
 */
export function AllIntegrationsSwitch({
  bindings,
  coveredCount,
  shownKeys,
  toolSearchEnabled,
  onAllBindingChange,
  onExclude
}) {
  const { t } = useTranslation();
  const { allBinding, allExcluded } = allIntegrationsStateOf(bindings);
  return (
    <div
      className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 space-y-3"
      data-testid="app-integrations-all"
    >
      <div>
        <Switch
          id="app-integrations-all-switch"
          checked={Boolean(allBinding)}
          onChange={on => onAllBindingChange(on ? {} : null)}
          label={t('admin.apps.edit.integrations.useAll', 'Use all integrations')}
          labelPosition="start"
        />
        <p className={HELP_CLASS}>
          {t(
            'admin.apps.edit.integrations.useAllHelp',
            "Every integration that gives the model tools, including ones installed later ({{count}} now), as far as the user's groups grant them. Web search, storage providers and iAssistant are set up in their own panels.",
            { count: coveredCount }
          )}
        </p>
      </div>
      {allBinding && (
        <div className="space-y-3">
          <EnabledByDefaultCheckbox binding={allBinding} onBindingChange={onAllBindingChange} />
          {toolSearchEnabled && (
            <AlwaysLoadedCheckbox binding={allBinding} onBindingChange={onAllBindingChange} />
          )}
          <p className={HELP_CLASS}>
            {t(
              'admin.apps.edit.integrations.useAllOverrideHelp',
              'Tick an integration below to give it settings of its own (actions, Required, scopes), or exclude it.'
            )}
          </p>
          {allExcluded
            .filter(key => !shownKeys.has(key))
            .map(key => (
              <AllIntegrationsCoverage
                key={key}
                idPrefix={inputIdPrefixOf(key)}
                itemKey={key}
                excludedBy={key}
                showKey
                onExcludeChange={excluded => onExclude(key, excluded)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export { ALL_INTEGRATIONS_KEY };
