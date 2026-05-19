import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { apiClient } from '../../api/client';
import { getLocalizedContent } from '../../utils/localizeContent';

/**
 * WorkflowsSelector - Multi-select component for choosing workflows to attach to an app.
 * Mirrors SkillsSelector/ToolsSelector but reads from the /workflows endpoint and
 * stores selections as workflow id strings in app.workflows.
 *
 * @param {Object} props
 * @param {string[]} props.selectedWorkflows - Array of selected workflow id strings
 * @param {Function} props.onWorkflowsChange - Callback receiving updated array of workflow id strings
 */
function WorkflowsSelector({ selectedWorkflows = [], onWorkflowsChange }) {
  const { t, i18n } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [availableWorkflows, setAvailableWorkflows] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  useEffect(() => {
    const loadWorkflows = async () => {
      try {
        setIsLoading(true);
        const response = await apiClient.get('/workflows');
        setAvailableWorkflows(response.data || []);
      } catch (error) {
        console.error('Failed to fetch workflows:', error);
        setAvailableWorkflows([]);
      } finally {
        setIsLoading(false);
      }
    };
    loadWorkflows();
  }, []);

  const localize = value => getLocalizedContent(value, i18n.language) || '';

  const filteredWorkflows = availableWorkflows.filter(wf => {
    const name = localize(wf.name) || wf.id;
    const description = localize(wf.description);
    const searchableText = `${wf.id} ${name} ${description}`.toLowerCase();
    const matchesSearch = searchableText.includes(searchTerm.toLowerCase());
    const notSelected = !selectedWorkflows.includes(wf.id);
    return matchesSearch && notSelected;
  });

  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
        setSearchTerm('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isDropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isDropdownOpen]);

  const handleAddWorkflow = workflow => {
    const id = typeof workflow === 'string' ? workflow : workflow.id;
    if (!selectedWorkflows.includes(id)) {
      onWorkflowsChange([...selectedWorkflows, id]);
    }
    setSearchTerm('');
    setIsDropdownOpen(false);
  };

  const handleRemoveWorkflow = idToRemove => {
    onWorkflowsChange(selectedWorkflows.filter(id => id !== idToRemove));
  };

  const handleSearchChange = e => {
    setSearchTerm(e.target.value);
    setIsDropdownOpen(true);
  };

  const handleSearchKeyDown = e => {
    if (e.key === 'Enter' && filteredWorkflows.length > 0) {
      e.preventDefault();
      handleAddWorkflow(filteredWorkflows[0]);
    } else if (e.key === 'Escape') {
      setIsDropdownOpen(false);
      setSearchTerm('');
    }
  };

  return (
    <div className="space-y-3">
      {selectedWorkflows.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedWorkflows.map(id => {
            const wf = availableWorkflows.find(w => w.id === id);
            const displayName = wf ? localize(wf.name) || wf.id : id;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300"
              >
                <Icon name="cog" className="w-3 h-3" />
                {displayName}
                <button
                  type="button"
                  onClick={() => handleRemoveWorkflow(id)}
                  className="ml-1 flex-shrink-0 text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300"
                  aria-label={`Remove ${displayName}`}
                >
                  <Icon name="x" className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="relative" ref={dropdownRef}>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Icon name="search" className="h-5 w-5 text-gray-400 dark:text-gray-500" />
          </div>
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('admin.apps.edit.searchWorkflows', 'Search workflows to add...')}
            value={searchTerm}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setIsDropdownOpen(true)}
            className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            autoComplete="off"
          />
        </div>

        {isDropdownOpen && (
          <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-60 overflow-auto">
            {isLoading ? (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {t('common.loading', 'Loading...')}
              </div>
            ) : filteredWorkflows.length > 0 ? (
              filteredWorkflows.map(wf => {
                const name = localize(wf.name) || wf.id;
                const description = localize(wf.description);
                return (
                  <button
                    type="button"
                    key={wf.id}
                    onClick={() => handleAddWorkflow(wf)}
                    className="w-full text-left px-3 py-3 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                  >
                    <div className="font-medium text-gray-900 dark:text-gray-100">{name}</div>
                    {description && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                        {description}
                      </div>
                    )}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {searchTerm
                  ? t('admin.apps.edit.workflows.noResults', 'No workflows match your search')
                  : t('admin.apps.edit.workflows.noWorkflows', 'No workflows available')}
              </div>
            )}
          </div>
        )}
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.workflowsHelper',
          'Search and select workflows to make available in this app. Users can trigger them with @workflow-id in chat.'
        )}
      </p>
    </div>
  );
}

export default WorkflowsSelector;
