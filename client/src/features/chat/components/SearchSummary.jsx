import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * What an iAssistant turn searched for, and what it found.
 *
 * The iAssistant webapp shows this beside every answer, and it is provenance
 * rather than progress: knowing that a turn ran three queries and matched
 * twelve documents in SharePoint is how a reader judges an answer they cannot
 * otherwise check. So it stays on screen once the answer is complete, unlike
 * the phase indicator next to it, which only describes work in flight.
 *
 * A turn searches repeatedly, so these numbers are the totals the reducer
 * accumulated across every round, not the last round's.
 *
 * @param {Object} props
 * @param {Object} props.summary - { queries, totalHits, applications, sources, rounds, searching }
 */
function SearchSummary({ summary }) {
  const { t } = useTranslation();

  if (!summary || !summary.rounds) return null;

  const { queries = [], totalHits = 0, applications = [], sources = [], searching } = summary;

  // While a round is still running the hit count is the running total, which
  // would read as a final answer. Only claim a count once nothing is in
  // flight and something has actually come back.
  const showHits = !searching && totalHits > 0;
  const provenance = [...sources, ...applications];

  if (queries.length === 0 && !showHits) return null;

  return (
    <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
      {queries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1">
            <Icon name="search" size="sm" className="text-gray-400 dark:text-gray-500" />
            {t('searchSummary.searchedFor', 'Searched for')}
          </span>
          {queries.map(query => (
            <span
              key={query}
              className="inline-flex items-center px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700/50"
            >
              {query}
            </span>
          ))}
        </div>
      )}
      {showHits && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{t('searchSummary.documentsFound', { count: totalHits })}</span>
          {provenance.length > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{provenance.join(', ')}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default SearchSummary;
