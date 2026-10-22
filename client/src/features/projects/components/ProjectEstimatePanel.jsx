// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatTokenCount } from '../../admin/utils/tokenStats';

/**
 * What a project-level estimate means, in words. `recommendation` is
 * `prompt`, `search` or `unknown`; `reason` says why.
 */
function useVerdictText() {
  const { t } = useTranslation();
  return (recommendation, reason) => {
    switch (`${recommendation}:${reason}`) {
      case 'prompt:comfortable':
        return t(
          'projects.estimate.verdict.comfortable',
          'Put it into the prompt. It fits the budget with room to spare: link it in "always in the prompt" mode (or "auto", which loads it).'
        );
      case 'prompt:tight':
        return t(
          'projects.estimate.verdict.tight',
          'It fits, but takes most of the budget that every linked project shares. Put it into the prompt only when it is the main knowledge of the app; otherwise let the tools search it.'
        );
      case 'search:exceeds':
        return t(
          'projects.estimate.verdict.exceeds',
          'Do not put it into the prompt. It is larger than the budget, so "auto" searches it. Link it in "search with tools" mode and pin only the few documents that must always be present.'
        );
      case 'search:partial':
        return t(
          'projects.estimate.verdict.partial',
          'At least one source delivered only part of its text, so the project is searched, not loaded in full.'
        );
      case 'unknown:incomplete':
        return t(
          'projects.estimate.verdict.incomplete',
          'Some documents could not be read, so the size is not complete. Fix them and estimate again.'
        );
      case 'unknown:empty':
        return t('projects.estimate.verdict.empty', 'There is no text to measure yet.');
      default:
        return '';
    }
  };
}

const TONE = {
  prompt:
    'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200',
  search:
    'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200',
  unknown:
    'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
};

/**
 * The result of "Estimate tokens" for a project: its size in tokens against
 * the prompt budget, and the recommendation (prompt or search). The per-item
 * advice is a column of the items table.
 *
 * @param {Object} props
 * @param {Object} props.estimate - `POST …/estimate`.
 * @param {() => void} [props.onDismiss]
 * @returns {JSX.Element}
 */
function ProjectEstimatePanel({ estimate, onDismiss }) {
  const { t } = useTranslation();
  const verdictText = useVerdictText();
  const tone = TONE[estimate.recommendation] || TONE.unknown;
  const percent = Math.round((estimate.share || 0) * 100);
  const label =
    estimate.recommendation === 'prompt'
      ? t('projects.estimate.recommendation.prompt', 'Recommendation: in the prompt')
      : estimate.recommendation === 'search'
        ? t('projects.estimate.recommendation.search', 'Recommendation: search with tools')
        : t('projects.estimate.recommendation.unknown', 'No recommendation yet');

  return (
    <section
      data-testid="project-estimate"
      aria-label={t('projects.estimate.title', 'Token estimate')}
      className={`rounded-lg border p-4 ${tone}`}
    >
      <div className="flex items-start gap-3">
        <Icon name="chart-bar" size="md" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{label}</h3>
          <p className="mt-1 text-sm">
            {t('projects.estimate.total', '~{{tokens}} tokens in total', {
              tokens: formatTokenCount(estimate.tokens)
            })}
            {' · '}
            {t(
              'projects.estimate.budget',
              '{{percent}} % of the {{budget}} tokens a prompt may load in full',
              { percent, budget: formatTokenCount(estimate.budgetTokens) }
            )}
          </p>
          <p className="mt-2 text-sm">{verdictText(estimate.recommendation, estimate.reason)}</p>
          {estimate.tokens > 0 && (
            <p className="mt-2 text-xs opacity-80">
              {t(
                'projects.estimate.minContext',
                'A model needs a context window of about {{tokens}} tokens to load it in full (the prompt takes at most 40 % of it).',
                { tokens: formatTokenCount(estimate.minContextWindow) }
              )}
            </p>
          )}
          {estimate.unmeasured > 0 && (
            <p className="mt-1 text-xs opacity-80">
              {t(
                'projects.estimate.unmeasured',
                '{{count}} documents could not be read and are not counted.',
                { count: estimate.unmeasured }
              )}
            </p>
          )}
          <p className="mt-2 text-xs opacity-80">
            {t(
              'projects.estimate.approximate',
              'An estimate: the model counts its own tokens, within about 10–20 %.'
            )}
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('common.close', 'Close')}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            <Icon name="x" size="sm" />
          </button>
        )}
      </div>
    </section>
  );
}

export default ProjectEstimatePanel;
