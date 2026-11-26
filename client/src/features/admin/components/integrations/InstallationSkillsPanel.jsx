// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import LoadingSpinner from '../../../../shared/components/LoadingSpinner';
import {
  approveInstallationSkill,
  fetchInstallationSkills,
  revokeInstallationSkill
} from '../../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';

const BUTTON_CLASS =
  'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-800';
const PRIMARY = `${BUTTON_CLASS} bg-blue-700 text-white hover:bg-blue-800`;
const SECONDARY = `${BUTTON_CLASS} border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700`;

/** The badge of a skill's status. */
function StatusBadge({ status }) {
  const { t } = useTranslation();
  const badges = {
    approved: ['success', t('admin.integrations.skills.status.approved', 'Approved')],
    changed: ['warning', t('admin.integrations.skills.status.changed', 'Changed on the server')],
    missing: ['warning', t('admin.integrations.skills.status.missing', 'No longer offered')],
    not_approvable: [
      'neutral',
      t('admin.integrations.skills.status.notApprovable', 'Cannot be approved')
    ],
    available: ['info', t('admin.integrations.skills.status.available', 'Not approved')]
  };
  const [tone, label] = badges[status] || badges.available;
  return <Badge tone={tone}>{label}</Badge>;
}

/** Why a skill cannot be approved, in words. */
function reasonText(t, reason) {
  switch (reason) {
    case 'duplicate_name':
      return t(
        'admin.integrations.skills.reason.duplicateName',
        'The server offers more than one skill by this name.'
      );
    case 'dynamic':
      return t(
        'admin.integrations.skills.reason.dynamic',
        'The server does not list this skill’s files, so they cannot be checked.'
      );
    default:
      return t(
        'admin.integrations.skills.reason.invalidName',
        'The skill’s name does not follow the skill naming rules.'
      );
  }
}

/** A size in bytes, readable. */
function sizeText(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The skills an MCP server offers (MCP Skills extension) and their approval.
 * A skill reaches chats only once approved here, and only while the server
 * serves exactly what was approved.
 *
 * @param {Object} props
 * @param {string} props.instanceId
 */
export default function InstallationSkillsPanel({ instanceId }) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchInstallationSkills(instanceId);
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      setItems(null);
      setError(err);
    }
  }, [instanceId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (name, action) => {
    setBusy(name);
    setActionError(null);
    try {
      if (action === 'approve') await approveInstallationSkill(instanceId, name);
      else await revokeInstallationSkill(instanceId, name);
      await load();
    } catch (err) {
      setActionError({ name, message: getAdminApiErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const intro = (
    <p className="text-sm text-gray-600 dark:text-gray-400">
      {t(
        'admin.integrations.skills.intro',
        'Skills are instructions the server ships for using its tools well. A skill reaches chats only after you approve it here, in apps that turn skills on and use this integration. If the server changes an approved skill, it stops loading until you approve it again.'
      )}
    </p>
  );

  if (error) {
    const code = error?.response?.data?.code;
    let message = getAdminApiErrorMessage(error);
    if (code === 'SKILLS_NOT_SUPPORTED') {
      message = t('admin.integrations.skills.unsupported', 'This server offers no skills.');
    } else if (code === 'INTEGRATION_AUTH_REQUIRED') {
      message = t(
        'admin.integrations.skills.connectFirst',
        'Each user signs in to this server. Connect your own account to see the skills it offers.'
      );
    }
    return (
      <div className="space-y-3">
        {intro}
        <p role="alert" className="text-sm text-gray-800 dark:text-gray-200">
          {message}
        </p>
      </div>
    );
  }
  if (items === null) return <LoadingSpinner />;

  return (
    <div className="space-y-4">
      {intro}
      {items.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('admin.integrations.skills.none', 'The server lists no skills.')}
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700" data-testid="server-skills">
          {items.map(item => {
            const approvable = item.status !== 'not_approvable' && item.status !== 'missing';
            const approved = Boolean(item.approvedAt);
            return (
              <li key={item.uri} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-start">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {item.name}
                    </span>
                    <StatusBadge status={item.status} />
                  </div>
                  {item.description && (
                    <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                      {item.description}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                    {Array.isArray(item.files) &&
                      t('admin.integrations.skills.files', '{{count}} files, {{size}}', {
                        count: item.files.length,
                        size: sizeText(item.size)
                      })}
                    {approved &&
                      ` · ${t('admin.integrations.skills.approvedAt', 'Approved {{date}}', {
                        date: new Date(item.approvedAt).toLocaleDateString(i18n.language)
                      })}`}
                  </p>
                  {item.status === 'not_approvable' && (
                    <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                      {reasonText(t, item.reason)}
                    </p>
                  )}
                  {actionError?.name === item.name && (
                    <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
                      {actionError.message}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {approvable && item.status !== 'approved' && (
                    <button
                      type="button"
                      className={PRIMARY}
                      disabled={busy !== null}
                      onClick={() => act(item.name, 'approve')}
                    >
                      {item.status === 'changed'
                        ? t('admin.integrations.skills.approveAgain', 'Approve again')
                        : t('admin.integrations.skills.approve', 'Approve')}
                    </button>
                  )}
                  {approved && (
                    <button
                      type="button"
                      className={SECONDARY}
                      disabled={busy !== null}
                      onClick={() => act(item.name, 'revoke')}
                    >
                      {t('admin.integrations.skills.revoke', 'Withdraw approval')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
