// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS } from '../formStyles';

/**
 * ExportConfigSection - Conversation export toggle card for the App form.
 * Extracted from AppFormEditor.jsx (see #1781) as a self-contained slice:
 * only ever reads/writes `app.features.export` via the passed-in onChange.
 */
function ExportConfigSection({ app, onChange }) {
  const { t } = useTranslation();

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.export', 'Export')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.exportDesc',
              'Control whether users can export conversations from this app'
            )}
          </p>
        </div>
        <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                id="app-enable-export"
                type="checkbox"
                checked={app.features?.export !== false}
                onChange={e =>
                  onChange({
                    ...app,
                    features: { ...app.features, export: e.target.checked }
                  })
                }
                className={CHECKBOX_CLASS}
              />
              <label
                htmlFor="app-enable-export"
                className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
              >
                {t('admin.apps.edit.enableExport', 'Enable Export')}
              </label>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.apps.edit.exportNote',
                'When disabled, users cannot export conversations in any format (JSON, Markdown, PDF, etc.). The platform-level export setting must also be enabled for export to work.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ExportConfigSection;
