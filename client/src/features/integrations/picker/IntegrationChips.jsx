// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import StatusDot from '../../../shared/components/StatusDot';
import {
  currentScopeOf,
  scopeActionLabel,
  scopeDisplayName
} from '../../chat/utils/integrationScopes';
import ChipOverflow, { HOVER_LABEL } from '../../../shared/components/ChipOverflow';
import IntegrationLogo from './IntegrationLogo';
import { connectionDotOf, isRowOn, needsConnect } from './pickerState';

// `group` drives the hover label of a chip (see HOVER_LABEL).
const CHIP =
  'group flex min-w-0 shrink-0 items-center rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300';

// More than this many chips fold into a "+N" chip.
const MAX_VISIBLE_CHIPS = 3;

/** The status text of a chip's dot. */
function statusLabel(row, t) {
  if (row.connection?.status === 'unavailable') {
    return t('integrationPicker.status.unavailable', 'Unavailable');
  }
  if (needsConnect(row)) {
    return row.connection.status === 'needs_reconnect'
      ? t('integrationPicker.status.reconnect', 'Reconnect needed')
      : t('integrationPicker.status.notConnected', 'Not connected');
  }
  return t('integrationPicker.status.ready', 'Ready');
}

/**
 * The scope of an integration as a chip: a dropdown right in the chip for an
 * app that shows the scope inline (`scopePicker: inline`), else its name.
 */
function ScopeLabel({ integration, disabled, onScopeChange }) {
  const { t, i18n } = useTranslation();
  const action = scopeActionLabel(integration, t);
  const name = scopeDisplayName(integration, i18n.language);
  const current = scopeDisplayName(currentScopeOf(integration), i18n.language);
  const inline =
    integration.scopePicker === 'inline' &&
    !integration.fixed &&
    integration.scopes.length > 1 &&
    onScopeChange;
  if (inline) {
    return (
      <select
        aria-label={`${name}: ${action}`}
        value={integration.current || ''}
        disabled={disabled}
        onChange={event => onScopeChange(integration.id, event.target.value)}
        className="max-w-[10rem] truncate rounded border-0 bg-transparent py-0 pl-1 pr-6 text-xs font-medium text-inherit focus:ring-1 focus:ring-indigo-500"
      >
        {integration.scopes.map(scope => (
          <option key={scope.id} value={scope.id}>
            {scopeDisplayName(scope, i18n.language)}
          </option>
        ))}
      </select>
    );
  }
  return (
    <>
      <span className="sr-only">{`${action}:`}</span>
      <span className="max-w-[10rem] truncate">{current}</span>
    </>
  );
}

/**
 * What the model can reach in the next turn, under the composer (#2923,
 * concept 03 §7.2): web search, and the logo, name and status of every
 * integration switched on in this chat, with its scope where it has one.
 * Integrations that only offer a scope (iAssistant) show the scope.
 *
 * The switches live in the "+" menu; the web search chip turns web search off
 * in one click.
 *
 * @param {Object} props
 * @param {Object[]} props.rows - Picker rows (server)
 * @param {string[]|null} props.enabledTools
 * @param {{available: boolean, enabled: boolean, onChange: Function}|null} [props.websearch]
 * @param {Object[]} [props.scopeIntegrations] - `useIntegrationScopes().integrations`
 * @param {Function|null} [props.onScopeChange]
 * @param {boolean} [props.disabled]
 */
export default function IntegrationChips({
  rows = [],
  enabledTools,
  websearch = null,
  scopeIntegrations = [],
  onScopeChange = null,
  disabled = false
}) {
  const { t, i18n } = useTranslation();
  const scopes = (Array.isArray(scopeIntegrations) ? scopeIntegrations : []).filter(
    integration => integration.scopePicker !== 'hidden' && integration.scopes?.length > 0
  );
  const active = rows.filter(row => isRowOn(row, enabledTools));
  const scopeOnly = scopes.filter(
    integration => !rows.some(row => row.integration && row.integration === integration.id)
  );

  const items = [];

  if (websearch?.available && websearch.enabled) {
    const label = t('websearch.chip', 'Web search');
    items.push({
      key: 'websearch',
      label,
      node: (
        <button
          key="websearch"
          type="button"
          onClick={() => websearch.onChange(false)}
          disabled={disabled}
          aria-pressed="true"
          aria-label={t('websearch.chipLabel', 'Web search is on — turn it off')}
          title={t('websearch.chipTitle', 'Web search is on. Click to turn it off.')}
          className={`${CHIP} transition-colors hover:bg-indigo-100 disabled:opacity-50 dark:hover:bg-indigo-900/60`}
        >
          <Icon name="globe-alt" size="sm" />
          <span className={HOVER_LABEL}>{label}</span>
          <Icon name="x" size="xs" className={HOVER_LABEL} aria-hidden="true" />
        </button>
      )
    });
  }

  for (const row of active) {
    const scope = scopes.find(integration => integration.id === row.integration);
    const dot = connectionDotOf(row);
    items.push({
      key: row.id,
      label: row.name,
      node: (
        <span
          key={row.id}
          data-chip={row.id}
          className={CHIP}
          title={row.description ? `${row.name}: ${row.description}` : row.name}
        >
          <IntegrationLogo row={row} size="sm" />
          <span className={`${HOVER_LABEL} truncate`}>{row.name}</span>
          {dot && (
            <span className="ml-1 flex items-center">
              <StatusDot status={dot} size="sm" label={statusLabel(row, t)} />
            </span>
          )}
          {scope && (
            <span className="ml-1 flex min-w-0 items-center">
              <ScopeLabel integration={scope} disabled={disabled} onScopeChange={onScopeChange} />
            </span>
          )}
        </span>
      )
    });
  }

  for (const integration of scopeOnly) {
    const name = scopeDisplayName(integration, i18n.language);
    items.push({
      key: `scope-${integration.id}`,
      label: name,
      node: (
        <span
          key={`scope-${integration.id}`}
          data-chip={`scope-${integration.id}`}
          className={`${CHIP} gap-1`}
          title={`${name}: ${scopeActionLabel(integration, t)} ${scopeDisplayName(
            currentScopeOf(integration),
            i18n.language
          )}`}
        >
          <Icon name={integration.fixed ? 'lock-closed' : 'search'} size="xs" aria-hidden="true" />
          <span className="sr-only">{name}</span>
          <ScopeLabel integration={integration} disabled={disabled} onScopeChange={onScopeChange} />
        </span>
      )
    });
  }

  return (
    <ChipOverflow
      items={items}
      max={MAX_VISIBLE_CHIPS}
      className="bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
    />
  );
}
