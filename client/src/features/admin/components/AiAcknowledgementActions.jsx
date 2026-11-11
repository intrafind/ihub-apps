// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Badge from '../../../shared/components/Badge';
import Icon from '../../../shared/components/Icon';
import MoreActionsMenu from './MoreActionsMenu';
import { latestAcknowledgement } from '../hooks/useAiAcknowledgementAdmin';

/**
 * The bulk actions on AI-use acknowledgements as one menu, plus the
 * confirmation dialog they open. Pass the object `useAiAcknowledgementAdmin`
 * returned; the users page and the EU AI Act overview page share it.
 *
 * Renders nothing while the feature is off.
 *
 * @param {Object} props
 * @param {ReturnType<import('../hooks/useAiAcknowledgementAdmin').useAiAcknowledgementAdmin>} props.admin
 * @param {number} props.confirmedCount - Entries that "Remove all" would delete
 * @param {'acknowledged'|'pending'} [props.exportStatus] - Filter of the CSV
 */
export function AiAcknowledgementActions({ admin, confirmedCount, exportStatus }) {
  const { t } = useTranslation();
  const { settings, dialogProps } = admin;
  return (
    <>
      {settings?.enabled && (
        <MoreActionsMenu
          label={t('admin.users.aiAcknowledgement.menu', 'AI acknowledgements')}
          items={[
            {
              id: 'export',
              label: t('admin.users.aiAcknowledgement.export', 'Export CSV'),
              disabled: admin.busy,
              onSelect: () => admin.exportCsv(exportStatus)
            },
            {
              id: 'requestAgain',
              label: t('admin.users.aiAcknowledgement.requestAgain', 'Request again'),
              disabled: admin.busy || !settings.masterOn,
              onSelect: admin.askRequestAgain
            },
            {
              id: 'removeAll',
              label: t('admin.users.aiAcknowledgement.removeAll', 'Remove all'),
              destructive: true,
              // Acknowledgements stay while the EU AI Act features are off; the export does not.
              disabled: admin.busy || !settings.masterOn,
              onSelect: () => admin.askRemoveAll(confirmedCount)
            }
          ]}
        />
      )}
      <ConfirmDialog
        isOpen={!!dialogProps}
        title={dialogProps?.title ?? ''}
        message={dialogProps?.message ?? ''}
        confirmLabel={dialogProps?.confirmLabel}
        danger={dialogProps?.danger}
        onConfirm={() => dialogProps?.onConfirm()}
        onDeny={admin.closeDialog}
      />
    </>
  );
}

/**
 * Status cell of the users table: text plus icon, never colour alone.
 *
 * @param {Object} props
 * @param {Object} props.user - users.json record
 * @param {'acknowledged'|'outdated'|'never'} props.status
 * @param {number} props.requiredVersion
 */
export function AiAcknowledgementCell({ user, status, requiredVersion }) {
  const { t } = useTranslation();
  const entry = latestAcknowledgement(user);
  if (status === 'acknowledged') {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <Badge tone="success" icon={<Icon name="check-circle" size="sm" />} size="sm">
          {t('admin.users.aiAcknowledgement.statusAcknowledged', 'Acknowledged v{{version}}', {
            version: entry?.version
          })}
        </Badge>
        {entry?.acknowledgedAt && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {new Date(entry.acknowledgedAt).toLocaleDateString()}
          </span>
        )}
      </div>
    );
  }
  if (status === 'outdated') {
    return (
      <Badge tone="warning" icon={<Icon name="exclamation-triangle" size="sm" />} size="sm">
        {t(
          'admin.users.aiAcknowledgement.statusOutdated',
          'Outdated (v{{version}}, v{{required}} required)',
          {
            version: entry?.version,
            required: requiredVersion
          }
        )}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" variant="outline" icon={<Icon name="minus-circle" size="sm" />} size="sm">
      {t('admin.users.aiAcknowledgement.statusNever', 'Not acknowledged')}
    </Badge>
  );
}

export default AiAcknowledgementActions;
