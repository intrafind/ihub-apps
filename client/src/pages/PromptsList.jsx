import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { fetchPrompts } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';
import Icon from '../components/Icon';

const highlightVariables = (text) =>
  text.split(/(\[[^\]]+\])/g).map((part, idx) =>
    part.startsWith('[') && part.endsWith(']') ? (
      <span key={idx} className="text-indigo-600 font-semibold">{part}</span>
    ) : (
      <span key={idx}>{part}</span>
    )
  );

const ITEMS_PER_PAGE = 9;

const PromptsList = () => {
  const { t } = useTranslation();
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchPrompts();
        setPrompts(Array.isArray(data) ? data : []);
        setError(null);
      } catch (err) {
        console.error('Error loading prompts:', err);
        setError(t('error.loadingFailed', 'Failed to load prompts'));
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const filteredPrompts = useMemo(() => {
    if (!searchTerm) return prompts;
    const term = searchTerm.toLowerCase();
    return prompts.filter(p =>
      p.name.toLowerCase().includes(term) || p.prompt.toLowerCase().includes(term)
    );
  }, [prompts, searchTerm]);

  const totalPages = Math.ceil(filteredPrompts.length / ITEMS_PER_PAGE);
  const pagePrompts = filteredPrompts.slice(
    page * ITEMS_PER_PAGE,
    (page + 1) * ITEMS_PER_PAGE
  );

  const handleSearchChange = (e) => {
    setSearchTerm(e.target.value);
    setPage(0);
  };

  const handlePrev = () => setPage(prev => Math.max(prev - 1, 0));
  const handleNext = () => setPage(prev => Math.min(prev + 1, totalPages - 1));

  if (loading) {
    return <LoadingSpinner message={t('app.loading')} />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
          onClick={() => window.location.reload()}
        >
          {t('app.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="py-8 flex flex-col items-center">
      <h1 className="text-3xl font-bold mb-2">
        {t('pages.promptsList.title', 'Prompts')}
      </h1>
      <p className="text-gray-600 mb-6">
        {t('pages.promptsList.subtitle', 'Browse available prompts')}
      </p>

      <div className="w-full max-w-md sm:max-w-lg lg:max-w-xl mb-8">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Icon name="search" className="text-gray-400" />
          </div>
          <input
            type="text"
            className="w-full pl-12 pr-12 py-3 border rounded-lg text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder={t('pages.promptsList.searchPlaceholder', 'Search prompts...')}
            value={searchTerm}
            onChange={handleSearchChange}
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => { setSearchTerm(''); setPage(0); }}
              className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600"
              aria-label={t('common.clear', 'Clear')}
            >
              <Icon name="x" className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {filteredPrompts.length === 0 ? (
        <p className="text-gray-500">{t('pages.promptsList.noPrompts', 'No prompts found')}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 w-full">
            {pagePrompts.map(p => (
              <div key={p.id} className="bg-white rounded-lg shadow p-4 flex flex-col">
                <div className="flex items-center mb-2">
                  <Icon name={p.icon || 'clipboard'} className="w-6 h-6 mr-2" />
                  <h3 className="font-semibold text-lg flex items-center">
                    {p.name}
                    {p.appId && (
                      <span className="ml-1 text-xs text-indigo-600">{t('common.promptSearch.appSpecific', 'app')}</span>
                    )}
                  </h3>
                </div>
                <p className="text-sm text-gray-600 flex-grow">
                  {highlightVariables(p.prompt)}
                </p>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(p.prompt.replace('[content]', ''));
                    alert(t('pages.promptsList.copied', 'Copied!'));
                  }}
                  className="mt-4 self-start px-3 py-1 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
                >
                  {t('pages.promptsList.copyPrompt', 'Copy prompt')}
                </button>
                {p.appId && (
                  <Link
                    to={`/apps/${p.appId}?prefill=${encodeURIComponent(p.prompt.replace('[content]', ''))}`}
                    className="mt-2 text-sm text-indigo-600 hover:underline self-start"
                  >
                    {t('pages.promptsList.useInApp', 'Open app')}
                  </Link>
                )}
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-6">
              <button
                onClick={handlePrev}
                disabled={page === 0}
                className="px-3 py-1 border rounded text-indigo-600 disabled:opacity-50"
              >
                {t('pages.promptsList.previous', 'Previous')}
              </button>
              <span className="text-sm text-gray-600">
                {t('pages.promptsList.pageOfTotal', {
                  defaultValue: 'Page {{current}} of {{total}}',
                  current: page + 1,
                  total: totalPages
                })}
              </span>
              <button
                onClick={handleNext}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 border rounded text-indigo-600 disabled:opacity-50"
              >
                {t('pages.promptsList.next', 'Next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PromptsList;
