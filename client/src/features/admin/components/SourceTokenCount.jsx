import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatTokenCount } from '../utils/tokenStats';

/**
 * A source exposed as prompt content is added to every request; above this
 * size that cost deserves a warning (and many context windows are at risk).
 */
export const LARGE_PROMPT_SOURCE_TOKENS = 50000;

/**
 * Estimated size of a source in tokens (from GET /admin/sources/_tokens),
 * with what it means for how the source is exposed: prompt content is sent
 * with every request, while a tool source larger than one tool result is
 * searched and only the matching sections are returned.
 *
 * @param {object} props
 * @param {object} [props.estimate] - `{ tokens, reason?, maxTokens?, error? }`
 * @param {'prompt'|'tool'} [props.exposeAs]
 * @param {number} [props.budgetTokens] - Most tokens one tool call returns
 * @param {boolean} [props.inline] - Render on one line (for compact lists)
 */
function SourceTokenCount({ estimate, exposeAs, budgetTokens, inline = false }) {
  const { t } = useTranslation();
  const muted = 'text-gray-400 dark:text-gray-500';
  // Inline, the count takes the size and colour of the row it sits in.
  const size = inline ? '' : 'text-sm';
  const plain = inline ? '' : 'text-gray-700 dark:text-gray-300';

  if (!estimate || !Number.isFinite(estimate.tokens)) {
    let title = estimate?.error || '';
    let label = '—';
    if (estimate?.reason === 'remote') {
      title = t(
        'admin.sources.tokensRemote',
        'Loaded from the web when used; testing the source measures it'
      );
    } else if (estimate?.reason === 'dynamic' && Number.isFinite(estimate.maxTokens)) {
      label = t('admin.sources.tokensAtMost', '≤ ~{{tokens}} tokens', {
        tokens: formatTokenCount(estimate.maxTokens)
      });
      title = t(
        'admin.sources.tokensDynamic',
        'Depends on what the search finds; at most the configured results × maximum length'
      );
    }
    return (
      <span className={`${size} ${muted}`} title={title}>
        {label}
      </span>
    );
  }

  const { tokens } = estimate;
  const searched = exposeAs === 'tool' && Number.isFinite(budgetTokens) && tokens > budgetTokens;
  const large = exposeAs !== 'tool' && tokens > LARGE_PROMPT_SOURCE_TOKENS;

  let note = null;
  if (searched) {
    note = (
      <span className={`text-xs ${muted}`}>
        {t('admin.sources.tokensSearched', 'searched, up to ~{{tokens}} per call', {
          tokens: formatTokenCount(budgetTokens)
        })}
      </span>
    );
  } else if (large) {
    note = (
      <span className="text-xs text-amber-600 dark:text-amber-400">
        {t('admin.sources.tokensEveryRequest', 'sent with every request')}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex ${inline ? 'items-center gap-1.5' : 'flex-col'}`}
      title={
        large
          ? t(
              'admin.sources.tokensLargePromptHint',
              'This source is added to the prompt of every request. Expose it as a tool so only the sections a question needs are loaded.'
            )
          : undefined
      }
    >
      <span
        className={`inline-flex items-center ${size} ${
          large ? 'text-amber-700 dark:text-amber-300' : plain
        }`}
      >
        {large && <Icon name="exclamation-triangle" className="h-4 w-4 mr-1" />}
        {t('admin.sources.tokenCount', '~{{tokens}} tokens', {
          tokens: formatTokenCount(tokens)
        })}
      </span>
      {note}
    </span>
  );
}

export default SourceTokenCount;
