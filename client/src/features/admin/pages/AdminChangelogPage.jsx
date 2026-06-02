import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../api/adminApi';

const STORAGE_KEY = 'admin_changelog_seen';

/**
 * Parse basic Markdown text into an array of React elements.
 *
 * Supported syntax:
 *   ## heading  -> <h3>
 *   ### heading -> <h4>
 *   - item      -> <li> (consecutive items grouped into <ul>)
 *   ```…```     -> <pre><code>
 *   blank line  -> paragraph break
 *   other       -> <p>
 */
function renderMarkdown(text) {
  if (!text) return null;

  const lines = text.split('\n');
  const elements = [];
  let listItems = [];
  let codeBlock = [];
  let inCode = false;
  let key = 0;

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={key++} className="list-disc pl-6 mb-3 space-y-1 text-gray-700 dark:text-gray-300">
          {listItems.map(item => (
            <li key={item}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      listItems = [];
    }
  };

  const flushCode = () => {
    if (codeBlock.length > 0) {
      elements.push(
        <pre
          key={key++}
          className="bg-gray-100 dark:bg-gray-800 rounded-md p-3 mb-3 overflow-x-auto text-sm font-mono text-gray-800 dark:text-gray-200"
        >
          <code>{codeBlock.join('\n')}</code>
        </pre>
      );
      codeBlock = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Toggle code fence
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBlock.push(line);
      continue;
    }

    // Blank line — flush accumulated list
    if (line.trim() === '') {
      flushList();
      continue;
    }

    // H2 heading (## )
    if (line.startsWith('## ')) {
      flushList();
      elements.push(
        <h3
          key={key++}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-4 mb-2"
        >
          {renderInline(line.slice(3))}
        </h3>
      );
      continue;
    }

    // H3 heading (### )
    if (line.startsWith('### ')) {
      flushList();
      elements.push(
        <h4
          key={key++}
          className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-3 mb-1"
        >
          {renderInline(line.slice(4))}
        </h4>
      );
      continue;
    }

    // H1 heading (# ) — used as section title in features.md
    if (line.startsWith('# ')) {
      flushList();
      // Skip the top-level title (e.g. "# Features — 5.4.0") since we already show the version heading
      continue;
    }

    // List item (- )
    if (line.startsWith('- ')) {
      listItems.push(line.slice(2));
      continue;
    }

    // Regular paragraph
    flushList();
    elements.push(
      <p key={key++} className="text-gray-700 dark:text-gray-300 mb-2">
        {renderInline(line)}
      </p>
    );
  }

  // Flush any remaining items
  flushList();
  flushCode();

  return elements;
}

/**
 * Render inline formatting: **bold** and `code`.
 */
function renderInline(text) {
  if (!text) return text;

  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold: **text**
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Inline code: `text`
    const codeMatch = remaining.match(/`([^`]+)`/);

    // Find earliest match
    let earliest = null;
    let earliestIndex = remaining.length;

    if (boldMatch && boldMatch.index < earliestIndex) {
      earliest = 'bold';
      earliestIndex = boldMatch.index;
    }
    if (codeMatch && codeMatch.index < earliestIndex) {
      earliest = 'code';
      earliestIndex = codeMatch.index;
    }

    if (!earliest) {
      parts.push(remaining);
      break;
    }

    // Text before the match
    if (earliestIndex > 0) {
      parts.push(remaining.slice(0, earliestIndex));
    }

    if (earliest === 'bold') {
      parts.push(
        <strong key={key++} className="font-semibold">
          {boldMatch[1]}
        </strong>
      );
      remaining = remaining.slice(earliestIndex + boldMatch[0].length);
    } else {
      parts.push(
        <code
          key={key++}
          className="bg-gray-100 dark:bg-gray-700 text-sm px-1 py-0.5 rounded font-mono"
        >
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(earliestIndex + codeMatch[0].length);
    }
  }

  return parts.length === 1 ? parts[0] : parts;
}

function AdminChangelogPage() {
  const { t } = useTranslation();
  const [changelog, setChangelog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedVersions, setExpandedVersions] = useState({});
  const [previouslySeen] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return new Set(parsed);
        }
      } catch {
        // Corrupt data — treat as first visit
      }
    }
    return new Set();
  });

  useEffect(() => {
    const fetchChangelog = async () => {
      try {
        const response = await makeAdminApiCall('/admin/changelog', { method: 'GET' });
        const data = response.data || [];
        setChangelog(data);

        // First version expanded by default
        if (data.length > 0) {
          setExpandedVersions({ [data[0].version]: true });
        }

        // Persist all current versions as "seen" for next visit
        const allVersions = data.map(entry => entry.version);
        const merged = new Set([...previouslySeen, ...allVersions]);
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...merged]));
      } catch (err) {
        setError(err.message || t('admin.changelog.loadError', 'Failed to load changelog'));
      } finally {
        setLoading(false);
      }
    };

    fetchChangelog();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const toggleVersion = version => {
    setExpandedVersions(prev => ({
      ...prev,
      [version]: !prev[version]
    }));
  };

  const isNew = version => {
    return !previouslySeen.has(version);
  };

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6">
          {t('admin.changelog.title', "What's New")}
        </h1>
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          {t('admin.changelog.loading', 'Loading changelog...')}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6">
          {t('admin.changelog.title', "What's New")}
        </h1>
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (changelog.length === 0) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6">
          {t('admin.changelog.title', "What's New")}
        </h1>
        <p className="text-gray-500 dark:text-gray-400">
          {t('admin.changelog.empty', 'No changelog entries yet.')}
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6">
        {t('admin.changelog.title', "What's New")}
      </h1>

      <div className="space-y-3">
        {changelog.map(entry => {
          const expanded = !!expandedVersions[entry.version];
          const versionIsNew = isNew(entry.version);

          return (
            <div
              key={entry.version}
              className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
            >
              {/* Accordion heading */}
              <button
                onClick={() => toggleVersion(entry.version)}
                className="w-full flex items-center justify-between px-5 py-4 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  {expanded ? (
                    <ChevronDownIcon className="h-5 w-5 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                  ) : (
                    <ChevronRightIcon className="h-5 w-5 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                  )}
                  <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t('admin.changelog.version', 'Version {{version}}', {
                      version: entry.version
                    })}
                  </span>
                  {versionIsNew && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200">
                      {t('admin.changelog.new', 'New')}
                    </span>
                  )}
                </div>
              </button>

              {/* Accordion body */}
              {expanded && (
                <div className="px-5 py-4 bg-white dark:bg-gray-900">
                  {/* Features */}
                  {entry.features && (
                    <div className="prose dark:prose-invert max-w-none">
                      {renderMarkdown(entry.features)}
                    </div>
                  )}

                  {/* Breaking changes */}
                  {entry.breakingChanges && entry.breakingChanges.trim() && (
                    <div className="mt-4 border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4">
                      <div className="flex items-start gap-2">
                        <svg
                          className="h-5 w-5 text-amber-500 dark:text-amber-400 flex-shrink-0 mt-0.5"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                            clipRule="evenodd"
                          />
                        </svg>
                        <div>
                          <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-2">
                            {t('admin.changelog.breakingChanges', 'Breaking Changes')}
                          </h4>
                          <div className="text-sm text-amber-700 dark:text-amber-300">
                            {renderMarkdown(entry.breakingChanges)}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default AdminChangelogPage;
