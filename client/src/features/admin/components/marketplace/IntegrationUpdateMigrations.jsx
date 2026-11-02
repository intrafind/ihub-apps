// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  MigrationProblemList,
  MigrationWarningList,
  formatChanges
} from '../integrations/MigrationParts';
import {
  installationLabelOf,
  previewNotPlanned,
  previewRowKind,
  resultReasonOf
} from './integrationUpdateMigrations';

const LINK_CLASS =
  'underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500';

/** The page of an installation, for the "act on it" links. */
function installationLink(id) {
  return `/admin/integrations/${encodeURIComponent(id)}`;
}

/**
 * The sentence of one installation of the preview.
 *
 * @param {Object} row - a `migrationPreview.installations` entry
 * @param {string} kind - from `previewRowKind`
 * @param {string} label
 * @param {string|null} changes - from `formatChanges`
 * @param {Function} t
 * @returns {string}
 */
function previewSentence(row, kind, label, changes, t) {
  switch (kind) {
    case 'changes':
      return t(
        'admin.marketplace.migration.preview.changes',
        'This update changes {{changes}} of {{label}}; a backup is made first.',
        { changes, label }
      );
    case 'noChanges':
      return t(
        'admin.marketplace.migration.preview.noChanges',
        'This update’s migrations change nothing {{label}} stores; a backup is made first.',
        { label }
      );
    case 'fails':
      return t(
        'admin.marketplace.migration.preview.fails',
        'The migration of {{label}} will fail. The update still goes in, but {{label}} stays on v{{from}} and offers no actions until you act on its page: re-run the migration, restore the backup or uninstall it.',
        { label, from: row.from }
      );
    case 'notPlanned':
      return t(
        'admin.marketplace.migration.preview.notPlanned',
        'The migration of {{label}} (v{{from}}) is planned when the update is downloaded: the catalog does not list every release since that version.',
        { label, from: row.from }
      );
    case 'review':
      return t(
        'admin.marketplace.migration.preview.review',
        '{{label}} needs a review (it records no valid version), so the update does not migrate it.',
        { label }
      );
    default:
      return t(
        'admin.marketplace.migration.preview.current',
        '{{label}} is already at v{{from}}.',
        {
          label,
          from: row.from
        }
      );
  }
}

/**
 * What updating an integration does to each installation of its
 * definition, from the item detail's `migrationPreview` (planned from the
 * catalog's releases and migrations, nothing written): the changes per
 * installation, the warnings, and the installations whose migration will
 * fail (the update still goes in; they stay on their version, marked
 * `migrationFailed`, until the admin acts). An installation the catalog
 * cannot plan is planned when the update is downloaded.
 *
 * @param {Object} props
 * @param {Object|null} props.preview - `migrationPreview`, null when nothing is installed
 */
export function IntegrationUpdatePreview({ preview }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language?.split('-')[0] || 'en';
  if (!preview) return null;
  const rows = preview.installations || [];
  const wholeNotPlanned = previewNotPlanned(preview);
  if (rows.length === 0 && !wholeNotPlanned) return null;
  return (
    <section
      className="mb-3 p-3 bg-white dark:bg-gray-800 rounded-md text-sm text-gray-800 dark:text-gray-200 space-y-3"
      aria-labelledby="update-migration-preview-title"
      data-testid="update-migration-preview"
    >
      <h3
        id="update-migration-preview-title"
        className="text-sm font-semibold text-gray-900 dark:text-gray-100"
      >
        {t('admin.marketplace.migration.preview.title', 'Installations')}
      </h3>
      {wholeNotPlanned && (
        <div data-testid="update-migration-not-planned">
          <p>
            {t(
              'admin.marketplace.migration.preview.wholeNotPlanned',
              'The migrations cannot be planned from the catalog; they are planned when the update is downloaded, and an installation whose migration fails stays on its version until you act.'
            )}
          </p>
          <MigrationProblemList problems={preview.errors} testId="update-migration-errors" />
        </div>
      )}
      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map(row => {
            const kind = previewRowKind(row);
            const label = installationLabelOf(row, lang);
            const changes = formatChanges(row.summary, t, lang);
            return (
              <li key={row.id} data-testid="update-migration-row" data-kind={kind}>
                <p
                  className={
                    kind === 'fails' ? 'text-red-800 dark:text-red-200 font-medium' : undefined
                  }
                >
                  {previewSentence(row, kind, label, changes, t)}
                </p>
                {kind === 'fails' && (
                  <MigrationProblemList
                    problems={row.collisions}
                    testId="update-migration-collisions"
                  />
                )}
                <div className="mt-1">
                  <MigrationWarningList
                    warnings={row.warnings}
                    testId="update-migration-warnings"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The sentence of one installation's result after the update.
 *
 * @param {Object} row - an `integrationMigrations` entry
 * @param {string} label
 * @param {Function} t
 * @returns {string}
 */
function resultSentence(row, label, t) {
  switch (row.result) {
    case 'migrated':
      return t(
        'admin.marketplace.migration.report.migrated',
        '{{label}} was migrated from v{{from}} to v{{to}}.',
        { label, from: row.from, to: row.to }
      );
    case 'stamped':
      return t(
        'admin.marketplace.migration.report.stamped',
        '{{label}} now records v{{to}}; nothing it stores had to change.',
        { label, to: row.to }
      );
    case 'failed':
      return t(
        'admin.marketplace.migration.report.failed',
        'The migration of {{label}} failed: it stays on v{{from}} and offers no actions until you act on its page. Reason: {{reason}}',
        { label, from: row.from, reason: resultReasonOf(row) }
      );
    default:
      return t(
        'admin.marketplace.migration.report.skipped',
        '{{label}} was not migrated: {{reason}}',
        { label, reason: resultReasonOf(row) }
      );
  }
}

/**
 * What the update did to each installation (`integrationMigrations` of
 * `POST …/_update`): migrated, recorded, failed with the reason, or skipped,
 * each with a link to the installation's page.
 *
 * @param {Object} props
 * @param {Array<Object>} props.results - `integrationMigrations`
 * @param {Map<string, string>} [props.labels] - installation labels by id (`previewLabels`)
 * @param {() => void} props.onDismiss
 */
export function IntegrationUpdateReport({ results, labels = new Map(), onDismiss }) {
  const { t } = useTranslation();
  if (!Array.isArray(results) || results.length === 0) return null;
  const failed = results.some(row => row.result === 'failed');
  const Frame = failed ? 'div' : 'output';
  return (
    <Frame
      className={`block mx-6 my-3 p-4 rounded-lg border text-sm ${
        failed
          ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100'
          : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-900 dark:text-green-100'
      }`}
      role={failed ? 'alert' : undefined}
      data-testid="update-migration-report"
    >
      <p className="font-medium mb-2">
        {t('admin.marketplace.migration.report.title', 'Migrations of the installations')}
      </p>
      <ul className="space-y-2">
        {results.map(row => {
          const label = labels.get(row.id) || row.id;
          return (
            <li key={row.id} data-testid="update-migration-result" data-result={row.result}>
              <p className="break-words">{resultSentence(row, label, t)}</p>
              <MigrationWarningList
                warnings={row.warnings}
                testId="update-migration-result-warnings"
              />
              <Link to={installationLink(row.id)} className={LINK_CLASS}>
                {t('admin.integrations.migration.outcome.open', 'Open {{label}}', { label })}
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 rounded-sm text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {t('admin.integrations.migration.outcome.dismiss', 'Dismiss')}
      </button>
    </Frame>
  );
}
