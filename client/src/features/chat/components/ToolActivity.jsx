import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { hostnameOf } from '../groundingSources';

/**
 * What the turn did before it answered: the web searches it ran, the pages
 * they found and which of those were read, and the other tools it called.
 *
 * Open while the answer streams, so the user can follow the search as it
 * happens; collapsed to a one-line summary once the answer is complete, where
 * it stays as provenance.
 *
 * @param {Object} props
 * @param {{items: Array<Object>, reading: string|null}} props.activity - see features/chat/toolActivity
 * @param {boolean} [props.loading] - whether the answer is still streaming
 */
function ToolActivity({ activity, loading = false }) {
  const { t } = useTranslation();
  const listId = useId();
  // null = follow the streaming state; a click pins the user's choice.
  const [expanded, setExpanded] = useState(null);

  const items = activity?.items || [];
  if (items.length === 0) return null;
  const open = expanded ?? loading;

  const searches = items.filter(item => item.kind === 'search');
  const running = items.some(item => item.status === 'running');
  const headline = running
    ? runningHeadline(t, items, activity.reading)
    : finishedHeadline(t, items, searches);

  return (
    <div className="mb-2 text-xs text-gray-600 dark:text-gray-400">
      <button
        type="button"
        onClick={() => setExpanded(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className="inline-flex items-center gap-1.5 max-w-full text-start hover:text-gray-900 dark:hover:text-gray-200"
      >
        {running ? (
          <Icon name="spinner" size="sm" className="shrink-0 animate-spin" />
        ) : (
          <Icon
            name={searches.length ? 'globe-alt' : 'wrench'}
            size="sm"
            className="shrink-0 text-gray-400 dark:text-gray-500"
          />
        )}
        <span className="truncate">{headline}</span>
        <Icon
          name="chevron-down"
          size="sm"
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <ol
          id={listId}
          className="mt-1.5 ms-1.5 ps-3 border-s border-gray-200 dark:border-gray-700 space-y-2"
        >
          {items.map(item => (
            <ActivityItem key={item.id} item={item} />
          ))}
        </ol>
      )}
    </div>
  );
}

function countRead(items) {
  return items.reduce((sum, item) => sum + item.sources.filter(source => source.read).length, 0);
}

function countSources(items) {
  return new Set(items.flatMap(item => item.sources.map(source => source.url))).size;
}

function runningHeadline(t, items, reading) {
  if (reading) {
    return t('toolActivity.reading', 'Reading {{host}}', { host: hostnameOf(reading) });
  }
  const current = [...items].reverse().find(item => item.status === 'running');
  if (current?.kind === 'search') {
    const query = current.query || current.queries?.[current.queries.length - 1];
    return query
      ? t('toolActivity.searchingFor', 'Searching for “{{query}}”', { query })
      : t('toolActivity.searching', 'Searching the web…');
  }
  if (current?.kind === 'fetch') {
    return current.url
      ? t('toolActivity.reading', 'Reading {{host}}', { host: hostnameOf(current.url) })
      : t('toolActivity.searching', 'Searching the web…');
  }
  return t('toolActivity.runningTool', 'Running {{name}}', { name: current?.name || '' });
}

function finishedHeadline(t, items, searches) {
  const parts = [];
  if (searches.length) {
    parts.push(t('toolActivity.searchedWeb', 'Searched the web'));
    const queryCount = searches.reduce(
      (sum, item) => sum + (item.native ? item.queries.length : 1),
      0
    );
    parts.push(t('toolActivity.searches', { count: queryCount }));
    const sources = countSources(items);
    if (sources) parts.push(t('toolActivity.sources', { count: sources }));
  } else if (items.some(item => item.kind === 'fetch')) {
    parts.push(t('toolActivity.readWeb', 'Read the web'));
  }
  const read = countRead(items);
  if (read) parts.push(t('toolActivity.pagesRead', { count: read }));
  const others = items.filter(item => item.kind === 'tool').length;
  if (others) parts.push(t('toolActivity.toolCalls', { count: others }));
  return parts.join(' · ');
}

function StatusIcon({ item, fallback }) {
  if (item.status === 'running') {
    return <Icon name="spinner" size="sm" className="shrink-0 animate-spin" />;
  }
  if (item.status === 'error') {
    return <Icon name="exclamation-circle" size="sm" className="shrink-0 text-red-500" />;
  }
  return <Icon name={fallback} size="sm" className="shrink-0 text-gray-400 dark:text-gray-500" />;
}

function ActivityItem({ item }) {
  const { t } = useTranslation();

  if (item.kind === 'search') {
    const queries = item.native ? item.queries : item.query ? [item.query] : [];
    return (
      <li>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusIcon item={item} fallback="search" />
          <span>
            {queries.length
              ? t('toolActivity.searchedFor', 'Searched for')
              : t('toolActivity.ranTool', 'Ran {{name}}', { name: item.name })}
          </span>
          {queries.map(query => (
            <span
              key={query}
              className="inline-flex items-center px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700/50 break-all"
            >
              {query}
            </span>
          ))}
          {item.sources.length > 0 && (
            <span className="text-gray-400 dark:text-gray-500">
              {t('toolActivity.sources', { count: item.sources.length })}
            </span>
          )}
          <ItemStatus item={item} />
        </div>
        {item.sources.length > 0 && (
          <ul className="mt-1 ms-5 space-y-0.5">
            {item.sources.map(source => (
              <SourceRow key={source.url} source={source} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  if (item.kind === 'fetch') {
    const url = item.url || item.sources[0]?.url;
    return (
      <li className="flex flex-wrap items-center gap-1.5">
        <StatusIcon item={item} fallback="document-text" />
        <span>{t('toolActivity.readPage', 'Read')}</span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 dark:text-indigo-400 hover:underline break-all"
          >
            {item.sources[0]?.title || hostnameOf(url)}
          </a>
        )}
        <ItemStatus item={item} />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-1.5">
      <StatusIcon item={item} fallback="wrench" />
      <span>
        {item.status === 'running'
          ? t('toolActivity.runningTool', 'Running {{name}}', { name: item.name })
          : t('toolActivity.ranTool', 'Ran {{name}}', { name: item.name })}
      </span>
      <ItemStatus item={item} />
    </li>
  );
}

function ItemStatus({ item }) {
  const { t } = useTranslation();
  if (item.status === 'error') {
    return (
      <span className="text-red-600 dark:text-red-400" title={item.error || undefined}>
        {t('toolActivity.failed', 'Failed')}
      </span>
    );
  }
  if (item.status === 'stopped') {
    return <span>{t('toolActivity.stopped', 'Stopped')}</span>;
  }
  return null;
}

function SourceRow({ source }) {
  const { t } = useTranslation();
  const host = hostnameOf(source.url);
  return (
    <li className="flex items-baseline gap-1.5 min-w-0">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-indigo-600 dark:text-indigo-400 hover:underline truncate"
        title={source.url}
      >
        {source.title || host}
      </a>
      {source.title && host && (
        <span className="shrink-0 text-gray-400 dark:text-gray-500">{host}</span>
      )}
      {source.read && (
        <span
          className="shrink-0 inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
          title={t('toolActivity.readTitle', 'The page was fetched and read')}
        >
          <Icon name="eye" size="xs" />
          {t('toolActivity.read', 'Read')}
        </span>
      )}
      {source.readFailed && (
        <span
          className="shrink-0 text-amber-600 dark:text-amber-400"
          title={t('toolActivity.readFailedTitle', 'The page could not be fetched')}
        >
          {t('toolActivity.readFailed', 'Not readable')}
        </span>
      )}
    </li>
  );
}

export default ToolActivity;
