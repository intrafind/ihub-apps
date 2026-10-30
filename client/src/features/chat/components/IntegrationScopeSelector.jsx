// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useKeyboardNavigation } from '../../../shared/hooks/useKeyboardNavigation';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  currentScopeOf,
  scopeActionLabel,
  scopeDisplayName,
  scopeHint
} from '../utils/integrationScopes';

/**
 * Inline scope picker in the chat input (`integrations.<id>.scopePicker:
 * "inline"`, #3050): "Search in: [Contracts ▾]". Same pattern as the model
 * selector — a button with a menu of radio items, a bottom sheet on phones.
 * A fixed scope is shown, not offered.
 */
function IntegrationScopeSelector({ integration, onScopeChange, language, disabled = false }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const menuRef = useRef(null);
  const scopes = useMemo(() => integration?.scopes || [], [integration?.scopes]);

  const handleClose = useCallback(() => setIsOpen(false), []);
  const handleSelect = useCallback(
    index => {
      const scope = scopes[index];
      if (scope) {
        onScopeChange(integration.id, scope.id);
        setIsOpen(false);
      }
    },
    [scopes, integration?.id, onScopeChange]
  );

  const { activeIndex } = useKeyboardNavigation(menuRef, {
    isActive: isOpen,
    onClose: handleClose,
    onSelect: handleSelect
  });

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  if (!integration || scopes.length === 0) return null;

  const action = scopeActionLabel(integration, t);
  const currentName = scopeDisplayName(currentScopeOf(integration), language);
  const integrationName = scopeDisplayName(integration, language);
  const label = `${integrationName}: ${action} ${currentName}`;
  const hint = scopeHint(integration, t);
  const canPick = !integration.fixed && scopes.length > 1;

  if (!canPick) {
    return (
      <span
        className="flex min-w-0 items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-2.5 text-sm text-gray-700 dark:bg-gray-700 dark:text-gray-300"
        title={integration.fixed ? t('integrationScopes.fixed', 'Set by the app') : hint || label}
      >
        <Icon name={integration.fixed ? 'lock-closed' : 'search'} size="sm" aria-hidden="true" />
        <span className="hidden sm:inline text-gray-500 dark:text-gray-400">{action}</span>
        <span className="min-w-0 max-w-[150px] truncate font-medium">{currentName}</span>
        <span className="sr-only">
          {label}
          {integration.fixed ? ` (${t('integrationScopes.fixed', 'Set by the app')})` : ''}
        </span>
      </span>
    );
  }

  return (
    <div className="relative min-w-0" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(open => !open)}
        disabled={disabled}
        className={`flex max-w-full items-center gap-1.5 rounded-lg px-3 py-2.5 text-sm transition-colors ${
          disabled
            ? 'cursor-not-allowed bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
        }`}
        title={hint ? `${label} — ${hint}` : label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <Icon name="search" size="sm" className="shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline text-gray-500 dark:text-gray-400">{action}</span>
        <span className="min-w-0 max-w-[150px] truncate font-medium">{currentName}</span>
        <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size="sm" className="shrink-0" />
      </button>

      {isOpen && !disabled && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 sm:hidden"
            onClick={handleClose}
            aria-hidden="true"
          />
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            aria-label={`${integrationName}: ${action}`}
            className="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800 sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-2 sm:max-h-96 sm:w-72 sm:rounded-t-lg sm:rounded-b-lg sm:border-x sm:border-b"
          >
            <div className="p-2 pb-3 sm:pb-2">
              <div className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400">
                {integrationName}: {action}
              </div>
              {scopes.map((scope, index) => {
                const isSelected = scope.id === integration.current;
                const name = scopeDisplayName(scope, language);
                return (
                  <button
                    key={scope.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    tabIndex={index === activeIndex ? 0 : -1}
                    onClick={() => handleSelect(index)}
                    className={`w-full rounded-lg px-3 py-2 text-left transition-colors focus:outline-hidden focus:ring-2 focus:ring-inset focus:ring-indigo-500 ${
                      isSelected
                        ? 'bg-indigo-50 dark:bg-indigo-900/20'
                        : 'hover:bg-gray-50 focus:bg-gray-50 dark:hover:bg-gray-700 dark:focus:bg-gray-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div
                          className={`truncate text-sm font-medium ${
                            isSelected
                              ? 'text-indigo-600 dark:text-indigo-400'
                              : 'text-gray-900 dark:text-gray-100'
                          }`}
                        >
                          {name}
                        </div>
                        {scope.description && (
                          <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                            {getLocalizedContent(scope.description, language)}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <Icon
                          name="check"
                          size="sm"
                          className="shrink-0 text-indigo-600 dark:text-indigo-400"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  </button>
                );
              })}
              {hint && <p className="px-3 pt-2 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default IntegrationScopeSelector;
