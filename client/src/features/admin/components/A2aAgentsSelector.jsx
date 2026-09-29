import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { fetchA2aSkillCatalog } from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import { a2aAgentReference } from '../../chat/utils/groupToolsByMcpServer';

/**
 * Picker for the remote A2A agents an app uses. Like an MCP server, an agent
 * is enabled as a whole: its id is stored in `app.tools` (e.g. `"langdock"`)
 * and the runtime tool loader expands it to one tool per skill the agent
 * offers (`a2a__langdock__<skill>`), limited by the agent's `allowedSkills`
 * under Integrations → A2A agents. An agent whose id is also a tool's or MCP
 * server's id is stored as `a2a__<agentId>` instead, the reference that
 * always means the agent. The bare id, `a2a__<agentId>` and single skill tools
 * listed one by one are all recognised; turning the agent off removes them.
 *
 * @param {Object} props
 * @param {string[]} props.selectedTools - The full app.tools array
 * @param {(tools:string[])=>void} props.onToolsChange - Receives the updated full array
 * @param {(ids:string[])=>void} [props.onA2aToolIdsChange] - Reports every agent id and
 *   skill tool id so the parent can exclude them from the generic tools picker
 */
function A2aAgentsSelector({ selectedTools = [], onToolsChange, onA2aToolIdsChange }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const data = await fetchA2aSkillCatalog();
        if (!active) return;
        setAgents(data);
        onA2aToolIdsChange?.(
          data.flatMap(agent => [
            agent.id,
            a2aAgentReference(agent.id),
            ...(agent.skills || []).map(skill => skill.toolId)
          ])
        );
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

  // An agent flagged `idConflict` shares its id with a tool or MCP server, so
  // that id selects the tool or server, not the agent: it is enabled by
  // `a2a__<agentId>` instead, and the bare id is never treated as its own.
  const referencesOf = agent => {
    const toolIds = new Set((agent.skills || []).map(skill => skill.toolId));
    const namespaced = a2aAgentReference(agent.id);
    return selectedTools.filter(
      id => (id === agent.id && !agent.idConflict) || id === namespaced || toolIds.has(id)
    );
  };

  const toggleAgent = agent => {
    const refs = referencesOf(agent);
    const rest = selectedTools.filter(id => !refs.includes(id));
    if (refs.length > 0) return onToolsChange(rest);
    onToolsChange([...rest, agent.idConflict ? a2aAgentReference(agent.id) : agent.id]);
  };

  if (loading) {
    return (
      <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
        <LoadingSpinner size="sm" />
        <span className="ml-2">
          {t('admin.apps.edit.a2aAgents.loading', 'Loading A2A agents…')}
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-700 dark:text-red-400">
        {t('admin.apps.edit.a2aAgents.error', 'Failed to load A2A agents: {{error}}', { error })}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.a2aAgents.empty',
          'No remote A2A agents are configured. Add one under Integrations → A2A agents to use it here.'
        )}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {agents.map(agent => {
        const used = referencesOf(agent).length > 0;
        const agentName = getLocalizedContent(agent.name, lang) || agent.id;
        const description = getLocalizedContent(agent.description, lang);
        const inputId = `a2a-agent-${agent.id}`;
        const skillNames = (agent.skills || []).map(skill => skill.name).join(', ');
        return (
          <div
            key={agent.id}
            className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
          >
            <label htmlFor={inputId} className="flex items-start gap-2 cursor-pointer">
              <input
                id={inputId}
                type="checkbox"
                className="mt-0.5 rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                checked={used}
                onChange={() => toggleAgent(agent)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
                    {agentName}
                  </span>
                  <span className="font-mono text-xs text-gray-400 dark:text-gray-500">
                    {agent.id}
                  </span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300">
                    {t('admin.apps.edit.a2aAgents.remoteBadge', 'remote agent')}
                  </span>
                  {!agent.enabled && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300">
                      {t('admin.apps.edit.a2aAgents.disabled', 'disabled')}
                    </span>
                  )}
                </span>
                {description && (
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                    {description}
                  </span>
                )}
                {skillNames && (
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t('admin.apps.edit.a2aAgents.skills', 'Skills: {{skills}}', {
                      skills: skillNames
                    })}
                  </span>
                )}
                {agent.idConflict && (
                  <span className="block text-xs text-yellow-800 dark:text-yellow-300 mt-1">
                    {t(
                      'admin.apps.edit.a2aAgents.idConflict',
                      'A tool or MCP server uses the id "{{id}}" too, so this app refers to the agent as "{{reference}}".',
                      { id: agent.id, reference: a2aAgentReference(agent.id) }
                    )}
                  </span>
                )}
                {agent.error && (
                  <span className="flex items-center text-xs text-red-700 dark:text-red-400 mt-1">
                    <Icon name="x-circle" size="sm" className="mr-1.5 shrink-0" />
                    {t(
                      'admin.apps.edit.a2aAgents.agentError',
                      'Could not read the Agent Card: {{error}}',
                      {
                        error: agent.error
                      }
                    )}
                  </span>
                )}
              </span>
            </label>
          </div>
        );
      })}
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.a2aAgents.helper',
          'Each skill of an agent becomes a tool the model can call; the agent runs on its own servers. Which skills are offered is set under Integrations → A2A agents.'
        )}
      </p>
    </div>
  );
}

export default A2aAgentsSelector;
