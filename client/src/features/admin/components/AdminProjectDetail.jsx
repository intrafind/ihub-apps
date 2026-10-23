// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  estimateAdminProject,
  getAdminApiErrorMessage,
  testAdminProject
} from '../../../api/adminApi';
import EstimateTokensButton from '../../projects/components/EstimateTokensButton';
import ProjectEstimatePanel from '../../projects/components/ProjectEstimatePanel';
import { useProjectEstimate } from '../../projects/hooks/useProjectEstimate';
import ProjectTestResults from './ProjectTestResults';

/**
 * The parts the admin project view and edit pages share: the checks (Test
 * reads every item the way a chat would, Estimate counts the tokens), their
 * header buttons and results, and the two-column layout of a user's project
 * page (the items wide, the settings beside them).
 *
 * @module features/admin/components/AdminProjectDetail
 */

const adminErrorMessage = err => getAdminApiErrorMessage(err);

/**
 * Hook: the Test and Estimate checks of one admin project.
 *
 * @param {string} id - The project id.
 * @returns {{estimate: Object|null, byItem: Object, estimating: boolean,
 *   estimateError: string|null, runEstimate: Function, clearEstimate: Function,
 *   testing: boolean, testResult: Object|null, runTest: Function, clearTest: Function}}
 */
export function useAdminProjectChecks(id) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const estimateCall = useCallback(() => estimateAdminProject(id), [id]);
  const {
    estimate,
    byItem,
    loading: estimating,
    error: estimateError,
    run: runEstimate,
    clear: clearEstimate
  } = useProjectEstimate(estimateCall, adminErrorMessage);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testAdminProject(id));
    } catch (err) {
      setTestResult({
        success: false,
        duration: 0,
        items: [],
        error: getAdminApiErrorMessage(err)
      });
    } finally {
      setTesting(false);
    }
  };

  return {
    estimate,
    byItem,
    estimating,
    estimateError,
    runEstimate,
    clearEstimate,
    testing,
    testResult,
    runTest,
    clearTest: () => setTestResult(null)
  };
}

/** A header button's box; every button of the row has the same height. */
const OUTLINE_BUTTON =
  'rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600';

/** The filled header button (Edit), the same box as the others. */
export const FILLED_HEADER_BUTTON =
  'bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg border border-transparent text-sm font-medium flex items-center';

/**
 * The header buttons: History, Estimate tokens, Test, and what the page adds.
 *
 * @param {Object} props
 * @param {ReturnType<typeof useAdminProjectChecks>} props.checks
 * @param {() => void} props.onHistory
 * @param {import('react').ReactNode} [props.children] - Further buttons (Edit).
 * @returns {JSX.Element}
 */
export function AdminProjectHeaderActions({ checks, onHistory, children = null }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={onHistory} className={OUTLINE_BUTTON}>
        {t('admin.projects.history', 'History')}
      </button>
      <EstimateTokensButton loading={checks.estimating} onClick={checks.runEstimate} />
      <button
        type="button"
        onClick={checks.runTest}
        disabled={checks.testing}
        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg border border-transparent text-sm font-medium flex items-center"
      >
        <Icon
          name={checks.testing ? 'arrow-path' : 'beaker'}
          className={`h-4 w-4 mr-2 ${checks.testing ? 'animate-spin' : ''}`}
        />
        {checks.testing
          ? t('admin.projects.test.running', 'Testing...')
          : t('admin.projects.test.button', 'Test')}
      </button>
      {children}
    </div>
  );
}

/**
 * The results of the checks, above the items.
 *
 * @param {{checks: ReturnType<typeof useAdminProjectChecks>}} props
 * @returns {JSX.Element}
 */
export function AdminProjectCheckResults({ checks }) {
  const { t } = useTranslation();
  return (
    <>
      {checks.estimateError && (
        <div
          role="alert"
          className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-800 dark:text-red-200"
        >
          {t('projects.estimate.failed', 'The estimate could not be made.')} {checks.estimateError}
        </div>
      )}
      {checks.estimate && (
        <ProjectEstimatePanel estimate={checks.estimate} onDismiss={checks.clearEstimate} />
      )}
      {checks.testResult && (
        <ProjectTestResults result={checks.testResult} onDismiss={checks.clearTest} />
      )}
    </>
  );
}

/**
 * The layout of a project's page: the main column wide (and first on a
 * narrow screen), the side column beside it.
 *
 * @param {{main: import('react').ReactNode, side: import('react').ReactNode}} props
 * @returns {JSX.Element}
 */
export function ProjectDetailLayout({ main, side }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      <div className="lg:col-span-2 space-y-6 min-w-0">{main}</div>
      {side}
    </div>
  );
}
