/**
 * ParliamentaryQuestionsResultsRenderer
 *
 * Renders the structured output of the Parliamentary Questions Analyzer app
 * as a searchable table. Each row exposes three actions:
 *   1. Open the question's search_query in an external iFinder search.
 *   2. Ask the full question in an in-iHub chat app (e.g. iAssistant-backed app)
 *      with auto-send via the existing /apps/:id?prefill=...&send=true contract.
 *   3. Open the full question in an external iAssistant UI.
 *
 * Configuration comes from app.rendererConfig in the app JSON:
 *   - iFinderUrlTemplate:    full URL with {query} placeholder
 *   - iAssistantAppId:       id of an existing iHub chat app to navigate to
 *   - iAssistantUrlTemplate: full URL with {query} placeholder
 *
 * Buttons whose underlying template/id is missing render as disabled.
 */
const UserComponent = ({ data, t, rendererConfig, navigate, useState }) => {
  const safeT = (key, fallback) => (t ? t(key, fallback) : fallback);

  if (!data || !Array.isArray(data.questions) || data.questions.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500 border border-dashed border-gray-300 rounded-lg">
        {safeT(
          'parliamentaryQuestions.noData',
          'No questions could be extracted from the document.'
        )}
      </div>
    );
  }

  const config = rendererConfig || {};
  const iFinderUrlTemplate =
    typeof config.iFinderUrlTemplate === 'string' ? config.iFinderUrlTemplate : '';
  const iAssistantAppId = typeof config.iAssistantAppId === 'string' ? config.iAssistantAppId : '';
  const iAssistantUrlTemplate =
    typeof config.iAssistantUrlTemplate === 'string' ? config.iAssistantUrlTemplate : '';

  const buildUrl = (template, query) =>
    template ? template.replace('{query}', encodeURIComponent(query || '')) : '';

  const openIFinder = question => {
    const url = buildUrl(iFinderUrlTemplate, question.search_query || question.text);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openIAssistantApp = question => {
    if (!iAssistantAppId || !navigate) return;
    const params = new URLSearchParams({ prefill: question.text || '', send: 'true' });
    navigate(`/apps/${iAssistantAppId}?${params.toString()}`);
  };

  const openIAssistantExternal = question => {
    const url = buildUrl(iAssistantUrlTemplate, question.text);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-6 p-4">
      {/* Header */}
      <div className="rounded-lg border-2 border-blue-300 bg-blue-50 border-l-8 border-l-blue-500 p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            {data.document_title ? (
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 mb-1">
                {safeT('parliamentaryQuestions.documentTitle', 'Document')}
              </p>
            ) : null}
            <h2 className="text-2xl font-bold text-blue-900">
              {data.document_title ||
                safeT('parliamentaryQuestions.headerFallback', 'Parliamentary Questions')}
            </h2>
            <p className="mt-2 text-sm text-blue-800">
              {safeT('parliamentaryQuestions.questionsCount', '{count} questions detected').replace(
                '{count}',
                data.questions.length
              )}
            </p>
          </div>
          <div className="text-blue-500 flex-shrink-0">
            <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm3 1a1 1 0 100 2h6a1 1 0 100-2H7zm0 4a1 1 0 100 2h6a1 1 0 100-2H7zm0 4a1 1 0 100 2h4a1 1 0 100-2H7z"
                clipRule="evenodd"
              />
            </svg>
          </div>
        </div>
      </div>

      {/* Questions table */}
      <div className="overflow-x-auto border border-gray-200 rounded-lg shadow-sm">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide w-20">
                {safeT('parliamentaryQuestions.tableNumber', '#')}
              </th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                {safeT('parliamentaryQuestions.tableQuestion', 'Question')}
              </th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide w-40">
                {safeT('parliamentaryQuestions.tableTopic', 'Topic')}
              </th>
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wide w-56">
                {safeT('parliamentaryQuestions.tableActions', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {data.questions.map((question, idx) => (
              <QuestionRow
                key={`${question.number || 'q'}-${idx}`}
                question={question}
                onOpenIFinder={openIFinder}
                onOpenIAssistantApp={openIAssistantApp}
                onOpenIAssistantExternal={openIAssistantExternal}
                canIFinder={!!iFinderUrlTemplate}
                canIAssistantApp={!!iAssistantAppId && !!navigate}
                canIAssistantExternal={!!iAssistantUrlTemplate}
                safeT={safeT}
                useState={useState}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Config missing notice */}
      {!iFinderUrlTemplate && !iAssistantAppId && !iAssistantUrlTemplate ? (
        <div className="text-xs text-gray-500 italic">
          {safeT(
            'parliamentaryQuestions.configMissing',
            'No iFinder or iAssistant targets are configured. Set rendererConfig in the app JSON to enable the action buttons.'
          )}
        </div>
      ) : null}
    </div>
  );
};

const QuestionRow = ({
  question,
  onOpenIFinder,
  onOpenIAssistantApp,
  onOpenIAssistantExternal,
  canIFinder,
  canIAssistantApp,
  canIAssistantExternal,
  safeT,
  useState
}) => {
  const [expanded, setExpanded] = useState(false);
  const text = question.text || '';
  const isLong = text.length > 220;
  const displayText = expanded || !isLong ? text : `${text.slice(0, 220).trimEnd()}…`;

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      {/* Number */}
      <td className="px-3 py-4 align-top">
        <span className="inline-flex items-center justify-center min-w-[2rem] px-2 py-0.5 rounded-full text-sm font-semibold bg-blue-100 text-blue-800 border border-blue-200">
          {question.number || '—'}
        </span>
      </td>

      {/* Question text */}
      <td className="px-3 py-4 text-sm text-gray-800 align-top">
        <p className="leading-relaxed whitespace-pre-wrap">{displayText}</p>
        {isLong ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-xs font-medium text-blue-600 hover:underline focus:outline-none"
          >
            {expanded
              ? safeT('parliamentaryQuestions.showLess', 'Show less')
              : safeT('parliamentaryQuestions.showMore', 'Show more')}
          </button>
        ) : null}
        {question.search_query ? (
          <p className="mt-2 text-xs text-gray-500">
            <span className="font-semibold uppercase tracking-wide">
              {safeT('parliamentaryQuestions.searchQueryLabel', 'Search query')}:
            </span>{' '}
            <span className="font-mono">{question.search_query}</span>
          </p>
        ) : null}
      </td>

      {/* Topic */}
      <td className="px-3 py-4 align-top">
        {question.topic ? (
          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200">
            {question.topic}
          </span>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </td>

      {/* Actions */}
      <td className="px-3 py-4 align-top">
        <div className="flex items-center justify-end gap-2">
          {/* iFinder */}
          <ActionButton
            onClick={() => onOpenIFinder(question)}
            disabled={!canIFinder}
            tooltip={safeT('parliamentaryQuestions.searchInIFinder', 'Search in iFinder')}
            variant="secondary"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M21 21l-4.35-4.35M16 10a6 6 0 11-12 0 6 6 0 0112 0z"
              />
            </svg>
            <span className="ml-1.5">
              {safeT('parliamentaryQuestions.iFinderShort', 'iFinder')}
            </span>
          </ActionButton>

          {/* iAssistant (in-app, primary) */}
          <ActionButton
            onClick={() => onOpenIAssistantApp(question)}
            disabled={!canIAssistantApp}
            tooltip={safeT('parliamentaryQuestions.askInIAssistant', 'Ask iAssistant')}
            variant="primary"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <span className="ml-1.5">
              {safeT('parliamentaryQuestions.iAssistantShort', 'iAssistant')}
            </span>
          </ActionButton>

          {/* iAssistant external (icon-only) */}
          <ActionButton
            onClick={() => onOpenIAssistantExternal(question)}
            disabled={!canIAssistantExternal}
            tooltip={safeT(
              'parliamentaryQuestions.askInIAssistantExternal',
              'Open in external iAssistant'
            )}
            variant="ghost"
            iconOnly
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </ActionButton>
        </div>
      </td>
    </tr>
  );
};

const ActionButton = ({ onClick, disabled, tooltip, variant, iconOnly, children }) => {
  const base =
    'inline-flex items-center px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1';
  const variants = {
    primary:
      'bg-blue-600 text-white border-blue-600 hover:bg-blue-700 focus:ring-blue-500 disabled:bg-gray-200 disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed',
    secondary:
      'bg-white text-blue-700 border-blue-300 hover:bg-blue-50 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed',
    ghost:
      'bg-white text-gray-600 border-gray-300 hover:bg-gray-50 hover:text-gray-800 focus:ring-gray-400 disabled:text-gray-300 disabled:border-gray-200 disabled:cursor-not-allowed'
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      aria-label={tooltip}
      className={`${base} ${variants[variant] || variants.secondary} ${iconOnly ? 'px-2' : ''}`}
    >
      {children}
    </button>
  );
};

export default UserComponent;
