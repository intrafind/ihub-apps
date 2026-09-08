import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { hostnameOf } from '../groundingSources';

/**
 * Sources behind a grounded answer — the pages a provider-run web search
 * (Anthropic web search, Google Search grounding) cited for the reply.
 * Providers require these citations to be shown next to the answer.
 *
 * @param {Object} props
 * @param {Array<{url: string, title?: string, citedText?: string}>} props.sources
 */
function GroundingSources({ sources }) {
  const { t } = useTranslation();
  if (!Array.isArray(sources) || sources.length === 0) return null;

  return (
    <details className="mt-2 text-xs text-gray-600 dark:text-gray-400">
      <summary className="cursor-pointer select-none inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-200">
        <Icon name="globe-alt" className="w-3.5 h-3.5" />
        <span>
          {t('chatMessage.groundingSources.title', 'Sources')} ({sources.length})
        </span>
      </summary>
      <ol className="mt-1.5 space-y-1 list-decimal ps-5">
        {sources.map(source => {
          const host = hostnameOf(source.url);
          return (
            <li key={source.url}>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 dark:text-indigo-400 hover:underline break-all"
              >
                {source.title || host}
              </a>
              {source.title && host && (
                <span className="ms-1 text-gray-400 dark:text-gray-500">{host}</span>
              )}
              {source.citedText && (
                <p
                  className="text-gray-500 dark:text-gray-400 italic line-clamp-2"
                  title={t('chatMessage.groundingSources.citedText', 'Cited passage')}
                >
                  “{source.citedText}”
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export default GroundingSources;
