import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import Fuse from 'fuse.js';
import { apiClient } from '../../../api/client';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';

/**
 * Inline suggestion dropdown for @mention workflow autocomplete.
 * No input field — focus stays in the parent textarea.
 * The parent passes a `query` string (text typed after '@') and
 * forwards keyboard events via the imperative ref.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the dropdown is visible
 * @param {string} props.query - Current search query (text after '@')
 * @param {Function} props.onClose - Close the dropdown
 * @param {Function} props.onSelect - Called with workflow id when selected
 * @param {Object} props.app - Current app configuration (to filter by app.tools)
 */
const WorkflowMentionSearch = forwardRef(({ isOpen, query, onClose, onSelect, app }, ref) => {
  const { i18n } = useTranslation();
  const [workflows, setWorkflows] = useState([]);
  const [results, setResults] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fuseRef = useRef(null);
  const listRef = useRef(null);

  // Determine which workflow IDs are available for this app
  const appWorkflowIds = (app?.tools || [])
    .filter(t => t.startsWith('workflow:'))
    .map(t => t.replace('workflow:', ''));

  const fetchAndFilter = useCallback(async () => {
    try {
      const response = await apiClient.get('/workflows');
      const allWorkflows = response.data || [];

      const available = allWorkflows
        .filter(w => appWorkflowIds.includes(w.id))
        .map(w => ({
          ...w,
          localizedName: getLocalizedContent(w.name, i18n.language),
          localizedDescription: getLocalizedContent(w.description, i18n.language)
        }));

      setWorkflows(available);
      fuseRef.current = new Fuse(available, {
        keys: ['localizedName', 'localizedDescription', 'id'],
        threshold: 0.4
      });
    } catch (err) {
      console.error('Failed to load workflows for @mention:', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language, app?.id]);

  // Fetch workflows when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0);
      fetchAndFilter();
    }
  }, [isOpen, fetchAndFilter]);

  // Filter results when query changes
  useEffect(() => {
    if (!isOpen) return;
    if (!query.trim()) {
      setResults(workflows);
      setSelectedIndex(0);
      return;
    }
    if (fuseRef.current) {
      const searchResults = fuseRef.current.search(query).map(r => r.item);
      setResults(searchResults.slice(0, 8));
      setSelectedIndex(0);
    }
  }, [query, isOpen, workflows]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current || results.length === 0) return;
    const selectedElement = listRef.current.children[selectedIndex];
    if (selectedElement) {
      selectedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedIndex, results]);

  // Expose keyboard handler via ref so parent can forward events
  useImperativeHandle(ref, () => ({
    handleKeyDown(e) {
      if (!isOpen || results.length === 0) {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
          return true;
        }
        return false;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (results[selectedIndex]) {
          e.preventDefault();
          onSelect(results[selectedIndex].id);
          return true;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return true;
      }
      return false;
    }
  }));

  if (!isOpen) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 max-w-md overflow-hidden">
        <div className="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
          {query ? `@${query}` : '@'}
        </div>
        <ul ref={listRef} className="max-h-48 overflow-y-auto">
          {results.length === 0 && (
            <li className="p-3 text-xs text-gray-500 text-center">
              {workflows.length === 0 ? 'No workflows available' : 'No results'}
            </li>
          )}
          {results.map((wf, idx) => (
            <li
              key={wf.id}
              className={`px-3 py-2 cursor-pointer text-sm border-b border-gray-100 dark:border-gray-700 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700 ${
                idx === selectedIndex ? 'bg-indigo-50 dark:bg-indigo-900/30' : ''
              }`}
              onMouseDown={e => {
                e.preventDefault(); // Prevent textarea blur
                onSelect(wf.id);
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <div className="flex items-center gap-2">
                <Icon name="cog" size="sm" className="text-indigo-500 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 dark:text-gray-100 truncate">
                    {wf.localizedName || wf.id}
                  </div>
                  {wf.localizedDescription && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {wf.localizedDescription}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
});

WorkflowMentionSearch.displayName = 'WorkflowMentionSearch';

export default WorkflowMentionSearch;
