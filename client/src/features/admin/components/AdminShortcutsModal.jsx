// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import useFocusTrap from '../../../shared/hooks/useFocusTrap';
import Icon from '../../../shared/components/Icon';

const SHORTCUTS = [
  {
    categoryKey: 'admin.shortcuts.navigation',
    category: 'Navigation',
    items: [
      { keys: ['g', 'a'], labelKey: 'admin.shortcuts.goApps', label: 'Go to Apps' },
      { keys: ['g', 'm'], labelKey: 'admin.shortcuts.goModels', label: 'Go to Models' },
      { keys: ['g', 'p'], labelKey: 'admin.shortcuts.goPrompts', label: 'Go to Prompts' },
      { keys: ['g', 'u'], labelKey: 'admin.shortcuts.goUsers', label: 'Go to Users' },
      { keys: ['g', 'g'], labelKey: 'admin.shortcuts.goGroups', label: 'Go to Groups' },
      { keys: ['g', 'j'], labelKey: 'admin.shortcuts.goProjects', label: 'Go to Projects' },
      { keys: ['g', 'l'], labelKey: 'admin.shortcuts.goAuditLog', label: 'Go to Audit Log' }
    ]
  },
  {
    categoryKey: 'admin.shortcuts.actions',
    category: 'Actions',
    items: [
      { keys: ['⌘', 'k'], labelKey: 'admin.shortcuts.openPalette', label: 'Open command palette' },
      { keys: ['⌘', 's'], labelKey: 'admin.shortcuts.save', label: 'Save (in the app editor)' },
      {
        keys: ['?'],
        labelKey: 'admin.shortcuts.toggleCheatsheet',
        label: 'Toggle this cheatsheet'
      },
      { keys: ['Esc'], labelKey: 'admin.shortcuts.closeDialogs', label: 'Close dialogs / palette' }
    ]
  }
];

/**
 * Keyboard shortcut cheatsheet modal.
 * Opened by pressing `?` anywhere in the admin UI.
 */
function AdminShortcutsModal({ isOpen, onClose }) {
  const { t } = useTranslation();
  const containerRef = useRef(null);

  useFocusTrap(containerRef, { isActive: isOpen, returnFocusOnDeactivate: true });

  useEffect(() => {
    if (!isOpen) return undefined;
    const handler = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div
        className="fixed inset-0 bg-black/50 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label={t('admin.shortcuts.title', 'Keyboard Shortcuts')}
          className="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-sm w-full border border-gray-200 dark:border-gray-700"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.shortcuts.title', 'Keyboard Shortcuts')}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              aria-label={t('common.close', 'Close')}
            >
              <Icon name="x-mark" className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-4 space-y-5">
            {SHORTCUTS.map(({ category, categoryKey, items }) => (
              <div key={category}>
                <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                  {t(categoryKey, category)}
                </div>
                <div className="space-y-1.5">
                  {items.map(({ keys, label, labelKey }) => (
                    <div key={label} className="flex items-center justify-between gap-4">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        {t(labelKey, label)}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        {keys.map((k, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {i > 0 && (
                              <span className="text-xs text-gray-500">
                                {t('admin.shortcuts.then', 'then')}
                              </span>
                            )}
                            <kbd className="inline-flex items-center px-1.5 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-sm border border-gray-200 dark:border-gray-600">
                              {k}
                            </kbd>
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 text-center">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('admin.shortcuts.hint', 'Shortcuts are disabled when typing in inputs')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminShortcutsModal;
