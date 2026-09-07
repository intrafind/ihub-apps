import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Lists the workflow variables a step can read, so an author picks a name
 * instead of guessing one. Clicking a row copies its `{{name}}` form.
 *
 * @param {object} props
 * @param {Array<{value: string, label: string}>} props.variables - Names in scope for the selected step
 */
function VariablesPanel({ variables }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(null);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const filtered = (variables || []).filter(v => {
      if (!query.trim()) return true;
      const needle = query.toLowerCase();
      return (
        v.value.toLowerCase().includes(needle) || (v.label || '').toLowerCase().includes(needle)
      );
    });
    const bucket = new Map();
    filtered.forEach(v => {
      // The label already says where a name comes from; use it as the heading
      // so the grouping needs no second source of truth.
      const key = v.label || 'available';
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(v);
    });
    return Array.from(bucket.entries());
  }, [variables, query]);

  const copy = value => {
    const snippet = `{{${value}}}`;
    try {
      navigator.clipboard?.writeText(snippet);
    } catch {
      /* clipboard unavailable — the name is still on screen to type */
    }
    setCopied(value);
    setTimeout(() => setCopied(null), 1500);
  };

  if (!variables || variables.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400 italic">
        {t(
          'workflows.editor.noVariablesYet',
          'No variables yet — earlier steps define them through their output variable.'
        )}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('workflows.editor.filterVariables', 'Filter variables…')}
        className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('workflows.editor.variablesHint', 'Click a name to copy it as a template reference.')}
      </p>
      <div className="max-h-64 overflow-y-auto space-y-2">
        {groups.map(([heading, items]) => (
          <div key={heading}>
            <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-0.5">
              {heading}
            </p>
            <ul className="space-y-0.5">
              {items.map(v => (
                <li key={v.value}>
                  <button
                    type="button"
                    onClick={() => copy(v.value)}
                    className="w-full text-left text-xs font-mono px-1.5 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{`{{${v.value}}}`}</span>
                    {copied === v.value && (
                      <span className="shrink-0 text-[10px] text-green-600 dark:text-green-400">
                        {t('workflows.editor.copied', 'copied')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {groups.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400 italic">
            {t('workflows.editor.noVariableMatches', 'No variable matches that filter.')}
          </p>
        )}
      </div>
    </div>
  );
}

export default VariablesPanel;
