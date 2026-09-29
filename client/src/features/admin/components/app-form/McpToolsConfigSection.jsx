import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import McpToolsSelector from '../McpToolsSelector';
import A2aAgentsSelector from '../A2aAgentsSelector';

/**
 * App editor section for remote tool sources: MCP servers and remote A2A
 * agents. Both are enabled per app as a whole; the ids of both are reported
 * together so the generic tools picker leaves them out.
 */
function McpToolsConfigSection({ selectedTools, onToolsChange, onMcpToolIdsChange }) {
  const { t } = useTranslation();
  const idsRef = useRef({ mcp: [], a2a: [] });
  const report = (kind, list) => {
    idsRef.current = { ...idsRef.current, [kind]: list };
    onMcpToolIdsChange?.([...idsRef.current.mcp, ...idsRef.current.a2a]);
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.mcpTools.title', 'MCP servers')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.mcpTools.desc',
              'Choose the MCP servers this app uses. Users see each one as a single entry in the chat.'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2">
          <McpToolsSelector
            selectedTools={selectedTools}
            onToolsChange={onToolsChange}
            onMcpToolIdsChange={list => report('mcp', list)}
          />
        </div>
      </div>
      <div className="md:grid md:grid-cols-3 md:gap-6 mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.a2aAgents.title', 'Remote A2A agents')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.a2aAgents.desc',
              'Choose the remote agents (Agent-to-Agent protocol) this app can delegate to. Users see each agent as a single entry in the chat.'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2">
          <A2aAgentsSelector
            selectedTools={selectedTools}
            onToolsChange={onToolsChange}
            onA2aToolIdsChange={list => report('a2a', list)}
          />
        </div>
      </div>
    </div>
  );
}

export default McpToolsConfigSection;
