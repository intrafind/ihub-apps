import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { fetchMcpToolCatalog } from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';

import { getAdminApiErrorMessage } from '../../../api/adminApi';
/**
 * Picker for the MCP servers an app uses. The app admin decides per server
 * whether the app uses it — never which of its tools: that is the server's
 * `allowedTools`, set under Integrations → MCP servers. A used server is
 * stored as its id in `app.tools` (e.g. `"drawio"`), and the runtime tool
 * loader expands it to every tool the server offers.
 *
 * Apps configured before this listed a server's tool ids one by one. Such an
 * app shows the server as used; turning the server off removes those ids, and
 * turning it on stores the server id alone.
 *
 * @param {string[]} selectedTools - The full app.tools array
 * @param {(tools:string[])=>void} onToolsChange - Receives the updated full array
 * @param {(ids:string[])=>void} [onMcpToolIdsChange] - Reports every MCP server
 *   id and tool id so the parent can exclude them from the generic tools picker
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
        const ids = data.flatMap(s => [s.id, ...(s.tools || []).map(tool => tool.name)]);
        onMcpToolIdsChange?.(ids);
      } catch (err) {
        if (active) setError(getAdminApiErrorMessage(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  // The app.tools entries that belong to a server: its id and any tool ids
  // listed one by one.
  const referencesOf = server => {
    const toolNames = new Set((server.tools || []).map(tool => tool.name));
    return selectedTools.filter(id => id === server.id || toolNames.has(id));
  };

  const toggleServer = server => {
    const refs = referencesOf(server);
    const rest = selectedTools.filter(id => !refs.includes(id));
    onToolsChange(refs.length > 0 ? rest : [...rest, server.id]);
  };

  if (loading) {
    return (
      <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
        <LoadingSpinner size="sm" />
        <span className="ml-2">
          {t('admin.apps.edit.mcpTools.loading', 'Loading MCP servers…')}
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-700 dark:text-red-400">
        {t('admin.apps.edit.mcpTools.error', 'Failed to load MCP servers: {{error}}', { error })}
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.mcpTools.empty',
          'No MCP servers are configured. Add one under Integrations → MCP servers to use it here.'
        )}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {servers.map(server => {
        const refs = referencesOf(server);
        const used = refs.length > 0;
        const legacy = used && !refs.includes(server.id);
        const serverName = getLocalizedContent(server.name, lang) || server.id;
        const description = getLocalizedContent(server.description, lang);
        const inputId = `mcp-server-${server.id}`;
        return (
          <div
            key={server.id}
            className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
          >
            <label htmlFor={inputId} className="flex items-start gap-2 cursor-pointer">
              <input
                id={inputId}
                type="checkbox"
                className="mt-0.5 rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                checked={used}
                onChange={() => toggleServer(server)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
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
                </span>
                {description && (
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                    {description}
                  </span>
                )}
                {legacy && (
                  <span className="block text-xs text-amber-700 dark:text-amber-400 mt-1">
                    {t(
                      'admin.apps.edit.mcpTools.legacySelection',
                      'This app lists some of this server’s tools one by one. Turn the server off and on again to use the tools allowed on the server.'
                    )}
                  </span>
                )}
                {server.error && (
                  <span className="flex items-center text-xs text-red-700 dark:text-red-400 mt-1">
                    <Icon name="x-circle" size="sm" className="mr-1.5 shrink-0" />
                    {t('admin.apps.edit.mcpTools.serverError', 'Could not list tools: {{error}}', {
                      error: server.error
                    })}
                  </span>
                )}
              </span>
            </label>
          </div>
        );
      })}
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.mcpTools.helper',
          'Which tools a server offers is set under Integrations → MCP servers.'
        )}
      </p>
    </div>
  );
}

export default McpToolsSelector;
