import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { fetchMcpToolCatalog } from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * Dedicated picker for tools exposed by configured MCP servers. Unlike the
 * generic ToolsSelector (which lists statically configured tools), this groups
 * tools by their originating MCP server. Selected MCP tool ids are stored in
 * the same `app.tools` array — the runtime tool loader already resolves MCP
 * ids back to their server — but the UI keeps them in a separate section so
 * admins manage them per server rather than hunting through a flat list.
 *
 * @param {string[]} selectedTools - The full app.tools array
 * @param {(tools:string[])=>void} onToolsChange - Receives the updated full array
 * @param {(ids:string[])=>void} [onMcpToolIdsChange] - Reports all known MCP tool
 *   ids so the parent can exclude them from the generic tools picker
 */
function McpToolsSelector({ selectedTools = [], onToolsChange, onMcpToolIdsChange }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const data = await fetchMcpToolCatalog();
        if (!active) return;
        setServers(data);
        const ids = data.flatMap(s => (s.tools || []).map(tool => tool.name));
        onMcpToolIdsChange?.(ids);
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const toolNamesFor = server => (server.tools || []).map(tool => tool.name);

  const toggleTool = name => {
    if (selectedTools.includes(name)) {
      onToolsChange(selectedTools.filter(id => id !== name));
    } else {
      onToolsChange([...selectedTools, name]);
    }
  };

  const allSelected = server => {
    const names = toolNamesFor(server);
    return names.length > 0 && names.every(n => selectedTools.includes(n));
  };

  const toggleServer = server => {
    const names = toolNamesFor(server);
    if (allSelected(server)) {
      onToolsChange(selectedTools.filter(id => !names.includes(id)));
    } else {
      const set = new Set(selectedTools);
      names.forEach(n => set.add(n));
      onToolsChange(Array.from(set));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
        <LoadingSpinner size="sm" />
        <span className="ml-2">{t('admin.apps.edit.mcpTools.loading', 'Loading MCP tools…')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-700 dark:text-red-400">
        {t('admin.apps.edit.mcpTools.error', 'Failed to load MCP tools: {{error}}', { error })}
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.mcpTools.empty',
          'No MCP servers are configured. Add one under Integrations → MCP servers to expose its tools here.'
        )}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {servers.map(server => {
        const names = toolNamesFor(server);
        const selectedCount = names.filter(n => selectedTools.includes(n)).length;
        const serverName = getLocalizedContent(server.name, lang) || server.id;
        return (
          <div
            key={server.id}
            className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
          >
            <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
              <div className="flex items-center space-x-2 min-w-0">
                <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                  {serverName}
                </span>
                <span className="font-mono text-xs text-gray-400 dark:text-gray-500">
                  {server.id}
                </span>
                {!server.enabled && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300">
                    {t('admin.apps.edit.mcpTools.disabled', 'disabled')}
                  </span>
                )}
                {selectedCount > 0 && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300">
                    {t('admin.apps.edit.mcpTools.selectedCount', '{{count}} selected', {
                      count: selectedCount
                    })}
                  </span>
                )}
              </div>
              {names.length > 0 && (
                <button
                  type="button"
                  onClick={() => toggleServer(server)}
                  className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 whitespace-nowrap ml-2"
                >
                  {allSelected(server)
                    ? t('admin.apps.edit.mcpTools.deselectAll', 'Deselect all')
                    : t('admin.apps.edit.mcpTools.selectAll', 'Select all')}
                </button>
              )}
            </div>

            {server.error ? (
              <div className="px-3 py-2 text-sm text-red-700 dark:text-red-400 flex items-center">
                <Icon name="x-circle" size="sm" className="mr-1.5 flex-shrink-0" />
                {t('admin.apps.edit.mcpTools.serverError', 'Could not list tools: {{error}}', {
                  error: server.error
                })}
              </div>
            ) : names.length === 0 ? (
              <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {t('admin.apps.edit.mcpTools.noServerTools', 'This server exposes no tools.')}
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {server.tools.map(tool => (
                  <li key={tool.name}>
                    <label className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <input
                        type="checkbox"
                        className="mt-0.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                        checked={selectedTools.includes(tool.name)}
                        onChange={() => toggleTool(tool.name)}
                      />
                      <span className="min-w-0">
                        <span className="block font-mono text-xs text-gray-900 dark:text-gray-100">
                          {tool.name}
                        </span>
                        {tool.description && (
                          <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {tool.description}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.mcpTools.helper',
          'Tools provided by connected MCP servers. Selections are saved with the app and resolved at runtime.'
        )}
      </p>
    </div>
  );
}

export default McpToolsSelector;
