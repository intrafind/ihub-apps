// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import IntegrationTestResults from '../IntegrationTestResults';
import AdminLoadError from '../AdminLoadError';
import CertificateChain from './CertificateChain';
import PersonResultsTable from './PersonResultsTable';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS, PRIMARY_BUTTON_CLASS } from './formStyles';
import { testPeopleDirectory } from '../../../../api/peopleDirectoriesAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';

/**
 * The test panel of the directory editor. It sends the form as it stands —
 * saved or not — to `POST /admin/people-directories/test`, with an optional
 * name for a sample search, and shows each step (resolve, network check,
 * connect, StartTLS, bind, search, mapping), the certificate chain when
 * verification failed, and the mapped people.
 *
 * It sits outside the editor's `<form>`, so Enter in the name field runs the
 * test and never saves.
 *
 * @param {Object} props
 * @param {() => Object} props.buildDirectory - The directory as the form holds it now
 * @param {string[]} props.fields - Mapped person fields, in display order
 */
function DirectoryTestPanel({ buildDirectory, fields }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const run = async event => {
    event?.preventDefault();
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      setResult(await testPeopleDirectory({ directory: buildDirectory() }, query));
    } catch (err) {
      const details = err?.response?.data?.details;
      const detailText = Array.isArray(details)
        ? details
            .map(issue =>
              Array.isArray(issue?.path) && issue.path.length > 0
                ? `${issue.path.join('.')}: ${issue.message}`
                : issue?.message
            )
            .filter(Boolean)
            .join('; ')
        : '';
      const message = getAdminApiErrorMessage(err);
      setError(detailText ? `${message} (${detailText})` : message);
    } finally {
      setRunning(false);
    }
  };

  // Step labels come from the server in English; known steps are shown in the
  // UI language instead.
  const localized = result && {
    ...result,
    steps: (result.steps || []).map(step => ({
      ...step,
      label: t(`admin.peopleDirectories.test.steps.${step.id}`, step.label || step.id)
    }))
  };
  const chainSteps = (result?.steps || []).filter(
    step => Array.isArray(step?.details?.certificateChain) && step.details.certificateChain.length
  );
  const summary = result?.summary;

  return (
    <section
      aria-labelledby="pd-test-title"
      className="bg-white dark:bg-gray-800 shadow-xs border border-gray-200 dark:border-gray-700 rounded-lg p-6"
    >
      <h2 id="pd-test-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('admin.peopleDirectories.test.title', 'Test')}
      </h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'admin.peopleDirectories.test.description',
          'Connects with the settings as they are on this page, saved or not, and searches for a name. Nothing is saved.'
        )}
      </p>

      <form onSubmit={run} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="pd-test-query" className={LABEL_CLASS}>
            {t('admin.peopleDirectories.test.query', 'Name to search for (optional)')}
          </label>
          <input
            id="pd-test-query"
            type="text"
            maxLength={100}
            autoComplete="off"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Mustermann"
            aria-describedby="pd-test-query-help"
            className={INPUT_CLASS}
          />
          <p id="pd-test-query-help" className={HELP_CLASS}>
            {t(
              'admin.peopleDirectories.test.queryHelp',
              'Without a name the test stops after the bind. The search runs against the live directory.'
            )}
          </p>
        </div>
        <button type="submit" disabled={running} className={`${PRIMARY_BUTTON_CLASS} sm:mb-5`}>
          {running ? (
            <span
              className="inline-block h-4 w-4 animate-spin rounded-full border-b-2 border-white"
              aria-hidden="true"
            />
          ) : (
            <Icon name="play" size="sm" />
          )}
          {running
            ? t('admin.peopleDirectories.test.running', 'Testing…')
            : t('admin.peopleDirectories.test.run', 'Test')}
        </button>
      </form>

      <p role="status" className="sr-only">
        {running
          ? t('admin.peopleDirectories.test.running', 'Testing…')
          : result
            ? result.success
              ? t('admin.peopleDirectories.test.passed', 'Test passed')
              : t('admin.peopleDirectories.test.failed', 'Test failed')
            : ''}
        {summary && !running
          ? ` ${t(
              'admin.peopleDirectories.test.summary',
              '{{ok}} ok, {{warn}} warnings, {{fail}} failed',
              {
                ok: summary.ok ?? 0,
                warn: summary.warn ?? 0,
                fail: summary.fail ?? 0
              }
            )}`
          : ''}
      </p>

      {error && (
        <AdminLoadError
          framed={false}
          action={null}
          className="mt-4"
          title={t('admin.peopleDirectories.test.couldNotRun', 'The test could not run')}
          message={error}
        />
      )}

      {localized && (
        <div className="mt-4 space-y-4">
          <IntegrationTestResults
            title={t('admin.peopleDirectories.test.resultTitle', 'Connection test')}
            result={localized}
          />
          {chainSteps.map(step => (
            <CertificateChain
              key={step.id}
              chain={step.details.certificateChain}
              missingIssuer={step.details.missingIssuer}
              defaultOpen={step.status !== 'ok'}
            />
          ))}
          {Array.isArray(result.results) && (
            <PersonResultsTable results={result.results} fields={fields} />
          )}
        </div>
      )}
    </section>
  );
}

export default DirectoryTestPanel;
