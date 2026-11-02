// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import StatusDot from '../../../shared/components/StatusDot';
import IntegrationLogo from './IntegrationLogo';
import {
  currentScopeOf,
  scopeActionLabel,
  scopeDisplayName,
  scopeHint
} from '../../chat/utils/integrationScopes';
import {
  connectionDotOf,
  effectSummary,
  isRowOn,
  matchesQuery,
  needsConnect,
  setRowOn
} from './pickerState';

/** Where "Manage integrations…" goes. */
export const MANAGE_INTEGRATIONS_PATH = '/settings/integrations';

const ROW =
  'flex w-full items-center justify-between gap-2 rounded-lg p-2 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-inset focus:ring-indigo-500 dark:hover:bg-gray-700 dark:focus:bg-gray-700';
const SECTION_TITLE =
  'px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';

/** Activate on Enter or Space: the menu's own key handler cancels the browser's. */
function onActivateKey(action) {
  return event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  };
}

/** The visual track of a switch; the row owns role, state and interaction. */
function SwitchTrack({ on }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors motion-reduce:transition-none ${
        on ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition motion-reduce:transition-none ${
          on ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </span>
  );
}

/**
 * The search field of the picker. Rendered above the menu list, outside it,
 * so the list's arrow-key handling does not take the keys typed here;
 * ArrowDown moves into the list.
 */
export function IntegrationPickerSearch({ value, onChange, onArrowDown, inputRef }) {
  const { t } = useTranslation();
  return (
    <div className="border-b border-gray-200 p-2 dark:border-gray-700">
      <label className="relative block">
        <span className="sr-only">{t('integrationPicker.search', 'Search integrations')}</span>
        <Icon
          name="search"
          size="sm"
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
        />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              onArrowDown?.();
            }
          }}
          placeholder={t('integrationPicker.searchPlaceholder', 'Search integrations…')}
          className="w-full rounded-md border border-gray-300 bg-white py-1.5 pl-8 pr-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </label>
    </div>
  );
}

/**
 * The scope line of a row and its submenu (#3050): where the integration
 * searches or whom it asks, changed per chat.
 */
function ScopePicker({ integration, disabled, onScopeChange, onPicked }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const action = scopeActionLabel(integration, t);
  const current = scopeDisplayName(currentScopeOf(integration), i18n.language);
  const name = scopeDisplayName(integration, i18n.language);
  const canPick = !integration.fixed && integration.scopes.length > 1 && !disabled;
  const expanded = canPick && open;
  const hint = scopeHint(integration, t);
  const toggle = () => {
    if (canPick) setOpen(!expanded);
  };
  return (
    <div role="none" className="pl-2">
      <div
        role="menuitem"
        tabIndex={-1}
        aria-haspopup={canPick ? 'menu' : undefined}
        aria-expanded={canPick ? expanded : undefined}
        aria-disabled={canPick ? undefined : 'true'}
        data-scope-integration={integration.id}
        aria-label={`${name}: ${action} ${current}`}
        className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs text-gray-600 focus:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-inset focus:ring-indigo-500 dark:text-gray-300 dark:focus:bg-gray-700 ${
          canPick ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700' : ''
        }`}
        onClick={toggle}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight') {
            event.preventDefault();
            if (!expanded || event.key !== 'ArrowRight') toggle();
          } else if (event.key === 'ArrowLeft' && expanded) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        title={hint || `${name}: ${action} ${current}`}
      >
        <span className="min-w-0 truncate">
          {action}: <span className="font-medium">{current}</span>
          {integration.fixed && (
            <span className="ml-1">({t('integrationScopes.fixed', 'Set by the app')})</span>
          )}
        </span>
        <Icon
          name={integration.fixed ? 'lock-closed' : expanded ? 'chevronDown' : 'chevronRight'}
          size="sm"
          aria-hidden="true"
          className="shrink-0 text-gray-500 dark:text-gray-400"
        />
      </div>
      {expanded && (
        <div
          role="group"
          aria-label={`${name}: ${action}`}
          className="ml-3 mt-1 space-y-0.5 border-l border-gray-200 pl-2 dark:border-gray-700"
        >
          {integration.scopes.map(scope => {
            const selected = scope.id === integration.current;
            const select = () => {
              onScopeChange(integration.id, scope.id);
              setOpen(false);
              onPicked?.();
            };
            return (
              <div
                key={scope.id}
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={selected}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-inset focus:ring-indigo-500 ${
                  selected
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                    : 'text-gray-800 hover:bg-gray-50 focus:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700 dark:focus:bg-gray-700'
                }`}
                onClick={select}
                onKeyDown={onActivateKey(select)}
              >
                <span className="min-w-0 truncate">{scopeDisplayName(scope, i18n.language)}</span>
                {selected && (
                  <Icon name="check" size="sm" aria-hidden="true" className="shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      )}
      {hint && <p className="px-2 pt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

/**
 * The integrations picker of the chat's "+" menu (#2923, concept 03 §7.2):
 *
 * - **Attach**: upload, and the storage integrations that hand over files;
 * - **Use in this chat**: web search, one row per integration with its effect
 *   summary (`read · write`) — `Connect →` for a personal one the user has not
 *   connected yet — its scope where it has one, and image generation;
 * - **Use as default for new chats** and **Manage integrations…**.
 *
 * Every row comes from the server (`useIntegrationPicker`). A switch changes
 * this chat only; the default changes only when the user saves it.
 *
 * @param {Object} props
 * @param {Object[]} props.rows
 * @param {boolean} [props.loading]
 * @param {string[]|null} props.enabledTools
 * @param {((next: string[]) => void)|null} props.onEnabledToolsChange
 * @param {string} [props.query] - Search text
 * @param {{available: boolean, enabled: boolean, onChange: Function}} [props.websearch]
 * @param {Object[]} [props.scopeIntegrations] - `useIntegrationScopes().integrations`
 * @param {((integrationId: string, scopeId: string) => void)|null} [props.onScopeChange]
 * @param {React.ReactNode} [props.imageGeneration] - Controls, when the model draws images
 * @param {{localUploadEnabled: boolean, onUpload: Function, cloudProviders: Object[], onCloudProviderSelect: Function}} [props.attach]
 * @param {(row: Object) => Promise<void>} [props.onConnect]
 * @param {(() => Promise<void>)|null} [props.onSaveDefault]
 * @param {boolean} [props.disabled]
 * @param {() => void} [props.onDone] - Close the menu after a one-shot action
 */
export default function IntegrationPicker({
  rows = [],
  loading = false,
  enabledTools,
  onEnabledToolsChange,
  query = '',
  websearch = null,
  scopeIntegrations = [],
  onScopeChange = null,
  imageGeneration = null,
  attach = null,
  onConnect = null,
  onSaveDefault = null,
  disabled = false,
  onDone
}) {
  const { t, i18n } = useTranslation();
  const [connectError, setConnectError] = useState(null);
  const [defaultState, setDefaultState] = useState('idle');
  const [imageOpen, setImageOpen] = useState(false);

  const toggleable = Array.isArray(enabledTools) && typeof onEnabledToolsChange === 'function';
  const scopes = (Array.isArray(scopeIntegrations) ? scopeIntegrations : []).filter(
    integration => integration.scopePicker !== 'hidden' && integration.scopes?.length > 0
  );
  const scopeOf = row => scopes.find(integration => integration.id === row.integration) || null;
  // Integrations that only offer a scope (iAssistant: reached through the model).
  const scopeOnly = scopes.filter(
    integration => !rows.some(row => row.integration && row.integration === integration.id)
  );

  const cloudProviders = attach?.cloudProviders || [];
  const uploadLabel = t('integrationPicker.upload', 'Upload file');
  const attachItems = [
    ...(attach?.localUploadEnabled ? [{ id: 'upload', name: uploadLabel }] : []),
    ...cloudProviders.map(provider => ({
      id: `cloud-${provider.id}`,
      name: provider.displayName || provider.name,
      provider
    }))
  ].filter(item => matchesQuery(item, query));

  const websearchLabel = t('websearch.toggleLabel', 'Web Search');
  const showWebsearch = websearch?.available && matchesQuery({ name: websearchLabel }, query);
  const visibleRows = rows.filter(row => matchesQuery(row, query));
  const visibleScopeOnly = scopeOnly.filter(integration =>
    matchesQuery({ name: scopeDisplayName(integration, i18n.language) }, query)
  );
  const imageLabel = t('integrationPicker.imageGeneration', 'Image generation');
  const showImage = Boolean(imageGeneration) && matchesQuery({ name: imageLabel }, query);
  const nothing =
    attachItems.length === 0 &&
    !showWebsearch &&
    visibleRows.length === 0 &&
    visibleScopeOnly.length === 0 &&
    !showImage;

  const toggleRow = row => {
    if (!toggleable || disabled) return;
    onEnabledToolsChange(setRowOn(rows, enabledTools, row.id, !isRowOn(row, enabledTools)));
  };

  const connect = async row => {
    setConnectError(null);
    try {
      await onConnect?.(row);
    } catch {
      setConnectError(row.id);
    }
  };

  const saveDefault = async () => {
    if (!onSaveDefault) return;
    setDefaultState('saving');
    try {
      await onSaveDefault();
      setDefaultState('saved');
    } catch {
      setDefaultState('failed');
    }
  };

  // Settings → Integrations, in a new tab so the chat stays as it is. The
  // base path module is loaded on use (it reads the build's environment).
  const openManage = async () => {
    onDone?.();
    const { buildPath } = await import('../../../utils/runtimeBasePath');
    window.open(buildPath(MANAGE_INTEGRATIONS_PATH), '_blank', 'noopener');
  };

  return (
    <div className="p-2" role="none">
      {attachItems.length > 0 && (
        <div role="group" aria-label={t('integrationPicker.attach', 'Attach')} className="mb-2">
          <div className={SECTION_TITLE} aria-hidden="true">
            {t('integrationPicker.attach', 'Attach')}
          </div>
          {attachItems.map(item => {
            const run = () => {
              if (item.provider) attach.onCloudProviderSelect?.(item.provider);
              else attach.onUpload?.();
              onDone?.();
            };
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={disabled}
                onClick={run}
                onKeyDown={onActivateKey(run)}
                className={`${ROW} disabled:opacity-50`}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
                  <Icon
                    name={item.provider ? 'cloud' : 'paper-clip'}
                    size="sm"
                    aria-hidden="true"
                    className="shrink-0 text-gray-500 dark:text-gray-400"
                  />
                  <span className="truncate">{item.name}</span>
                </span>
                {item.provider && (
                  <Icon
                    name="chevronRight"
                    size="sm"
                    aria-hidden="true"
                    className="shrink-0 text-gray-400"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div role="group" aria-label={t('integrationScopes.menuTitle', 'Use in this chat')}>
        <div className={SECTION_TITLE} aria-hidden="true">
          {t('integrationScopes.menuTitle', 'Use in this chat')}
        </div>

        {showWebsearch && (
          <div
            role="menuitemcheckbox"
            tabIndex={-1}
            aria-checked={websearch.enabled}
            aria-disabled={disabled ? 'true' : undefined}
            className={`${ROW} cursor-pointer`}
            onClick={() => !disabled && websearch.onChange(!websearch.enabled)}
            onKeyDown={onActivateKey(() => !disabled && websearch.onChange(!websearch.enabled))}
          >
            <span className="flex min-w-0 items-center gap-2">
              <IntegrationLogo row={{ kind: 'websearch' }} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  {websearchLabel}
                </span>
                <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                  {t('integrationPicker.effect.read', 'read')}
                </span>
              </span>
            </span>
            <SwitchTrack on={websearch.enabled} />
          </div>
        )}

        {loading && rows.length === 0 && (
          <div className="px-2 py-1 text-sm text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </div>
        )}

        {visibleRows.map(row => {
          const on = isRowOn(row, enabledTools);
          const effects = effectSummary(row.effects, t);
          const scope = scopeOf(row);
          const dot = connectionDotOf(row);
          const unavailable = row.connection?.status === 'unavailable';
          if (needsConnect(row)) {
            const reconnect = row.connection.status === 'needs_reconnect';
            const canConnect = row.connection.connectable && onConnect && !disabled;
            return (
              <div key={row.id} role="none">
                <div
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={canConnect ? undefined : 'true'}
                  data-row={row.id}
                  className={`${ROW} ${canConnect ? 'cursor-pointer' : ''}`}
                  onClick={() => canConnect && connect(row)}
                  onKeyDown={onActivateKey(() => canConnect && connect(row))}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <IntegrationLogo row={row} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                        <span className="truncate">{row.name}</span>
                        <StatusDot
                          status="warn"
                          size="sm"
                          label={
                            reconnect
                              ? t('integrationPicker.status.reconnect', 'Reconnect needed')
                              : t('integrationPicker.status.notConnected', 'Not connected')
                          }
                        />
                      </span>
                      {effects && (
                        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                          {effects}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-indigo-600 dark:text-indigo-400">
                    {reconnect
                      ? t('integrationPicker.reconnect', 'Reconnect →')
                      : t('integrationPicker.connect', 'Connect →')}
                  </span>
                </div>
                {connectError === row.id && (
                  <p role="alert" className="px-2 text-xs text-red-600 dark:text-red-400">
                    {t('integrationPicker.connectFailed', 'The sign-in could not be started.')}
                  </p>
                )}
              </div>
            );
          }
          const canToggle = toggleable && !disabled && !unavailable;
          return (
            <div key={row.id} role="none">
              <div
                role="menuitemcheckbox"
                tabIndex={-1}
                aria-checked={on}
                aria-disabled={canToggle ? undefined : 'true'}
                data-row={row.id}
                className={`${ROW} ${canToggle ? 'cursor-pointer' : 'opacity-60'}`}
                onClick={() => canToggle && toggleRow(row)}
                onKeyDown={onActivateKey(() => canToggle && toggleRow(row))}
                title={row.description || undefined}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <IntegrationLogo row={row} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                      <span className="truncate">{row.name}</span>
                      {dot === 'error' && (
                        <StatusDot
                          status="error"
                          size="sm"
                          label={t('integrationPicker.status.unavailable', 'Unavailable')}
                        />
                      )}
                    </span>
                    {effects && (
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                        {effects}
                      </span>
                    )}
                  </span>
                </span>
                <SwitchTrack on={on} />
              </div>
              {scope && on && onScopeChange && (
                <ScopePicker
                  integration={scope}
                  disabled={disabled}
                  onScopeChange={onScopeChange}
                  onPicked={onDone}
                />
              )}
            </div>
          );
        })}

        {onScopeChange &&
          visibleScopeOnly.map(integration => (
            <div key={`scope-${integration.id}`} role="none" className="py-1">
              <div className="flex items-center gap-2 px-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                <IntegrationLogo row={{ name: scopeDisplayName(integration, i18n.language) }} />
                <span className="truncate">{scopeDisplayName(integration, i18n.language)}</span>
              </div>
              <ScopePicker
                integration={integration}
                disabled={disabled}
                onScopeChange={onScopeChange}
                onPicked={onDone}
              />
            </div>
          ))}

        {showImage && (
          <div role="none">
            <div
              role="menuitem"
              tabIndex={-1}
              aria-haspopup="true"
              aria-expanded={imageOpen}
              className={`${ROW} cursor-pointer`}
              onClick={() => setImageOpen(!imageOpen)}
              onKeyDown={onActivateKey(() => setImageOpen(!imageOpen))}
            >
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                <Icon name="photograph" size="sm" aria-hidden="true" className="text-gray-500" />
                <span className="truncate">{imageLabel}</span>
              </span>
              <Icon
                name={imageOpen ? 'chevronDown' : 'chevronRight'}
                size="sm"
                aria-hidden="true"
                className="shrink-0 text-gray-400"
              />
            </div>
            {imageOpen && <div className="px-2 pb-2">{imageGeneration}</div>}
          </div>
        )}

        {nothing && !loading && (
          <p className="px-2 py-1 text-sm text-gray-500 dark:text-gray-400">
            {query
              ? t('integrationPicker.noMatch', 'No integrations match.')
              : t('integrationPicker.none', 'This app uses no integrations.')}
          </p>
        )}
      </div>

      <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700" role="none">
        {onSaveDefault && toggleable && (
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={saveDefault}
            onKeyDown={onActivateKey(saveDefault)}
            disabled={defaultState === 'saving'}
            className={`${ROW} text-sm text-gray-700 dark:text-gray-200`}
          >
            <span>{t('integrationPicker.saveDefault', 'Use as default for new chats')}</span>
            <span aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400">
              {defaultState === 'saved' && t('integrationPicker.defaultSaved', 'Saved')}
              {defaultState === 'failed' && t('integrationPicker.defaultFailed', 'Not saved')}
            </span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={openManage}
          onKeyDown={onActivateKey(openManage)}
          className={`${ROW} text-sm text-gray-700 dark:text-gray-200`}
        >
          <span>{t('integrationPicker.manage', 'Manage integrations…')}</span>
          <Icon name="external-link" size="sm" aria-hidden="true" className="text-gray-400" />
        </button>
      </div>
    </div>
  );
}
