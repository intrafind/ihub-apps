// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

/** Human-readable size, e.g. "148.2 MB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A problem or warning from the server's verification, translated by its code
 * with the server's English message as the fallback.
 */
function IssueText({ issue }) {
  const { t } = useTranslation();
  const params = issue.params || {};
  const key = params.variant ? `${issue.code}_${params.variant}` : issue.code;
  return t(`admin.updates.issues.${key}`, issue.message, params);
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 py-1.5">
      <dt className="sm:w-44 shrink-0 text-sm font-medium text-gray-600 dark:text-gray-400">
        {label}
      </dt>
      <dd className="text-sm text-gray-900 dark:text-gray-100 break-all">{children}</dd>
    </div>
  );
}

function Badge({ tone, children }) {
  const tones = {
    good: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
    warn: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200',
    bad: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
    neutral: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * What the server found when it verified a release archive, and — for an
 * accepted one — the confirmation and the "Install and restart" button.
 *
 * @param {Object} props
 * @param {Object} props.summary - The staging summary from the server
 * @param {boolean} props.busy
 * @param {(options: { confirmDowngrade: boolean, confirmUnsigned?: string }) => void} props.onApply
 * @param {() => void} props.onDiscard - Discard the staged release (accepted) or dismiss (rejected)
 */
function StagedUpdatePanel({ summary, busy, onApply, onDiscard }) {
  const { t } = useTranslation();
  const baseId = useId();
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);
  const [typedVersion, setTypedVersion] = useState('');

  const accepted = summary.accepted;
  const needsDowngrade = accepted && summary.requiresConfirmation?.downgrade;
  const needsUnsigned = accepted && summary.requiresConfirmation?.unsigned;
  const canApply =
    accepted &&
    !busy &&
    (!needsDowngrade || confirmDowngrade) &&
    (!needsUnsigned || typedVersion.trim() === String(summary.version));

  const signature = summary.signature || {};
  const signatureBadge =
    signature.status === 'valid' ? (
      <Badge tone="good">
        {signature.via === 'checksums'
          ? t('admin.updates.signatureValidChecksums', 'Signed (checksums.sha256)')
          : t('admin.updates.signatureValid', 'Signed')}
        {signature.keyId ? ` · ${signature.keyId}` : ''}
      </Badge>
    ) : signature.status === 'invalid' ? (
      <Badge tone="bad">{t('admin.updates.signatureInvalid', 'Signature does not match')}</Badge>
    ) : signature.status === 'unknown-key' ? (
      <Badge tone="warn">
        {t('admin.updates.signatureUnknownKey', 'Signed with an unknown key')}
      </Badge>
    ) : (
      <Badge tone="warn">{t('admin.updates.signatureMissing', 'Not signed')}</Badge>
    );

  const checksumBadge = {
    match: <Badge tone="good">{t('admin.updates.checksumMatch', 'Matches')}</Badge>,
    mismatch: <Badge tone="bad">{t('admin.updates.checksumMismatch', 'Does not match')}</Badge>,
    'not-listed': (
      <Badge tone="warn">{t('admin.updates.checksumNotListed', 'Not listed in the file')}</Badge>
    ),
    missing: <Badge tone="neutral">{t('admin.updates.checksumMissing', 'Not provided')}</Badge>
  }[summary.checksum];

  const comparisonLabel = {
    upgrade: t('admin.updates.comparisonUpgrade', 'Upgrade'),
    same: t('admin.updates.comparisonSame', 'Same version'),
    downgrade: t('admin.updates.comparisonDowngrade', 'Downgrade'),
    unknown: t('admin.updates.comparisonUnknown', 'Unknown')
  }[summary.comparison];

  return (
    <section
      aria-labelledby={`${baseId}-title`}
      className={`rounded-lg border p-6 shadow-xs ${
        accepted
          ? 'bg-white dark:bg-gray-800 border-blue-200 dark:border-blue-800'
          : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
      }`}
    >
      <h3
        id={`${baseId}-title`}
        className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100"
      >
        <Icon
          name={accepted ? 'shield-check' : 'exclamation-triangle'}
          size="md"
          className={
            accepted ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'
          }
        />
        {accepted
          ? t('admin.updates.stagedTitle', 'Ready to install: version {{version}}', {
              version: summary.version
            })
          : t('admin.updates.rejectedTitle', 'This archive cannot be installed')}
      </h3>

      {summary.problems?.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-red-700 dark:text-red-300">
          {summary.problems.map(problem => (
            <li key={problem.code} className="flex gap-2">
              <Icon name="x-circle" size="sm" className="mt-0.5 shrink-0" />
              <span>
                <IssueText issue={problem} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-4 divide-y divide-gray-100 dark:divide-gray-700">
        <Row label={t('admin.updates.fieldFile', 'File')}>
          {summary.fileName}
          {summary.archiveSize ? ` (${formatBytes(summary.archiveSize)})` : ''}
        </Row>
        <Row label={t('admin.updates.fieldVersion', 'Version')}>
          {summary.version || '–'}{' '}
          <span className="text-gray-500 dark:text-gray-400">
            ({comparisonLabel},{' '}
            {t('admin.updates.runningVersion', 'running {{version}}', {
              version: summary.currentVersion
            })}
            )
          </span>
        </Row>
        <Row label={t('admin.updates.fieldPlatform', 'Platform')}>
          {summary.platform}
          {summary.arch ? ` / ${summary.arch}` : ''}
        </Row>
        <Row label={t('admin.updates.fieldSignature', 'Signature')}>{signatureBadge}</Row>
        <Row label={t('admin.updates.fieldChecksum', 'Published checksum')}>{checksumBadge}</Row>
        <Row label={t('admin.updates.fieldSha256', 'SHA-256')}>
          <code className="text-xs">{summary.archiveSha256}</code>
        </Row>
        {summary.nodeVersion && (
          <Row label={t('admin.updates.fieldNode', 'Bundled Node.js')}>{summary.nodeVersion}</Row>
        )}
        {accepted && (
          <Row label={t('admin.updates.fieldApplyMode', 'Applied by')}>
            {summary.applyMode === 'swap-on-start'
              ? t('admin.updates.applyModeLauncher', 'the launcher, before the server starts again')
              : t('admin.updates.applyModeInProcess', 'the running server (older launcher)')}
          </Row>
        )}
      </dl>

      {summary.warnings?.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-yellow-800 dark:text-yellow-200">
          {summary.warnings.map(warning => (
            <li key={warning.code} className="flex gap-2">
              <Icon name="warning" size="sm" className="mt-0.5 shrink-0" />
              <span>
                <IssueText issue={warning} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {accepted && (
        <div className="mt-5 space-y-3">
          {needsDowngrade && (
            <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-gray-300"
                checked={confirmDowngrade}
                onChange={event => setConfirmDowngrade(event.target.checked)}
              />
              <span>
                {t(
                  'admin.updates.confirmDowngrade',
                  'I want to install {{version}} although it is not newer than the running {{current}}.',
                  { version: summary.version, current: summary.currentVersion }
                )}
              </span>
            </label>
          )}
          {needsUnsigned && (
            <div>
              <label
                htmlFor={`${baseId}-unsigned`}
                className="block text-sm font-medium text-red-700 dark:text-red-300"
              >
                {t(
                  'admin.updates.confirmUnsigned',
                  'This archive is not signed by a trusted key, so its origin cannot be verified. Type {{version}} to install it anyway.',
                  { version: summary.version }
                )}
              </label>
              <input
                id={`${baseId}-unsigned`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={typedVersion}
                onChange={event => setTypedVersion(event.target.value)}
                className="mt-1 block w-48 rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs text-sm"
              />
            </div>
          )}
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.updates.applyNotice',
              'The server restarts. The current version and a snapshot of the configuration are kept, and you can roll back afterwards.'
            )}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {accepted && (
          <button
            type="button"
            onClick={() =>
              onApply({
                confirmDowngrade,
                confirmUnsigned: needsUnsigned ? typedVersion.trim() : undefined
              })
            }
            disabled={!canApply}
            className="inline-flex items-center px-4 py-2 rounded-md text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Icon name="arrow-path" size="sm" className="mr-1.5" />
            {t('admin.updates.installAndRestart', 'Install and restart')}
          </button>
        )}
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy}
          className="inline-flex items-center px-4 py-2 rounded-md text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          {accepted ? t('admin.updates.discard', 'Discard') : t('common.close', 'Close')}
        </button>
      </div>
    </section>
  );
}

export default StagedUpdatePanel;
