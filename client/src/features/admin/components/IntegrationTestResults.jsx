import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Renders the step-by-step result of an integration connection test
 * (`POST /api/admin/integrations/{ifinder|iassistant}/_test`).
 *
 * Each step shows its status, the observed facts and — when something failed —
 * the hints the server derived, so an admin can act without reading server logs.
 * Failed and warning steps start expanded; successful ones stay collapsed.
 */

const STATUS_STYLES = {
  ok: {
    icon: 'check-circle',
    badge:
      'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800',
    iconColor: 'text-green-600 dark:text-green-400'
  },
  warn: {
    icon: 'exclamation-triangle',
    badge:
      'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800',
    iconColor: 'text-amber-600 dark:text-amber-400'
  },
  fail: {
    icon: 'close',
    badge:
      'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800',
    iconColor: 'text-red-600 dark:text-red-400'
  },
  skip: {
    icon: 'minus-circle',
    badge:
      'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600',
    iconColor: 'text-gray-400 dark:text-gray-500'
  }
};

function CopyButton({ value, label }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center px-2 py-1 text-xs font-medium rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
    >
      <Icon name={copied ? 'check' : 'clipboard'} size="sm" className="mr-1" />
      {copied ? t('admin.iFinder.testResults.copied', 'Copied') : label}
    </button>
  );
}

function StepRow({ step }) {
  const { t } = useTranslation();
  const style = STATUS_STYLES[step.status] || STATUS_STYLES.skip;
  const hasBody = Boolean(step.details || step.hints?.length);
  const [expanded, setExpanded] = useState(step.status === 'fail' || step.status === 'warn');

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 last:border-b-0">
      <button
        type="button"
        onClick={() => hasBody && setExpanded(prev => !prev)}
        disabled={!hasBody}
        className={`w-full flex items-start gap-3 px-3 py-2.5 text-left ${
          hasBody ? 'hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer' : 'cursor-default'
        }`}
      >
        <Icon name={style.icon} size="md" className={`mt-0.5 flex-shrink-0 ${style.iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {step.label}
            </span>
            {typeof step.durationMs === 'number' && (
              <span className="text-xs text-gray-400 dark:text-gray-500">{step.durationMs}ms</span>
            )}
          </div>
          {step.message && (
            <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-300 break-words">
              {step.message}
            </p>
          )}
        </div>
        {hasBody && (
          <Icon
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size="sm"
            className="mt-1 flex-shrink-0 text-gray-400"
          />
        )}
      </button>

      {expanded && hasBody && (
        <div className="px-3 pb-3 pl-11 space-y-3">
          {step.hints?.length > 0 && (
            // A passing step can still carry hints (e.g. "verify this URL from the
            // iFinder host too"). Those are notes, not problems, so they must not
            // be styled like a warning.
            <div
              className={`rounded-md border p-3 ${
                step.status === 'ok' || step.status === 'skip'
                  ? 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800'
                  : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
              }`}
            >
              <p
                className={`text-xs font-semibold uppercase tracking-wide ${
                  step.status === 'ok' || step.status === 'skip'
                    ? 'text-indigo-800 dark:text-indigo-300'
                    : 'text-amber-800 dark:text-amber-300'
                }`}
              >
                {step.status === 'ok' || step.status === 'skip'
                  ? t('admin.iFinder.testResults.notes', 'Notes')
                  : t('admin.iFinder.testResults.whatToCheck', 'What to check')}
              </p>
              <ul className="mt-1.5 space-y-1 list-disc list-outside ml-4">
                {step.hints.map(hint => (
                  <li
                    key={hint}
                    className={`text-sm ${
                      step.status === 'ok' || step.status === 'skip'
                        ? 'text-indigo-900 dark:text-indigo-200'
                        : 'text-amber-900 dark:text-amber-200'
                    }`}
                  >
                    {hint}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {step.details && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  {t('admin.iFinder.testResults.observed', 'Observed')}
                </p>
                <CopyButton
                  value={JSON.stringify(step.details, null, 2)}
                  label={t('admin.iFinder.testResults.copyDetails', 'Copy')}
                />
              </div>
              <pre className="text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-2 overflow-x-auto text-gray-700 dark:text-gray-300">
                {JSON.stringify(step.details, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IntegrationTestResults({ title, result }) {
  const { t } = useTranslation();
  if (!result) return null;

  const { success, message, summary, steps, jwt, request } = result;
  const headerStyle = success ? STATUS_STYLES.ok : STATUS_STYLES.fail;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="flex items-start gap-3 px-3 py-3 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
        <Icon name={headerStyle.icon} size="md" className={`mt-0.5 ${headerStyle.iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</span>
            <span
              className={`px-2 py-0.5 text-xs font-medium rounded-full border ${headerStyle.badge}`}
            >
              {success
                ? t('admin.iFinder.testResults.success', 'Success')
                : t('admin.iFinder.testResults.failed', 'Failed')}
            </span>
            {summary && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('admin.iFinder.testResults.stepSummary', {
                  defaultValue: '{{ok}} ok, {{warn}} warnings, {{fail}} failed · {{duration}}ms',
                  ok: summary.ok,
                  warn: summary.warn,
                  fail: summary.fail,
                  duration: summary.durationMs
                })}
              </span>
            )}
          </div>
          {message && (
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300 break-words">{message}</p>
          )}
        </div>
      </div>

      {steps?.length > 0 ? (
        <div className="bg-white dark:bg-gray-800">
          {steps.map(step => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>
      ) : (
        result.details && (
          <pre className="text-xs bg-white dark:bg-gray-800 p-3 overflow-x-auto text-gray-700 dark:text-gray-300">
            {JSON.stringify(result.details, null, 2)}
          </pre>
        )
      )}

      {(request?.curl || jwt?.token) && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-200 dark:border-gray-700">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.iFinder.testResults.reproduce', 'Reproduce outside iHub:')}
          </span>
          {request?.curl && (
            <CopyButton
              value={request.curl}
              label={t('admin.iFinder.testResults.copyCurl', 'Copy curl command')}
            />
          )}
          {jwt?.token && (
            <CopyButton
              value={jwt.token}
              label={t('admin.iFinder.testResults.copyToken', 'Copy JWT')}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default IntegrationTestResults;
