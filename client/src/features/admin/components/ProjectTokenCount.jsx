// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatTokenCount } from '../utils/tokenStats';

/**
 * Estimated size of a linked project in tokens (from
 * `GET /api/admin/projects/_tokens`) and what it means for the link mode:
 *
 *  - `auto`: the whole text goes into the prompt while it fits the load-all
 *    budget; a larger project is searched with tools instead;
 *  - `context`: the text is sent with every request, so a project above the
 *    load-all budget is flagged;
 *  - `tools`: the model searches the project; one call returns at most the
 *    tool result budget.
 *
 * Without a mode (the admin list) only the size is shown.
 *
 * @param {Object} props
 * @param {{tokens?: number, items?: number, bytes?: number}} [props.estimate]
 * @param {'auto'|'context'|'tools'} [props.mode]
 * @param {number} [props.loadAllBudgetTokens] - Most tokens loaded into the prompt in `auto` mode.
 * @param {number} [props.toolResultBudgetTokens] - Most tokens one tool call returns.
 * @param {boolean} [props.inline=false] - Render on one line (for compact lists).
 * @returns {JSX.Element}
 */
function ProjectTokenCount({
  estimate,
  mode,
  loadAllBudgetTokens,
  toolResultBudgetTokens,
  inline = false
}) {
  const { t } = useTranslation();
  const muted = 'text-gray-600 dark:text-gray-400';
  const size = inline ? 'text-xs' : 'text-sm';

  if (!estimate || !Number.isFinite(estimate.tokens)) {
    return (
      <span
        className={`${size} ${muted}`}
        title={t('admin.projects.tokens.unknown', 'Size not known yet')}
      >
        —
      </span>
    );
  }

  const { tokens } = estimate;
  const hasLoadAllBudget = Number.isFinite(loadAllBudgetTokens) && loadAllBudgetTokens > 0;
  const fitsPrompt = !hasLoadAllBudget || tokens <= loadAllBudgetTokens;
  const large = mode === 'context' && !fitsPrompt;

  let note = null;
  if (mode === 'auto') {
    note = fitsPrompt
      ? t('admin.projects.tokens.autoPrompt', 'loaded into the prompt')
      : t('admin.projects.tokens.autoSearched', 'too large to load; searched with tools');
  } else if (mode === 'context') {
    note = t('admin.projects.tokens.everyRequest', 'sent with every request');
  } else if (mode === 'tools' && Number.isFinite(toolResultBudgetTokens)) {
    note = t('admin.projects.tokens.searched', 'searched, up to ~{{tokens}} per call', {
      tokens: formatTokenCount(toolResultBudgetTokens)
    });
  }

  return (
    <span
      className={`inline-flex ${inline ? 'items-center gap-1.5' : 'flex-col'}`}
      title={
        large
          ? t(
              'admin.projects.tokens.largeContextHint',
              'This project is larger than the ~{{budget}} tokens loaded into a prompt. In "always in the prompt" mode it fills the context window of every request; "auto" searches it instead.',
              { budget: formatTokenCount(loadAllBudgetTokens) }
            )
          : undefined
      }
    >
      <span
        className={`inline-flex items-center ${size} ${
          large ? 'text-amber-700 dark:text-amber-300' : 'text-gray-700 dark:text-gray-300'
        }`}
      >
        {large && <Icon name="exclamation-triangle" className="h-4 w-4 mr-1" />}
        {t('admin.projects.tokens.count', '~{{tokens}} tokens', {
          tokens: formatTokenCount(tokens)
        })}
      </span>
      {note && (
        <span
          className={`text-xs ${large ? 'text-amber-700 dark:text-amber-400' : muted}`}
          data-testid="project-token-note"
        >
          {note}
        </span>
      )}
    </span>
  );
}

export default ProjectTokenCount;
