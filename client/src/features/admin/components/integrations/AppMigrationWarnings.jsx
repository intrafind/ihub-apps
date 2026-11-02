// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { APP_WARNING_CODES } from './appMigrationWarningRules';

/**
 * One app migration warning as a sentence from the app's point of view.
 *
 * @param {Object} warning - from `appMigrationWarnings`
 * @param {Function} t
 * @returns {string}
 */
export function appMigrationWarningText(warning, t) {
  const params = {
    installation: warning.installationLabel,
    version: warning.to || '?',
    action: warning.action,
    scope: warning.scope,
    key: warning.key
  };
  if (warning.code === APP_WARNING_CODES.ACTION_REMOVED_FROM_APP) {
    return t(
      'admin.apps.migrationWarnings.actionRemoved',
      'The update of {{installation}} to v{{version}} removed the action “{{action}}”, which this app was bound to; the app no longer offers it.',
      params
    );
  }
  if (warning.scope) {
    return t(
      'admin.apps.migrationWarnings.typeBindingScope',
      'The update of {{installation}} to v{{version}} renamed the scope “{{scope}}”, which this app still sets in its binding {{key}}: edit the binding.',
      params
    );
  }
  return t(
    'admin.apps.migrationWarnings.typeBindingAction',
    'The update of {{installation}} to v{{version}} renamed or removed the action “{{action}}”, which this app still names in its binding {{key}}: edit the binding.',
    params
  );
}

/**
 * The warnings a definition migration left for an app (`appMigrationWarnings`),
 * as text: in the Admin → Apps list (compact) and next to the binding in the
 * app editor's Integrations section, with a link to the installation's page
 * where the migration log has the details.
 *
 * @param {Object} props
 * @param {Array<Object>} props.warnings
 * @param {boolean} [props.compact=false] - the list's short form, without links
 * @param {string} [props.className]
 */
function AppMigrationWarnings({ warnings, compact = false, className = '' }) {
  const { t } = useTranslation();
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  return (
    <ul
      className={`space-y-1 text-xs text-amber-800 dark:text-amber-300 ${className}`}
      data-testid="app-migration-warnings"
    >
      {warnings.map(warning => (
        <li
          key={`${warning.instanceId}|${warning.code}|${warning.key}|${warning.action}|${warning.scope}`}
          className="border-l-2 border-amber-500 pl-2"
        >
          <span>
            {appMigrationWarningText(warning, t)}
            {!compact && (
              <>
                {' '}
                <Link
                  to={`/admin/integrations/${encodeURIComponent(warning.instanceId)}`}
                  className="underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {t('admin.apps.migrationWarnings.openLog', 'Migration log of {{installation}}', {
                    installation: warning.installationLabel
                  })}
                </Link>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default AppMigrationWarnings;
